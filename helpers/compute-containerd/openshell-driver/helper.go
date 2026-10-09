// Engine operations for this driver run in the compute-containerd helper process, not in the driver
// itself. That is not a style choice:
//
//   - containerd records the executable of the process that creates a container as that
//     container's log plugin (nerdctl's json-file log URI is "binary://<creating executable>
//     ?_NERDCTL_INTERNAL_LOGGING=<datastore>") and as its OCI hook. Only the helper serves those
//     modes; a driver that creates the container makes every sandbox's logging and OCI hook point
//     at a program that cannot run them, and the container dies with exit status 1 and no output.
//   - the engine has to run inside RootlessKit's namespaces. From outside them, containerd cannot
//     reach its own data store view and container rootfs overlay mounts fail with EACCES.
//
// The helper already solves both, and the protocol package defines the wire format: one JSON
// request on standard input, exactly one JSON response line on standard output.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"time"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// helperClient executes engine operations in one helper process per operation.
type helperClient struct {
	path      string
	namespace string
	address   string
	dataRoot  string
}

// call runs one operation and decodes its output into output, which may be nil.
//
// timeoutMs bounds the helper process; zero leaves it to the helper's own deadline. A helper
// failure is returned as the helper's own typed failure, so callers can keep distinguishing an
// absent resource from an unreachable engine.
func (c *helperClient) call(operation string, timeoutMs int, input any, output any) error {
	request := protocol.Request{
		Version:    protocol.Version,
		Operation:  operation,
		DeadlineMs: timeoutMs,
		Engine: protocol.EngineRef{
			Namespace:     c.namespace,
			Address:       c.address,
			DataRoot:      c.dataRoot,
			NamespaceName: c.namespace,
		},
	}
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return protocol.Errorf(protocol.CodeInternal, "cannot encode the %s request: %v", operation, err)
		}
		request.Input = encoded
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return protocol.Errorf(protocol.CodeInternal, "cannot encode the %s request: %v", operation, err)
	}

	ctx := context.Background()
	if timeoutMs > 0 {
		var cancel context.CancelFunc
		// The helper's own deadline is authoritative; this is a backstop against a helper that
		// never returns at all.
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond+30*time.Second)
		defer cancel()
	}
	command := exec.CommandContext(ctx, c.path)
	command.Stdin = bytes.NewReader(encoded)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return protocol.Errorf(protocol.CodeTimeout, "the engine helper did not finish %s in time", operation)
		}
		return protocol.Errorf(protocol.CodeUnavailable, "the engine helper failed to run %s: %v: %s",
			operation, err, protocol.Bound(stderr.String()))
	}

	response := protocol.Response{}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &response); err != nil {
		return protocol.Errorf(protocol.CodeInternal,
			"the engine helper returned an unreadable response to %s: %v", operation, err)
	}
	if !response.Ok {
		if response.Error != nil {
			return &protocol.Failure{
				Code:      response.Error.Code,
				Message:   response.Error.Message,
				Retryable: response.Error.Retryable,
			}
		}
		return protocol.Errorf(protocol.CodeInternal, "the engine helper failed %s without a reason", operation)
	}
	if output == nil || len(response.Output) == 0 {
		return nil
	}
	if err := json.Unmarshal(response.Output, output); err != nil {
		return protocol.Errorf(protocol.CodeInternal,
			"the engine helper returned an unreadable %s result: %v", operation, err)
	}
	return nil
}

// engineTimeout bounds the operations that only touch engine metadata.
const engineTimeout = 120000

func (c *helperClient) EnsureVolume(input protocol.EnsureVolumeInput) (*protocol.EnsureVolumeOutput, error) {
	output := &protocol.EnsureVolumeOutput{}
	if err := c.call("ensure-volume", engineTimeout, input, output); err != nil {
		return nil, err
	}
	return output, nil
}

func (c *helperClient) RemoveVolumes(input protocol.RemoveVolumesInput) (*protocol.RemoveVolumesOutput, error) {
	output := &protocol.RemoveVolumesOutput{}
	if err := c.call("remove-volumes", engineTimeout, input, output); err != nil {
		return nil, err
	}
	return output, nil
}

func (c *helperClient) ListContainers(selector string) (*protocol.ListContainersOutput, error) {
	output := &protocol.ListContainersOutput{}
	if err := c.call("list-containers", engineTimeout, protocol.ListContainersInput{
		LabelSelector: selector,
	}, output); err != nil {
		return nil, err
	}
	return output, nil
}

func (c *helperClient) InspectContainer(name string, envKeys []string) (*protocol.ContainerState, error) {
	output := &protocol.ContainerState{}
	if err := c.call("inspect-container", engineTimeout, protocol.InspectContainerInput{
		Name:    name,
		EnvKeys: envKeys,
	}, output); err != nil {
		return nil, err
	}
	return output, nil
}

// RunContainer creates, starts and inspects one container. It carries no timeout: an image pull
// may legitimately outlast any fixed bound, and the gateway owns the caller's deadline.
func (c *helperClient) RunContainer(input protocol.RunContainerInput) (*protocol.ContainerState, error) {
	output := &protocol.ContainerState{}
	if err := c.call("run-container", 0, input, output); err != nil {
		return nil, err
	}
	return output, nil
}

func (c *helperClient) StartContainer(input protocol.StartContainerInput) error {
	return c.call("start-container", engineTimeout, input, nil)
}

func (c *helperClient) StopContainer(input protocol.StopContainerInput) error {
	return c.call("stop-container", engineTimeout, input, nil)
}

func (c *helperClient) RemoveContainer(input protocol.RemoveContainerInput) error {
	return c.call("remove-container", engineTimeout, input, nil)
}

func (c *helperClient) ReadLogs(input protocol.ReadLogsInput) (*protocol.ReadLogsOutput, error) {
	output := &protocol.ReadLogsOutput{}
	if err := c.call("read-logs", engineTimeout, input, output); err != nil {
		return nil, err
	}
	return output, nil
}
