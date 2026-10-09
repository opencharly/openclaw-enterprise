// Package engine performs container, network and volume operations against
// containerd through nerdctl's packages. It knows nothing about Agents or
// revisions: it receives names, labels and specs.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	containerd "github.com/containerd/containerd/v2/client"
	"github.com/containerd/containerd/v2/pkg/cio"
	"github.com/containerd/nerdctl/v2/pkg/api/types"
	"github.com/containerd/nerdctl/v2/pkg/clientutil"
	"github.com/containerd/nerdctl/v2/pkg/cmd/container"
	"github.com/containerd/nerdctl/v2/pkg/cmd/network"
	"github.com/containerd/nerdctl/v2/pkg/cmd/volume"
	"github.com/containerd/nerdctl/v2/pkg/containerutil"
	specs "github.com/opencontainers/runtime-spec/specs-go"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-nerdctl/internal/options"
	"github.com/openclaw/openclaw-enterprise/helpers/compute-nerdctl/internal/protocol"
)

// ManagedLabelPrefix marks every resource this helper owns.
const ManagedLabelPrefix = "org.openclaw.enterprise."

// Engine is one open client session against the rootless engine.
type Engine struct {
	global types.GlobalCommandOptions
	client *containerd.Client
	ctx    context.Context
	cancel context.CancelFunc
	self   string
}

// Open resolves the engine address and connects.
//
// helper is the binary every created container records as its OCI hook. That binary must
// understand `internal oci-hook <event>`, which only the helper command does: a process that
// embeds this package without serving that mode cannot be the hook, and nerdctl registers a
// createRuntime hook for every container it creates. An empty helper falls back to this process.
func Open(ctx context.Context, ref protocol.EngineRef, helper string) (*Engine, error) {
	global := options.Engine(ref)
	if err := options.Validate(global); err != nil {
		return nil, protocol.Errorf(protocol.CodeConfiguration, "%v", err)
	}
	client, clientCtx, cancel, err := clientutil.NewClient(ctx, global.Namespace, global.Address)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "cannot reach containerd: %v", err)
	}
	self := helper
	if self == "" {
		self, err = os.Executable()
		if err != nil {
			cancel()
			return nil, protocol.Errorf(protocol.CodeConfiguration, "cannot resolve the helper path: %v", err)
		}
	}
	// The OCI hook runs with the container's own cwd, so a relative path would not resolve.
	if absolute, absErr := filepath.Abs(self); absErr == nil {
		self = absolute
	}
	return &Engine{global: global, client: client, ctx: clientCtx, cancel: cancel, self: self}, nil
}

// Close releases the client session.
func (e *Engine) Close() {
	if e.cancel != nil {
		e.cancel()
	}
}

// Self is the helper path baked into every container's OCI hook.
func (e *Engine) Self() string { return e.self }

// Global exposes the resolved global options (used for CNI paths and logging).
func (e *Engine) Global() types.GlobalCommandOptions { return e.global }

// ---------------------------------------------------------------------------
// networks

// networkRecordPath is where ownership labels for a network are kept. nerdctl's
// network labels are not recoverable through the library, so the helper keeps its
// own record. It must NOT live in the CNI netconf directory: nerdctl parses every
// file in that directory as a network configuration, and a stray JSON file there
// breaks container creation.
func (e *Engine) networkRecordPath(name string) string {
	return filepath.Join(e.global.DataRoot, "oce-ownership", "networks", e.global.Namespace, name+".json")
}

func (e *Engine) conflistPath(name string) string {
	return filepath.Join(e.global.CNINetConfPath, e.global.Namespace, "nerdctl-"+name+".conflist")
}

// EnsureNetwork creates the network when absent and verifies ownership otherwise.
func (e *Engine) EnsureNetwork(input protocol.EnsureNetworkInput) (*protocol.EnsureNetworkOutput, error) {
	record := e.networkRecordPath(input.Name)
	if _, err := os.Stat(record); err == nil {
		stored, readErr := e.readLabels(record)
		if readErr != nil {
			return nil, protocol.Errorf(protocol.CodeInternal, "cannot read network ownership: %v", readErr)
		}
		if err := compareLabels(stored, input.Labels); err != nil {
			return nil, err
		}
		return &protocol.EnsureNetworkOutput{Created: false, Labels: stored}, nil
	}
	var output bytes.Buffer
	if err := network.Create(options.Network(e.global, input.Name, input.Labels, input.Internal), &output); err != nil {
		// A concurrent create is benign when the conflist now exists.
		if _, statErr := os.Stat(e.conflistPath(input.Name)); statErr != nil {
			return nil, protocol.Errorf(protocol.CodeUnavailable, "network create failed: %v", err)
		}
	}
	if err := e.writeLabels(record, input.Labels); err != nil {
		return nil, protocol.Errorf(protocol.CodeInternal, "cannot record network ownership: %v", err)
	}
	return &protocol.EnsureNetworkOutput{Created: true, Labels: input.Labels}, nil
}

// RemoveNetwork removes an owned network; foreign or attached networks are refused.
func (e *Engine) RemoveNetwork(input protocol.RemoveNetworkInput) error {
	stored, err := e.readLabels(e.networkRecordPath(input.Name))
	if err != nil {
		return protocol.Errorf(protocol.CodeNotFound, "network %q is not owned by this installation", input.Name)
	}
	if err := compareLabels(stored, input.ExpectLabels); err != nil {
		return err
	}
	attached, listErr := e.listContainers(fmt.Sprintf("nerdctl/networks=%s", input.Name))
	if listErr == nil && len(attached) > 0 {
		return protocol.Errorf(protocol.CodeConflict, "network %q still has %d attached containers", input.Name, len(attached))
	}
	if err := network.Remove(e.ctx, e.client, types.NetworkRemoveOptions{
		Stdout:   new(bytes.Buffer),
		GOptions: e.global,
		Networks: []string{input.Name},
	}); err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "network remove failed: %v", err)
	}
	_ = os.Remove(e.networkRecordPath(input.Name))
	return nil
}

// ---------------------------------------------------------------------------
// volumes

func (e *Engine) EnsureVolume(input protocol.EnsureVolumeInput) (*protocol.EnsureVolumeOutput, error) {
	volumes, err := volume.Volumes(e.global.Namespace, e.global.DataRoot, e.global.Address, false, nil)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "cannot list volumes: %v", err)
	}
	if existing, ok := volumes[input.Name]; ok {
		stored := labelsFromPointer(existing.Labels)
		if err := compareLabels(stored, input.Labels); err != nil {
			return nil, err
		}
		return &protocol.EnsureVolumeOutput{
			Created:    false,
			Labels:     stored,
			Mountpoint: existing.Mountpoint,
		}, nil
	}
	created, err := volume.Create(input.Name, options.Volume(e.global, input.Name, input.Labels))
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "volume create failed: %v", err)
	}
	output := &protocol.EnsureVolumeOutput{Created: true, Labels: input.Labels}
	if created != nil {
		output.Mountpoint = created.Mountpoint
	}
	return output, nil
}

// RemoveVolumes removes owned volumes matching a label selector.
func (e *Engine) RemoveVolumes(input protocol.RemoveVolumesInput) (*protocol.RemoveVolumesOutput, error) {
	volumes, err := volume.Volumes(e.global.Namespace, e.global.DataRoot, e.global.Address, false, nil)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "cannot list volumes: %v", err)
	}
	names := make([]string, 0, len(volumes))
	for name, existing := range volumes {
		stored := labelsFromPointer(existing.Labels)
		if !matchesSelector(stored, input.LabelSelector) {
			continue
		}
		if err := compareLabels(stored, input.ExpectLabels); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return &protocol.RemoveVolumesOutput{Removed: []string{}}, nil
	}
	if err := volume.Remove(e.ctx, e.client, names, types.VolumeRemoveOptions{
		Stdout:   new(bytes.Buffer),
		GOptions: e.global,
		Force:    true,
	}); err != nil {
		// The engine's own failure message names no volume, and the usual cause is a container
		// still holding one — often a container this Driver does not own. Naming what remains is
		// what makes the difference between a retry loop and a diagnosis.
		remaining := []string{}
		if after, listErr := volume.Volumes(e.global.Namespace, e.global.DataRoot, e.global.Address, false, nil); listErr == nil {
			for name, existing := range after {
				if matchesSelector(labelsFromPointer(existing.Labels), input.LabelSelector) {
					remaining = append(remaining, name)
				}
			}
			sort.Strings(remaining)
		}
		return nil, protocol.Errorf(protocol.CodeUnavailable,
			"volume remove failed: %v; still present: %s", err, strings.Join(remaining, ", "))
	}
	return &protocol.RemoveVolumesOutput{Removed: names}, nil
}

// ---------------------------------------------------------------------------
// containers

// listItems returns nerdctl's own list entries. Its entry type carries the labels
// map directly and excludes it from JSON, so the helper must not round-trip the
// list through JSON: doing so silently loses labels, names and state.
func (e *Engine) listItems() ([]container.ListItem, error) {
	items, err := container.List(e.ctx, e.client, types.ContainerListOptions{
		GOptions: e.global,
		All:      true,
	})
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "container list failed: %v", err)
	}
	if os.Getenv("OCE_HELPER_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "debug: list returned %d items\n", len(items))
		for index, item := range items {
			if index > 2 {
				break
			}
			fmt.Fprintf(os.Stderr, "debug: [%d] names=%q labels=%q labelsMap=%d id=%q\n",
				index, item.Names, item.Labels, len(item.LabelsMap), item.ID)
		}
	}
	return items, nil
}

// InspectContainer reports the observable state of one container.
func (e *Engine) InspectContainer(name string, envKeys []string) (*protocol.ContainerState, error) {
	items, err := e.listItems()
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if !hasName(item, name) {
			continue
		}
		labels := itemLabels(item)
		state := &protocol.ContainerState{
			Exists: true,
			Labels: labels,
			Image:  item.Image,
			// nerdctl's list entry carries the container ID, not the image digest; the
			// digest is recorded in its own label.
			ImageID:     labels["nerdctl/image-digest"],
			ContainerID: item.ID,
			Ports:       ports(item),
			Health:      item.Status,
		}
		target, loadErr := e.client.LoadContainer(e.ctx, item.ID)
		if loadErr == nil {
			state.User = userFromSpec(e.ctx, target)
			if task, taskErr := target.Task(e.ctx, nil); taskErr == nil {
				if status, statusErr := task.Status(e.ctx); statusErr == nil {
					state.Running = status.Status == containerd.Running
					state.ExitCode = int(status.ExitStatus)
				}
			}
			if len(envKeys) > 0 {
				state.Env = envFromSpec(e.ctx, target, envKeys)
			}
		}
		return state, nil
	}
	return &protocol.ContainerState{Exists: false}, nil
}

// RunContainer creates, seeds, starts and probes one container.
func (e *Engine) RunContainer(spec protocol.RunContainerInput) (*protocol.ContainerState, error) {
	name := spec.Name
	if state, err := e.InspectContainer(name, nil); err == nil && state.Exists {
		if err := compareLabels(state.Labels, spec.Labels); err != nil {
			return nil, err
		}
		if state.Running {
			return state, nil
		}
		if err := e.RemoveContainer(protocol.RemoveContainerInput{Name: name, ExpectLabels: spec.Labels}); err != nil {
			return nil, err
		}
	}

	netManager, err := containerutil.NewNetworkingOptionsManager(
		e.global, options.NetworkOptions(spec), e.client)
	if err != nil {
		return nil, protocol.Errorf(protocol.CodeConfiguration, "network options failed: %v", err)
	}
	createOptions := options.Container(e.global, e.self, spec)
	args := append([]string{spec.Image}, spec.Args...)
	created, cleanup, err := container.Create(e.ctx, e.client, args, netManager, createOptions)
	if err != nil {
		if cleanup != nil {
			defer cleanup()
		}
		// A stale reservation is reported as a plain create failure, but the owning
		// container ID inside it is the only way to release the name.
		if reserved := reservedIDFromError(err); reserved != "" {
			return nil, protocol.Errorf(protocol.CodeConflict,
				"the name %q is already used by container %s; release the reservation, then retry", name, reserved)
		}
		return nil, protocol.Errorf(protocol.CodeUnavailable, "container create failed: %v", err)
	}
	failed := true
	defer func() {
		if failed {
			_ = e.RemoveContainer(protocol.RemoveContainerInput{Name: name, ExpectLabels: spec.Labels})
		}
	}()

	if !spec.FilesAfterStart {
		for _, file := range spec.Files {
			if err := e.copyFiles(name, file); err != nil {
				return nil, err
			}
		}
	}
	if spec.CreateOnly {
		// The container exists, seeded but not started. The caller stages whatever the process
		// needs through its mounts and starts it with a separate start-container operation.
		state, err := e.InspectContainer(name, nil)
		if err != nil {
			return nil, err
		}
		failed = false
		return state, nil
	}
	if err := container.Start(e.ctx, e.client, []string{name},
		options.Start(e.global, e.self, e.global.Address)); err != nil {
		return nil, protocol.Errorf(protocol.CodeUnavailable, "container start failed: %v", err)
	}
	if spec.FilesAfterStart {
		// The workload waits for these files; a failure here leaves it to time out rather
		// than run with a missing payload, so the error is reported and the container is
		// removed by the caller's failure path.
		for _, file := range spec.Files {
			if err := e.copyFiles(name, file); err != nil {
				return nil, err
			}
		}
	}
	state, err := e.InspectContainer(name, nil)
	if err != nil {
		return nil, err
	}
	if spec.Readiness != nil {
		if err := e.probe(created, *spec.Readiness); err != nil {
			return nil, err
		}
		state.Health = "ready"
	}
	if spec.WaitForExit {
		if err := e.waitForExit(created, orDefault(spec.ExitDeadlineMs, 120000)); err != nil {
			return nil, err
		}
		state, err = e.InspectContainer(name, nil)
		if err != nil {
			return nil, err
		}
	}
	failed = false
	return state, nil
}

// StopContainer stops one container after verifying ownership.
func (e *Engine) StopContainer(input protocol.StopContainerInput) error {
	if err := e.requireOwned(input.Name, input.ExpectLabels); err != nil {
		return err
	}
	timeout := input.TimeoutMs
	if timeout <= 0 {
		timeout = options.StopTimeout * 1000
	}
	if err := container.Stop(e.ctx, e.client, []string{input.Name}, types.ContainerStopOptions{
		Stdout:   new(bytes.Buffer),
		GOptions: e.global,
		Timeout:  &[]time.Duration{time.Duration(timeout) * time.Millisecond}[0],
		Signal:   options.StopSignal,
	}); err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "container stop failed: %v", err)
	}
	return nil
}

// StartContainer starts one stopped container after verifying ownership. A container
// that is already running is left alone, so the operation is idempotent.
func (e *Engine) StartContainer(input protocol.StartContainerInput) error {
	state, err := e.InspectContainer(input.Name, nil)
	if err != nil {
		return err
	}
	if !state.Exists {
		return protocol.Errorf(protocol.CodeNotFound, "container %q does not exist", input.Name)
	}
	if err := compareLabels(state.Labels, input.ExpectLabels); err != nil {
		return err
	}
	if state.Running {
		return nil
	}
	if err := container.Start(e.ctx, e.client, []string{input.Name},
		options.Start(e.global, e.self, e.global.Address)); err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "container start failed: %v", err)
	}
	return nil
}

// RemoveContainer removes one container after verifying ownership.
func (e *Engine) RemoveContainer(input protocol.RemoveContainerInput) error {
	state, err := e.InspectContainer(input.Name, nil)
	if err != nil {
		return err
	}
	if !state.Exists {
		return nil
	}
	if err := compareLabels(state.Labels, input.ExpectLabels); err != nil {
		return err
	}
	if err := container.Remove(e.ctx, e.client, []string{input.Name}, types.ContainerRemoveOptions{
		Stdout:   new(bytes.Buffer),
		GOptions: e.global,
		Force:    true,
	}); err != nil {
		return protocol.Errorf(protocol.CodeUnavailable, "container remove failed: %v", err)
	}
	return nil
}

// ListContainers lists containers matching a label selector together with the labels
// that proved the match. A caller that only receives names cannot tell which sandbox a
// container belongs to, because nerdctl's name store has no reverse lookup.
func (e *Engine) ListContainers(selector string) (*protocol.ListContainersOutput, error) {
	items, err := e.listItems()
	if err != nil {
		return nil, err
	}
	output := &protocol.ListContainersOutput{Names: []string{}, Labels: map[string]protocol.LabelSet{}}
	for _, item := range items {
		labels := itemLabels(item)
		if selector != "" && !matchesSelector(labels, selector) {
			continue
		}
		for _, name := range splitNames(item.Names) {
			output.Names = append(output.Names, name)
			output.Labels[name] = labels
		}
	}
	sort.Strings(output.Names)
	return output, nil
}

func (e *Engine) listContainers(selector string) ([]string, error) {
	listed, err := e.ListContainers(selector)
	if err != nil {
		return nil, err
	}
	return listed.Names, nil
}

// ReadLogs returns bounded log lines for one container.
func (e *Engine) ReadLogs(input protocol.ReadLogsInput) (*protocol.ReadLogsOutput, error) {
	if err := e.requireOwned(input.Name, input.ExpectLabels); err != nil {
		return nil, err
	}
	state, err := e.InspectContainer(input.Name, nil)
	if err != nil {
		return nil, err
	}
	if !state.Exists {
		return nil, protocol.Errorf(protocol.CodeNotFound, "container %q does not exist", input.Name)
	}
	path := e.logFilePath(input.Name, state.ContainerID)
	content, err := os.ReadFile(path)
	if err != nil {
		// Silence here once cost an afternoon: the caller saw an empty log and no reason for it.
		return nil, protocol.Errorf(protocol.CodeNotFound, "no container log at %q: %v", path, err)
	}
	limit := input.LimitBytes
	if limit <= 0 {
		limit = 64 * 1024
	}
	truncated := false
	if int64(len(content)) > limit {
		content = content[int64(len(content))-limit:]
		truncated = true
	}
	lines := []string{}
	for _, line := range strings.Split(strings.TrimRight(string(content), "\n"), "\n") {
		if line == "" {
			continue
		}
		lines = append(lines, decodeLogLine(line))
	}
	if input.Lines > 0 && len(lines) > input.Lines {
		lines = lines[len(lines)-input.Lines:]
		truncated = true
	}
	return &protocol.ReadLogsOutput{Lines: lines, Truncated: truncated}, nil
}

// logFilePath is where this engine keeps one container's output. nerdctl stores it under the
// datastore as containers/<namespace>/<container id>/<container id>-json.log, and the log driver
// records that same store in the container's log-config.json. The driver's own labels carry the
// container id, so the path is derived rather than guessed.
func (e *Engine) logFilePath(name, containerID string) string {
	// The data store is resolved the same way the engine resolves it for its own name store: the
	// configured root is the parent of the rootless run's directory, not the directory itself.
	dataStore := e.global.DataRoot
	if resolved, err := clientutil.DataStore(e.global.DataRoot, e.global.Address); err == nil {
		dataStore = resolved
	}
	directory := filepath.Join(dataStore, "containers", e.global.Namespace, containerID)
	canonical := filepath.Join(directory, containerID+"-json.log")
	if _, err := os.Stat(canonical); err == nil {
		return canonical
	}
	if matches, err := filepath.Glob(filepath.Join(directory, "*-json.log")); err == nil && len(matches) > 0 {
		return matches[0]
	}
	if matches, err := filepath.Glob(filepath.Join(e.global.DataRoot, "containers", "*", containerID, "*-json.log")); err == nil && len(matches) > 0 {
		return matches[0]
	}
	return canonical
}

// decodeLogLine returns the message a container actually wrote. This engine records output in the
// json-file envelope, one JSON object per line, so the envelope is unwrapped here: a caller wants
// the workload's words, not the driver's framing. A line that is not an envelope passes through.
func decodeLogLine(line string) string {
	var entry struct {
		Log    string `json:"log"`
		Stream string `json:"stream"`
	}
	if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Log == "" {
		return line
	}
	return strings.TrimRight(entry.Log, "\n")
}

// ---------------------------------------------------------------------------
// readiness

func (e *Engine) probe(target containerd.Container, readiness protocol.ReadinessSpec) error {
	deadline := time.Now().Add(time.Duration(orDefault(readiness.DeadlineMs, 120000)) * time.Millisecond)
	interval := time.Duration(orDefault(readiness.IntervalMs, 2000)) * time.Millisecond
	var last string
	for {
		if err := e.execProbe(target, readiness.Command, time.Duration(orDefault(readiness.TimeoutMs, 2000))*time.Millisecond); err == nil {
			return nil
		} else {
			last = err.Error()
		}
		if time.Now().After(deadline) {
			return protocol.Errorf(protocol.CodeTimeout, "container did not become ready: %s", last)
		}
		select {
		case <-e.ctx.Done():
			return protocol.Errorf(protocol.CodeTimeout, "readiness cancelled")
		case <-time.After(interval):
		}
	}
}

// waitForExit blocks until the container process has exited, so a run-to-completion
// workload can report the exit code it actually produced.
func (e *Engine) waitForExit(target containerd.Container, deadlineMs int) error {
	deadline := time.Now().Add(time.Duration(deadlineMs) * time.Millisecond)
	for {
		task, err := target.Task(e.ctx, nil)
		if err == nil {
			if status, statusErr := task.Status(e.ctx); statusErr == nil && status.Status != containerd.Running {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return protocol.Errorf(protocol.CodeTimeout, "container did not exit before its deadline")
		}
		select {
		case <-e.ctx.Done():
			return protocol.Errorf(protocol.CodeTimeout, "waiting for exit was cancelled")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (e *Engine) execProbe(target containerd.Container, command []string, timeout time.Duration) error {
	task, err := target.Task(e.ctx, nil)
	if err != nil {
		return fmt.Errorf("task unavailable: %w", err)
	}
	execID := "oce-probe-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	process, err := task.Exec(e.ctx, execID, &specs.Process{
		Args: command,
		Cwd:  "/",
		Env:  []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
	}, cio.NewCreator(cio.WithStreams(nil, io.Discard, io.Discard)))
	if err != nil {
		return fmt.Errorf("probe exec failed: %w", err)
	}
	defer func() { _, _ = process.Delete(e.ctx) }()
	statusC, err := process.Wait(e.ctx)
	if err != nil {
		return fmt.Errorf("probe wait failed: %w", err)
	}
	if err := process.Start(e.ctx); err != nil {
		return fmt.Errorf("probe start failed: %w", err)
	}
	select {
	case status := <-statusC:
		if status.ExitCode() != 0 {
			return fmt.Errorf("probe exit %d", status.ExitCode())
		}
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("probe timed out")
	case <-e.ctx.Done():
		return fmt.Errorf("probe cancelled")
	}
}

// ---------------------------------------------------------------------------
// helpers

func (e *Engine) requireOwned(name string, expect protocol.LabelSet) error {
	state, err := e.InspectContainer(name, nil)
	if err != nil {
		return err
	}
	if !state.Exists {
		return protocol.Errorf(protocol.CodeNotFound, "container %q does not exist", name)
	}
	return compareLabels(state.Labels, expect)
}

func compareLabels(stored, expect protocol.LabelSet) error {
	if len(expect) == 0 {
		return protocol.Errorf(protocol.CodeOwnership, "refusing to touch a resource without expected labels")
	}
	for key, value := range expect {
		if stored[key] != value {
			return protocol.Errorf(protocol.CodeOwnership,
				"ownership mismatch on %q: expected %q, found %q", key, value, stored[key])
		}
	}
	return nil
}

func matchesSelector(labels protocol.LabelSet, selector string) bool {
	if selector == "" {
		return true
	}
	for _, term := range strings.Split(selector, ",") {
		key, value, found := strings.Cut(term, "=")
		if !found {
			if _, ok := labels[key]; !ok {
				return false
			}
			continue
		}
		if labels[key] != value {
			return false
		}
	}
	return true
}

func (e *Engine) readLabels(path string) (protocol.LabelSet, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	labels := protocol.LabelSet{}
	if err := json.Unmarshal(content, &labels); err != nil {
		return nil, err
	}
	return labels, nil
}

func (e *Engine) writeLabels(path string, labels protocol.LabelSet) error {
	content, err := json.Marshal(labels)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, content, 0o600)
}

func labelsFromPointer(labels *map[string]string) protocol.LabelSet {
	result := protocol.LabelSet{}
	if labels == nil {
		return result
	}
	for key, value := range *labels {
		result[key] = value
	}
	return result
}

func labelsFromPairs(pairs []string) protocol.LabelSet {
	labels := protocol.LabelSet{}
	for _, pair := range pairs {
		key, value, found := strings.Cut(pair, "=")
		if found {
			labels[key] = value
		}
	}
	return labels
}

// reservedIDPattern matches the message nerdctl returns when a name is reserved.
var reservedIDPattern = regexp.MustCompile(`already used by ID "([0-9a-f]{8,})"`)

// reservedIDFromError extracts the owning container ID from a name-store failure.
// The name store has no lookup, so this is the only discovery path.
func reservedIDFromError(err error) string {
	if err == nil {
		return ""
	}
	match := reservedIDPattern.FindStringSubmatch(err.Error())
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

// itemLabels prefers the structured map and falls back to the rendered string.
func itemLabels(item container.ListItem) protocol.LabelSet {
	if len(item.LabelsMap) > 0 {
		labels := protocol.LabelSet{}
		for key, value := range item.LabelsMap {
			labels[key] = value
		}
		return labels
	}
	labels := protocol.LabelSet{}
	for _, pair := range strings.Split(item.Labels, ",") {
		key, value, found := strings.Cut(strings.TrimSpace(pair), "=")
		if found && key != "" {
			labels[key] = value
		}
	}
	return labels
}

// splitNames handles the comma-joined name column.
func splitNames(names string) []string {
	result := []string{}
	for _, name := range strings.Split(names, ",") {
		trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "/"))
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func hasName(item container.ListItem, name string) bool {
	for _, candidate := range splitNames(item.Names) {
		if candidate == name {
			return true
		}
	}
	return false
}

func ports(item container.ListItem) map[string]string {
	if item.Ports == "" {
		return nil
	}
	return map[string]string{"published": item.Ports}
}

func orDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
