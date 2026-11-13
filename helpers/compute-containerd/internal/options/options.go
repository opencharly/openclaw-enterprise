// Package options assembles the nerdctl option structs the helper passes to the
// library. Every value here mirrors something the nerdctl CLI computes from its
// own flag defaults; omitting one fails deep inside nerdctl, so this package is the
// single place that knows the contract (see the specification, §2.2).
package options

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/containerd/go-cni"
	"github.com/containerd/nerdctl/v2/pkg/api/types"
	"github.com/containerd/nerdctl/v2/pkg/defaults"
	"github.com/containerd/nerdctl/v2/pkg/rootlessutil"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// Defaults the nerdctl CLI derives from flags and that the library does not.
const (
	CgroupManager = "systemd"
	NetDriver     = "bridge"
	IPAMDriver    = "host-local"
	LogDriver     = "json-file"
	StopSignal    = "SIGTERM"
	StopTimeout   = 10
	Cgroupns      = "private"
	Runtime       = "io.containerd.runc.v2"
	PullMode      = "missing"
	Workdir       = "/home/node"
	// DefaultCPUQuota mirrors the CLI default for --cpu-quota. nerdctl treats any
	// other value as an explicit quota and then rejects a CPUs request.
	DefaultCPUQuota  = -1
	DefaultCPUPeriod = 100000
)

// ResolveAddress mirrors the CLI's default containerd address. clientutil.NewClient
// does not default it, so an empty address fails with "no grpc connection".
func ResolveAddress(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if rootlessutil.IsRootless() {
		if address, err := rootlessutil.RootlessContainredSockAddress(); err == nil {
			return address
		}
	}
	return ""
}

// Engine builds the global command options for one request.
func Engine(ref protocol.EngineRef) types.GlobalCommandOptions {
	namespace := ref.NamespaceName
	if namespace == "" {
		namespace = ref.Namespace
	}
	dataRoot := ref.DataRoot
	if dataRoot == "" {
		dataRoot = defaults.DataRoot()
	}
	return types.GlobalCommandOptions{
		Namespace:      namespace,
		DataRoot:       dataRoot,
		Address:        ResolveAddress(ref.Address),
		CNIPath:        defaults.CNIPath(),
		CNINetConfPath: defaults.CNINetConfPath(),
		CgroupManager:  CgroupManager,
	}
}

// Validate rejects an option set that would fail inside nerdctl instead of here.
func Validate(global types.GlobalCommandOptions) error {
	if global.Address == "" {
		return fmt.Errorf("containerd address is unresolved (is rootless containerd running?)")
	}
	if global.DataRoot == "" {
		return fmt.Errorf("data root is empty")
	}
	if global.CNIPath == "" || global.CNINetConfPath == "" {
		return fmt.Errorf("CNI path or netconf path is empty")
	}
	if global.Namespace == "" {
		return fmt.Errorf("containerd namespace is empty")
	}
	return nil
}

// Pairs renders a label set as sorted "key=value" arguments.
func Pairs(labels protocol.LabelSet) []string {
	if len(labels) == 0 {
		return nil
	}
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+"="+labels[key])
	}
	return pairs
}

// Network builds the network create options.
func Network(global types.GlobalCommandOptions, name string, labels protocol.LabelSet, internal bool) types.NetworkCreateOptions {
	return types.NetworkCreateOptions{
		GOptions:   global,
		Name:       name,
		Driver:     NetDriver,
		IPAMDriver: IPAMDriver,
		Labels:     Pairs(labels),
		Internal:   internal,
	}
}

// Volume builds the volume create options. The engine writes the created volume's name to
// Stdout, so a nil writer panics inside nerdctl.
func Volume(global types.GlobalCommandOptions, name string, labels protocol.LabelSet) types.VolumeCreateOptions {
	return types.VolumeCreateOptions{
		Stdout:   io.Discard,
		GOptions: global,
		Labels:   Pairs(labels),
	}
}

// NetworkOptions builds the per-container network options, including published ports.
func NetworkOptions(spec protocol.RunContainerInput) types.NetworkOptions {
	networks := spec.Networks
	if len(networks) == 0 {
		networks = []string{spec.Network}
	}
	options := types.NetworkOptions{NetworkSlice: append([]string{}, networks...)}
	for _, publish := range spec.Publish {
		protocolName := publish.Protocol
		if protocolName == "" {
			protocolName = "tcp"
		}
		options.PortMappings = append(options.PortMappings, cni.PortMapping{
			Protocol:      protocolName,
			HostIP:        publish.HostIP,
			HostPort:      int32(publish.HostPort),
			ContainerPort: int32(publish.ContainerPort),
		})
	}
	return options
}

// Container builds the create options. name is the container name; spec.Image and
// spec.Args form the argument vector, whose first element nerdctl reads as an image
// reference.
func Container(
	global types.GlobalCommandOptions,
	self string,
	spec protocol.RunContainerInput,
) types.ContainerCreateOptions {
	args := make([]string, 0, 1+len(spec.Args))
	args = append(args, spec.Image)
	args = append(args, spec.Args...)

	securityOpts := []string{}
	if spec.NoNewPrivs {
		securityOpts = append(securityOpts, "no-new-privileges=true")
	}

	options := types.ContainerCreateOptions{
		Stdout:      io.Discard,
		Stderr:      io.Discard,
		GOptions:    global,
		Name:        spec.Name,
		Label:       Pairs(spec.Labels),
		NerdctlCmd:  self,
		NerdctlArgs: []string{"--address=" + global.Address},
		User:        spec.User,
		ReadOnly:    spec.ReadOnlyRootfs,
		CapDrop:     spec.CapDrop,
		CapAdd:      spec.CapAdd,
		SecurityOpt: securityOpts,
		Entrypoint:  spec.Entrypoint,
		Env:         envPairs(spec.Env),
		Workdir:     Workdir,
		Pull:        PullMode,
		ImagePullOpt: types.ImagePullOptions{
			Mode:     PullMode,
			GOptions: global,
			// nerdctl's pull progress handler flushes its writer unconditionally, so a nil
			// writer panics the whole engine call instead of reporting a failed pull. This
			// driver wants the image, not a progress bar.
			Stdout: io.Discard,
			Stderr: io.Discard,
		},
		LogDriver:   LogDriver,
		StopSignal:  StopSignal,
		StopTimeout: StopTimeout,
		Cgroupns:    Cgroupns,
		Runtime:     Runtime,
		Tmpfs:       tmpfsArgs(spec.Tmpfs),
		Volume:      volumeArgs(spec.Mounts),
		CPUQuota:    DefaultCPUQuota,
	}
	if len(spec.Entrypoint) > 0 {
		options.EntrypointChanged = true
	}
	if spec.Limits != nil {
		// Memory and CPUs are exclusive with the quota/period pair; never set both.
		if spec.Limits.MemoryBytes > 0 {
			options.Memory = strconv.FormatInt(spec.Limits.MemoryBytes, 10) + "b"
		}
		if spec.Limits.CPUs > 0 {
			// nerdctl rejects CPUs together with an explicit quota/period, and its
			// own default quota is -1. Translate the fractional CPU request into a
			// quota over a 100000us period instead of setting CPUs.
			options.CPUPeriod = DefaultCPUPeriod
			options.CPUQuota = int64(spec.Limits.CPUs * float64(DefaultCPUPeriod))
		}
	}
	return options
}

// Start builds the container start options.
func Start(global types.GlobalCommandOptions, self, address string) types.ContainerStartOptions {
	return types.ContainerStartOptions{
		Stdout:      io.Discard,
		GOptions:    global,
		NerdctlCmd:  self,
		NerdctlArgs: []string{"--address=" + address},
	}
}

func envPairs(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+"="+env[key])
	}
	return pairs
}

func tmpfsArgs(specs []protocol.TmpfsSpec) []string {
	args := make([]string, 0, len(specs))
	for _, spec := range specs {
		options := make([]string, 0, 5)
		if spec.SizeBytes > 0 {
			options = append(options, "size="+strconv.FormatInt(spec.SizeBytes, 10))
		}
		if spec.Mode != "" {
			options = append(options, "mode="+spec.Mode)
		}
		if spec.Uid > 0 {
			options = append(options, "uid="+strconv.Itoa(spec.Uid))
		}
		if spec.Gid > 0 {
			options = append(options, "gid="+strconv.Itoa(spec.Gid))
		}
		if len(options) == 0 {
			args = append(args, spec.Target)
			continue
		}
		args = append(args, spec.Target+":"+strings.Join(options, ","))
	}
	return args
}

func volumeArgs(specs []protocol.MountSpec) []string {
	args := make([]string, 0, len(specs))
	for _, spec := range specs {
		source := spec.Volume
		if source == "" {
			source = spec.Source
		}
		if source == "" || spec.Target == "" {
			// A mount without both ends would silently mount the wrong thing.
			panic("a mount needs a volume or source and a target")
		}
		argument := source + ":" + spec.Target
		if spec.ReadOnly {
			argument += ":ro"
		}
		args = append(args, argument)
	}
	return args
}
