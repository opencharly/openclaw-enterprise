// Command compute-containerd is the Go helper that serves a rootless containerd compute
// driver. It speaks one JSON request and one JSON response on standard streams, and
// it also serves two runtime modes that nerdctl normally serves itself: the OCI hook
// and the containerd logging plugin.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/containerd/nerdctl/v2/pkg/clientutil"
	"github.com/containerd/nerdctl/v2/pkg/defaults"
	"github.com/containerd/nerdctl/v2/pkg/logging"
	"github.com/containerd/nerdctl/v2/pkg/ocihook"
	"github.com/containerd/nerdctl/v2/pkg/rootlessutil"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/engine"
	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

func main() {
	// Mode 1: containerd runtime v2 logging plugin. The runtime invokes exactly
	// "<helper> _NERDCTL_INTERNAL_LOGGING <datastore>".
	if len(os.Args) == 3 && os.Args[1] == logging.MagicArgv1 {
		if err := logging.Main(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, protocol.Bound(err.Error()))
			os.Exit(1)
		}
		return
	}

	// Mode 2: OCI hook. The runtime invokes us through nsenter with the global flags
	// the creating process propagated, so the subcommand is not at a fixed index.
	if event, ok := hookEvent(os.Args); ok {
		if err := runHook(os.Args, event); err != nil {
			// A non-zero exit fails container creation, which is what the runtime
			// must see when the hook cannot set up networking.
			fmt.Fprintln(os.Stderr, protocol.Bound(err.Error()))
			os.Exit(1)
		}
		return
	}

	// Mode 3: engine operations need RootlessKit's namespaces; re-enter them once.
	if rootlessutil.IsRootlessParent() {
		if err := rootlessutil.ParentMain(os.Getenv("OCC_CONTAINERD_HOST_GATEWAY_IP")); err != nil {
			protocol.WriteFailure(protocol.Errorf(protocol.CodeUnavailable, "rootless re-entry failed: %v", err))
		}
		return
	}

	// Mode 4: one request on standard input, one response on standard output.
	runRequest()
}

// hookEvent locates the "internal oci-hook <event>" triple anywhere after argv[0].
func hookEvent(argv []string) (string, bool) {
	for index := 1; index < len(argv); index++ {
		if argv[index] != "internal" || index+2 >= len(argv) || argv[index+1] != "oci-hook" {
			continue
		}
		return argv[index+2], true
	}
	return "", false
}

// globalFlag returns the last value of a "--name=value" style global flag.
func globalFlag(argv []string, name string) string {
	prefix := "--" + name + "="
	value := ""
	for _, argument := range argv {
		if strings.HasPrefix(argument, prefix) {
			value = strings.TrimPrefix(argument, prefix)
		}
	}
	return value
}

// runHook reproduces the environment the creating process used, because the
// data-store hash depends on the resolved containerd address.
func runHook(argv []string, event string) error {
	dataRoot := globalFlag(argv, "data-root")
	if dataRoot == "" {
		dataRoot = defaults.DataRoot()
	}
	address := globalFlag(argv, "address")
	cniPath := globalFlag(argv, "cni-path")
	if cniPath == "" {
		cniPath = defaults.CNIPath()
	}
	netConfPath := globalFlag(argv, "cni-netconfpath")
	if netConfPath == "" {
		netConfPath = defaults.CNINetConfPath()
	}
	dataStore, err := clientutil.DataStore(dataRoot, address)
	if err != nil {
		return err
	}
	return ocihook.Run(os.Stdin, os.Stderr, event, dataStore, cniPath, netConfPath,
		globalFlag(argv, "bridge-ip"))
}

// runRequest reads one request and writes one response.
func runRequest() {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 8*1024*1024))
	if err != nil {
		protocol.WriteFailure(protocol.Errorf(protocol.CodeInternal, "cannot read the request: %v", err))
		return
	}
	request := protocol.Request{}
	if err := json.Unmarshal(raw, &request); err != nil {
		protocol.WriteFailure(protocol.Errorf(protocol.CodeInternal, "malformed request: %v", err))
		return
	}
	if request.Version != protocol.Version {
		protocol.WriteFailure(protocol.Errorf(protocol.CodeConfiguration,
			"unsupported request version %d", request.Version))
		return
	}

	ctx := context.Background()
	if request.DeadlineMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(request.DeadlineMs)*time.Millisecond)
		defer cancel()
	}

	// The helper is its own OCI hook binary, so it passes no separate hook path.
	opened, err := engine.Open(ctx, request.Engine, "")
	if err != nil {
		fail(err)
		return
	}
	defer opened.Close()

	output, err := dispatch(ctx, opened, request)
	if err != nil {
		fail(err)
		return
	}
	protocol.Write(output)
}

// dispatch routes one operation. Inputs are decoded only after the operation is
// known, so an unknown operation cannot reach the engine.
func dispatch(ctx context.Context, opened *engine.Engine, request protocol.Request) (any, error) {
	decode := func(target any) error {
		if len(request.Input) == 0 {
			return protocol.Errorf(protocol.CodeConfiguration, "operation %q requires input", request.Operation)
		}
		if err := json.Unmarshal(request.Input, target); err != nil {
			return protocol.Errorf(protocol.CodeConfiguration, "invalid input for %q: %v", request.Operation, err)
		}
		return nil
	}

	switch request.Operation {
	case "preflight":
		input := protocol.PreflightInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.Preflight(ctx, input)
	case "ensure-network":
		input := protocol.EnsureNetworkInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.EnsureNetwork(input)
	case "remove-network":
		input := protocol.RemoveNetworkInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return map[string]bool{"removed": true}, opened.RemoveNetwork(input)
	case "ensure-volume":
		input := protocol.EnsureVolumeInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.EnsureVolume(input)
	case "remove-volumes":
		input := protocol.RemoveVolumesInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.RemoveVolumes(input)
	case "inspect-container":
		input := protocol.InspectContainerInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.InspectContainer(input.Name, input.EnvKeys)
	case "run-container", "run-to-completion":
		input := protocol.RunContainerInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		if request.Operation == "run-to-completion" {
			// A one-shot workload reports its exit code instead of a readiness verdict.
			input.Readiness = nil
			input.WaitForExit = true
		}
		return opened.RunContainer(input)
	case "stop-container":
		input := protocol.StopContainerInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return map[string]bool{"stopped": true}, opened.StopContainer(input)
	case "start-container":
		input := protocol.StartContainerInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return map[string]bool{"started": true}, opened.StartContainer(input)
	case "remove-container":
		input := protocol.RemoveContainerInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return map[string]bool{"removed": true}, opened.RemoveContainer(input)
	case "release-name":
		input := protocol.ReleaseNameInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return nil, opened.ReleaseName(input)
	case "list-containers":
		input := protocol.ListContainersInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.ListContainers(input.LabelSelector)
	case "read-logs":
		input := protocol.ReadLogsInput{}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return opened.ReadLogs(input)
	default:
		return nil, protocol.Errorf(protocol.CodeConfiguration, "unknown operation %q", request.Operation)
	}
}

func fail(err error) {
	if failure, ok := err.(*protocol.Failure); ok {
		protocol.WriteFailure(failure)
		return
	}
	protocol.WriteFailure(protocol.Errorf(protocol.CodeInternal, "%v", err))
}
