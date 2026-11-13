// Package protocol defines the helper's wire format: one JSON request on standard
// input, exactly one JSON response line on standard output.
package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"unicode/utf8"
)

// Version is the envelope version the driver and helper agree on.
const Version = 1

// Error codes. The driver maps these to its own failure shapes.
const (
	CodeOwnership     = "OWNERSHIP"
	CodeConfiguration = "CONFIGURATION"
	CodeNotFound      = "NOT_FOUND"
	CodeConflict      = "CONFLICT"
	CodeUnavailable   = "UNAVAILABLE"
	CodeTimeout       = "TIMEOUT"
	CodeInternal      = "INTERNAL"
)

// maxMessage bounds every message the driver may surface.
const maxMessage = 256

// EngineRef identifies the engine a request targets.
type EngineRef struct {
	Namespace     string `json:"namespace"`
	Address       string `json:"address"`
	DataRoot      string `json:"dataRoot"`
	NamespaceName string `json:"namespaceName"`
}

// Request is the envelope read from standard input.
type Request struct {
	Version    int             `json:"version"`
	Operation  string          `json:"operation"`
	Engine     EngineRef       `json:"engine"`
	DeadlineMs int             `json:"deadlineMs,omitempty"`
	Input      json.RawMessage `json:"input,omitempty"`
}

// ErrorDetail is the failure shape. Messages never carry environment values, file
// contents or provider output.
type ErrorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Response is the envelope written to standard output.
type Response struct {
	Ok     bool            `json:"ok"`
	Output json.RawMessage `json:"output,omitempty"`
	Error  *ErrorDetail    `json:"error,omitempty"`
}

// Failure is a typed helper error.
type Failure struct {
	Code      string
	Message   string
	Retryable bool
}

func (f *Failure) Error() string { return f.Code + ": " + f.Message }

// Errorf builds a Failure with a bounded message.
func Errorf(code string, format string, args ...any) *Failure {
	return &Failure{Code: code, Message: Bound(fmt.Sprintf(format, args...))}
}

// Bound truncates a message to the wire limit on a rune boundary.
func Bound(message string) string {
	if len(message) <= maxMessage {
		return message
	}
	truncated := message[:maxMessage]
	for !utf8.ValidString(truncated) && len(truncated) > 0 {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}

// Encode renders the success envelope.
func Encode(output any) ([]byte, error) {
	encoded, err := json.Marshal(output)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Response{Ok: true, Output: encoded})
}

// EncodeFailure renders the failure envelope with a bounded message.
func EncodeFailure(failure *Failure) []byte {
	failure.Message = Bound(failure.Message)
	encoded, err := json.Marshal(Response{Ok: false, Error: &ErrorDetail{
		Code:      failure.Code,
		Message:   failure.Message,
		Retryable: failure.Retryable,
	}})
	if err != nil {
		return []byte(`{"ok":false,"error":{"code":"INTERNAL","message":"encoding failed","retryable":false}}`)
	}
	return encoded
}

// Write emits the success envelope. Exit status stays 0 whenever a valid
// response was produced; the driver decides what a failure means.
func Write(output any) {
	encoded, err := Encode(output)
	if err != nil {
		WriteFailure(&Failure{Code: CodeInternal, Message: "response encoding failed"})
		return
	}
	fmt.Fprintln(os.Stdout, string(encoded))
}

// WriteFailure emits the failure envelope.
func WriteFailure(failure *Failure) {
	fmt.Fprintln(os.Stdout, string(EncodeFailure(failure)))
}

// LabelSet is the ownership label set carried by every owned resource.
type LabelSet map[string]string

// EnsureNetworkInput is the input of ensure-network.
type EnsureNetworkInput struct {
	Name     string   `json:"name"`
	Labels   LabelSet `json:"labels"`
	Internal bool     `json:"internal,omitempty"`
}

// EnsureNetworkOutput reports whether the network had to be created.
type EnsureNetworkOutput struct {
	Created bool     `json:"created"`
	Labels  LabelSet `json:"labels"`
}

// RemoveNetworkInput is the input of remove-network.
type RemoveNetworkInput struct {
	Name         string   `json:"name"`
	ExpectLabels LabelSet `json:"expectLabels"`
}

// EnsureVolumeInput is the input of ensure-volume.
type EnsureVolumeInput struct {
	Name   string   `json:"name"`
	Labels LabelSet `json:"labels"`
}

// EnsureVolumeOutput reports whether the volume had to be created.
type EnsureVolumeOutput struct {
	Created bool     `json:"created"`
	Labels  LabelSet `json:"labels"`
	// Mountpoint is the host directory backing the volume. The engine refuses to copy
	// files into a container it has not started, so a caller that needs a payload on a
	// volume before the container starts writes it here and mounts the volume read-write.
	Mountpoint string `json:"mountpoint,omitempty"`
}

// RemoveVolumesInput is the input of remove-volumes.
type RemoveVolumesInput struct {
	LabelSelector string   `json:"labelSelector"`
	ExpectLabels  LabelSet `json:"expectLabels"`
}

// RemoveVolumesOutput lists the removed volumes.
type RemoveVolumesOutput struct {
	Removed []string `json:"removed"`
}

// InspectContainerInput is the input of inspect-container.
type InspectContainerInput struct {
	Name    string   `json:"name"`
	EnvKeys []string `json:"envKeys,omitempty"`
}

// ContainerState is the observable state of one container.
type ContainerState struct {
	Exists bool     `json:"exists"`
	Labels LabelSet `json:"labels,omitempty"`
	Image  string   `json:"image,omitempty"`
	// ImageID is the immutable image digest, read from nerdctl's own label.
	ImageID string `json:"imageId,omitempty"`
	// ContainerID is the container's identifier, which is not the image digest.
	ContainerID string `json:"containerId,omitempty"`
	Running     bool   `json:"running"`
	ExitCode    int    `json:"exitCode,omitempty"`
	// User is the OCI process identity the container was created with, as "uid:gid". A driver
	// that must declare the workload identity before the process starts reads it here.
	User    string            `json:"user,omitempty"`
	Health  string            `json:"health,omitempty"`
	Ports   map[string]string `json:"ports,omitempty"`
	Address string            `json:"address,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// StartContainerInput is the input of start-container. Ownership labels are required:
// the engine never starts a container it cannot prove it owns.
type StartContainerInput struct {
	Name         string   `json:"name"`
	ExpectLabels LabelSet `json:"expectLabels"`
}

// StopContainerInput is the input of stop-container.
type StopContainerInput struct {
	Name         string   `json:"name"`
	ExpectLabels LabelSet `json:"expectLabels"`
	TimeoutMs    int      `json:"timeoutMs,omitempty"`
}

// RemoveContainerInput is the input of remove-container.
type RemoveContainerInput struct {
	Name         string   `json:"name"`
	ExpectLabels LabelSet `json:"expectLabels"`
}

// ReleaseNameInput is the input of release-name. The owning container ID is
// required: nerdctl's name store exposes no lookup, so the identifier has to come
// from the create failure that reported it.
type ReleaseNameInput struct {
	Name string `json:"name"`
	ID   string `json:"id,omitempty"`
}

// ListContainersInput is the input of list-containers.
type ListContainersInput struct {
	LabelSelector string `json:"labelSelector"`
}

// ListContainersOutput lists matching containers.
type ListContainersOutput struct {
	Names  []string            `json:"names"`
	Labels map[string]LabelSet `json:"labels,omitempty"`
}

// ReadLogsInput is the input of read-logs.
type ReadLogsInput struct {
	Name         string   `json:"name"`
	ExpectLabels LabelSet `json:"expectLabels"`
	Lines        int      `json:"lines"`
	SinceTime    string   `json:"sinceTime,omitempty"`
	LimitBytes   int64    `json:"limitBytes"`
}

// ReadLogsOutput carries bounded log lines.
type ReadLogsOutput struct {
	Lines     []string `json:"lines"`
	Truncated bool     `json:"truncated"`
}

// FileSpec delivers one tar archive into a directory of the container.
type FileSpec struct {
	Directory string `json:"directory"`
	TarBase64 string `json:"tarBase64"`
}

// PortPublish requests a host port; Port 0 asks the engine to choose one.
type PortPublish struct {
	HostIP        string `json:"hostIp"`
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol,omitempty"`
}

// MountSpec mounts a named volume or a driver-owned host directory. A rootless engine
// cannot copy files into a stopped container, so a payload the container needs at start is
// mounted rather than copied.
type MountSpec struct {
	Volume   string `json:"volume,omitempty"`
	Source   string `json:"source,omitempty"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// TmpfsSpec mounts a tmpfs.
type TmpfsSpec struct {
	Target    string `json:"target"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
	Mode      string `json:"mode,omitempty"`
	// Uid/Gid own the mount inside the container. A hardened container runs with a read-only
	// root and drops every capability, so a mount the workload must write has to be handed to
	// the workload's user explicitly.
	Uid int `json:"uid,omitempty"`
	Gid int `json:"gid,omitempty"`
}

// ReadinessSpec describes the driver-run readiness probe.
type ReadinessSpec struct {
	Command    []string `json:"command"`
	IntervalMs int      `json:"intervalMs,omitempty"`
	TimeoutMs  int      `json:"timeoutMs,omitempty"`
	DeadlineMs int      `json:"deadlineMs,omitempty"`
}

// LimitsSpec bounds one container's resources.
type LimitsSpec struct {
	MemoryBytes int64   `json:"memoryBytes,omitempty"`
	CPUs        float64 `json:"cpus,omitempty"`
}

// RunContainerInput is the input of run-container and run-to-completion.
type RunContainerInput struct {
	Name    string `json:"name"`
	Image   string `json:"image"`
	Network string `json:"network"`
	// Networks places one container on several planes. An egress proxy stands on the Agent's
	// no-egress plane and on the plane that reaches outside, which is what makes it the only
	// route out.
	Networks       []string          `json:"networks,omitempty"`
	Labels         LabelSet          `json:"labels"`
	User           string            `json:"user,omitempty"`
	Entrypoint     []string          `json:"entrypoint,omitempty"`
	Args           []string          `json:"args,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	ReadOnlyRootfs bool              `json:"readOnlyRootfs,omitempty"`
	CapDrop        []string          `json:"capDrop,omitempty"`
	CapAdd         []string          `json:"capAdd,omitempty"`
	NoNewPrivs     bool              `json:"noNewPrivileges,omitempty"`
	Tmpfs          []TmpfsSpec       `json:"tmpfs,omitempty"`
	Mounts         []MountSpec       `json:"mounts,omitempty"`
	Publish        []PortPublish     `json:"publish,omitempty"`
	Files          []FileSpec        `json:"files,omitempty"`
	// FilesAfterStart delivers the files once the container is running. A rootless engine
	// cannot copy into a stopped container, so a workload that needs files must wait for
	// them after it starts.
	FilesAfterStart bool           `json:"filesAfterStart,omitempty"`
	Readiness       *ReadinessSpec `json:"readiness,omitempty"`
	Limits          *LimitsSpec    `json:"limits,omitempty"`
	// CreateOnly stops after the container exists and has been seeded, without starting it.
	// A driver that has to write material into a mount and then start the process needs the
	// container to exist first; rootless nerdctl cannot copy into a stopped container, so the
	// material has to reach the container through a mount that exists at create time.
	CreateOnly bool `json:"createOnly,omitempty"`
	// WaitForExit makes the call return only once the container has exited, so a
	// run-to-completion workload reports its real exit code.
	WaitForExit bool `json:"waitForExit,omitempty"`
	// ExitDeadlineMs bounds WaitForExit independently of the caller's own timeout.
	ExitDeadlineMs int `json:"exitDeadlineMs,omitempty"`
}

// PreflightInput is the input of preflight.
type PreflightInput struct {
	Images []string `json:"images"`
}

// PreflightOutput reports the engine's readiness.
type PreflightOutput struct {
	Rootless      bool              `json:"rootless"`
	EngineVersion string            `json:"engineVersion"`
	ServerVersion string            `json:"serverVersion"`
	CgroupManager string            `json:"cgroupManager"`
	CNIPath       string            `json:"cniPath"`
	HelperPath    string            `json:"helperPath"`
	Images        map[string]string `json:"images,omitempty"`
}
