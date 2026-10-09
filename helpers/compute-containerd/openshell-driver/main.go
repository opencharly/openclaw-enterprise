// OpenShell compute driver for the host's rootless containerd.
//
// OpenShell ships compute drivers for Kubernetes, Docker, Podman, VM and Windows MXC, none of which
// speaks containerd. This is the documented external-driver seam instead: a gRPC service over a
// Unix domain socket implementing openshell.compute.v1.ComputeDriver, selected by the gateway with
// `--compute-driver <name> --compute-driver-socket <path>`.
//
// It provisions the same two-container sandbox the Docker driver describes:
//
//   - the workload container runs the sandbox entrypoint with no network at all, so every
//     connection has to be mediated; and
//   - a supervisor companion on host networking owns the gateway session, policy, credentials and
//     upstream egress.
//
// A private channel volume carries the authenticated socket and bootstrap material between them,
// and a supervisor-only volume carries the gateway credentials the workload must never see.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/openshellpb/computev1"
	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/openshellpb/extensionv1"
	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

const (
	driverName = "containerd"
	// The channel this driver and its containers share. The workload gets the socket and the
	// public CA; only the supervisor gets the gateway credential material.
	supervisorDirectory    = "/.openshell/supervisor"
	channelVolumeSuffix    = "channel"
	supervisorVolumeSuffix = "supervisor"
	managedLabel           = "containerd.openshell.driver"
	sandboxLabel           = "containerd.openshell.sandbox"
	workspaceLabel         = "containerd.openshell.workspace"
	sandboxNameLabel       = "containerd.openshell.name"
	roleLabel              = "containerd.openshell.role"

	// Supervisor-only material. These names are this driver's private contract with the
	// supervisor image and must never appear in a workload container's mounts.
	sandboxTokenFile     = "sandbox-token"
	authBundleFile       = "auth.json"
	mainProcessFile      = "main-process.json"
	gatewayCAFile        = "gateway-ca.pem"
	descriptorFile       = "runtime-descriptor.json"
	supervisorBinaryPath = "/openshell-supervisor"

	// The isolation backend the supervisor image implements, and the supervisor-facing paths
	// inside the supervisor-only volume.
	admittedIsolationBackend = "openshell-sandbox"
	supervisorTokenPath      = supervisorDirectory + "/" + sandboxTokenFile
	supervisorCAPath         = supervisorDirectory + "/" + gatewayCAFile
	supervisorSSHSocketPath  = supervisorDirectory + "/ssh.sock"
	supervisorProxyTLSDir    = supervisorDirectory + "/proxy-tls"

	// helperBinaryName is the engine helper that serves the OCI hook nerdctl registers for every
	// container this driver creates.
	helperBinaryName = "compute-containerd"

	// deletionRetention is how long a removal this driver performed stays reportable, so a watch
	// stream that reconnects after a driver restart still learns about it.
	deletionRetention = 10 * time.Minute

	// defaultGatewayEndpoint is the gateway's own default gRPC address. The supervisor shares
	// the host network namespace, so host loopback is the gateway.
	defaultGatewayEndpoint = "http://127.0.0.1:17670"
)

type options struct {
	socket          string
	namespace       string
	address         string
	dataRoot        string
	sandboxImage    string
	supervisorImage string
	sandboxBinary   string
	helper          string
	channelSize     int64
	gatewayEndpoint string
	gatewayTLSCA    string
	watchInterval   time.Duration
	supervisorGrace time.Duration
}

type driver struct {
	computev1.UnimplementedComputeDriverServer

	helper *helperClient
	opts   options

	// deleted records sandboxes this driver removed, so every attached watch stream can report
	// the deletion exactly once. A poll of the engine cannot see a sandbox that never had a
	// container, and the gateway waits for the deletion event before it finalises removal.
	mu      sync.Mutex
	deleted map[string]time.Time
}

func main() {
	opts := options{}
	flag.StringVar(&opts.socket, "socket", "", "Unix domain socket the gateway connects to")
	flag.StringVar(&opts.namespace, "namespace", "openclaw-enterprise", "containerd namespace")
	flag.StringVar(&opts.address, "address", "", "containerd address (default: engine default)")
	flag.StringVar(&opts.dataRoot, "data-root", "", "containerd data root (default: engine default)")
	flag.StringVar(&opts.sandboxImage, "sandbox-image", "", "default sandbox image reported to the gateway")
	flag.StringVar(&opts.supervisorImage, "supervisor-image", "", "image carrying the OpenShell supervisor")
	flag.StringVar(&opts.sandboxBinary, "sandbox-binary", "",
		"host path of the OpenShell sandbox runtime binary to mount read-only at "+
			boundaryBinaryPath+"; unset uses the workload image's own /"+boundaryBinaryName)
	flag.StringVar(&opts.helper, "helper", "",
		"compute-containerd helper the engine records as every container's OCI hook (default: the helper next to this binary)")
	flag.Int64Var(&opts.channelSize, "channel-size", 64<<20, "size of the per-sandbox channel volume")
	flag.StringVar(&opts.gatewayEndpoint, "gateway-endpoint", defaultGatewayEndpoint,
		"gateway gRPC endpoint the supervisor connects back to")
	flag.StringVar(&opts.gatewayTLSCA, "gateway-tls-ca", "",
		"PEM CA the supervisor verifies the gateway with when --gateway-endpoint is https")
	flag.DurationVar(&opts.watchInterval, "watch-interval", 2*time.Second,
		"interval between engine polls on the WatchSandboxes stream")
	flag.DurationVar(&opts.supervisorGrace, "supervisor-grace", time.Second,
		"time the supervisor must stay running before its workload is created")
	flag.Parse()

	if opts.socket == "" {
		log.Fatal("openshell-driver-containerd: --socket is required")
	}
	if opts.supervisorImage == "" {
		log.Fatal("openshell-driver-containerd: --supervisor-image is required")
	}
	if err := validateGatewayEndpoint(opts.gatewayEndpoint, opts.gatewayTLSCA); err != nil {
		log.Fatalf("openshell-driver-containerd: %v", err)
	}
	helperPath, err := resolveHelper(opts.helper)
	if err != nil {
		log.Fatalf("openshell-driver-containerd: %v", err)
	}
	opts.helper = helperPath

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	helper := &helperClient{
		path:      opts.helper,
		namespace: opts.namespace,
		address:   opts.address,
		dataRoot:  opts.dataRoot,
	}

	if err := os.Remove(opts.socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatalf("openshell-driver-containerd: cannot clear %s: %v", opts.socket, err)
	}
	listener, err := net.Listen("unix", opts.socket)
	if err != nil {
		log.Fatalf("openshell-driver-containerd: cannot listen on %s: %v", opts.socket, err)
	}
	// The gateway is the only peer, and the socket's permissions are the trust boundary.
	if err := os.Chmod(opts.socket, 0o600); err != nil {
		log.Fatalf("openshell-driver-containerd: cannot protect %s: %v", opts.socket, err)
	}

	server := grpc.NewServer()
	computev1.RegisterComputeDriverServer(server, &driver{
		helper:  helper,
		opts:    opts,
		deleted: map[string]time.Time{},
	})
	go func() {
		<-ctx.Done()
		server.GracefulStop()
	}()
	log.Printf("openshell-driver-containerd: serving %s on %s", driverName, opts.socket)
	if err := server.Serve(listener); err != nil {
		log.Fatalf("openshell-driver-containerd: serve failed: %v", err)
	}
}

// GetCapabilities is the first call the gateway makes, and the one it uses to negotiate the
// extension protocol. This driver reports the standard supervisor readiness path rather than its
// own, and does not implement sandbox authentication, so it must not advertise either.
func (d *driver) GetCapabilities(
	_ context.Context,
	_ *computev1.GetCapabilitiesRequest,
) (*computev1.GetCapabilitiesResponse, error) {
	return &computev1.GetCapabilitiesResponse{
		DriverName:              driverName,
		DriverVersion:           version,
		DefaultImage:            d.opts.sandboxImage,
		GatewayManagesLifecycle: true,
		Extension: &extensionv1.PeerMetadata{
			// The gateway refuses a driver that names no protocol version; this is the version this
			// driver implements and the only one it will serve.
			ProtocolVersion:       &extensionv1.ProtocolVersion{Major: 1, Minor: 0},
			ImplementationName:    driverName,
			ImplementationVersion: version,
			// The gateway refuses a driver that does not name the capabilities it requires of one,
			// and this is the contract every compute driver must satisfy.
			SupportedCapabilities: []string{"openshell.compute.contract"},
		},
		// The gateway refuses to activate a driver that does not acknowledge its resource admission
		// policy, and it compares the string exactly. This driver enforces CPU and memory limits and
		// admits nothing else, which is the v1 policy with an empty body.
		ResourceAdmissionPolicy: "v1:{}",
		ResourceCapabilities: &computev1.ResourceCapabilities{
			Cpu:    &computev1.CpuResourceCapabilities{LimitSupported: true},
			Memory: &computev1.MemoryResourceCapabilities{LimitSupported: true},
		},
	}, nil
}

// AuthenticateSandbox is optional. GetCapabilities reports that this driver does not implement it,
// and the gateway must not call it.
func (d *driver) AuthenticateSandbox(
	_ context.Context,
	_ *computev1.AuthenticateSandboxRequest,
) (*computev1.AuthenticateSandboxResponse, error) {
	return nil, status.Error(codes.Unimplemented, "sandbox authentication is not implemented")
}

func (d *driver) ValidateSandboxCreate(
	_ context.Context,
	request *computev1.ValidateSandboxCreateRequest,
) (*computev1.ValidateSandboxCreateResponse, error) {
	image, name := templateImage(request.GetSandbox())
	if image == "" {
		return nil, status.Error(codes.InvalidArgument, "the sandbox template must name an image")
	}
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "the sandbox must be named")
	}
	return &computev1.ValidateSandboxCreateResponse{}, nil
}

// EnsureWorkspace prepares the per-workspace resources a sandbox needs: nothing is network-attached,
// so the workspace owns a channel volume per sandbox and no networks of its own.
func (d *driver) EnsureWorkspace(
	_ context.Context,
	request *computev1.EnsureWorkspaceRequest,
) (*computev1.EnsureWorkspaceResponse, error) {
	if request.GetWorkspace() == "" {
		return nil, status.Error(codes.InvalidArgument, "a workspace name is required")
	}
	return &computev1.EnsureWorkspaceResponse{}, nil
}

func (d *driver) DeleteWorkspace(
	_ context.Context,
	request *computev1.DeleteWorkspaceRequest,
) (*computev1.DeleteWorkspaceResponse, error) {
	workspace := request.GetWorkspace()
	if workspace == "" {
		return nil, status.Error(codes.InvalidArgument, "a workspace name is required")
	}
	// Every sandbox is removed before its workspace is, so anything still standing here is a
	// leftover. Absence is not a failure.
	listed, err := d.helper.ListContainers(labelSelector(workspace, ""))
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot list sandboxes: %v", err)
	}
	for _, name := range listed.Names {
		if err := d.helper.RemoveContainer(protocol.RemoveContainerInput{
			Name:         name,
			ExpectLabels: workspaceProof(workspace),
		}); err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot remove %s: %v", name, err)
		}
	}
	if _, err := d.helper.RemoveVolumes(protocol.RemoveVolumesInput{
		LabelSelector: labelSelector(workspace, ""),
		ExpectLabels:  managedLabels(),
	}); err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot remove workspace volumes: %v", err)
	}
	return &computev1.DeleteWorkspaceResponse{}, nil
}

// CreateSandbox provisions one mediated sandbox: the boundary workload and the supervisor that
// attaches to it.
//
// The workload has no network interface at all; the supervisor joins host networking only for its
// own loopback callback to the gateway. Both run without new privileges and with every capability
// dropped. The boundary is created stopped, because the protected bootstrap names the identity the
// workload will run as; then the material is staged, the boundary starts and listens, and only then
// does the supervisor start. A supervisor that does not stay running rolls the whole sandbox back:
// a boundary without its supervisor has no policy control.
func (d *driver) CreateSandbox(
	ctx context.Context,
	request *computev1.CreateSandboxRequest,
) (*computev1.CreateSandboxResponse, error) {
	sandbox := request.GetSandbox()
	image, name := templateImage(sandbox)
	if sandbox.GetId() == "" || name == "" || image == "" {
		return nil, status.Error(codes.InvalidArgument, "a sandbox id, name and image are required")
	}
	sandboxID := sandbox.GetId()
	workspace := sandbox.GetWorkspace()
	spec := sandbox.GetSpec()

	// Without gateway-issued launch material there is no authenticated boundary to build. The
	// driver does not invent credentials.
	if len(spec.GetLaunchAuthentication()) == 0 {
		return nil, status.Error(codes.FailedPrecondition,
			"the gateway supplied no launch authentication; refusing to provision an unmediated sandbox")
	}
	auth, err := parseLaunchAuthentication(spec.GetLaunchAuthentication())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid launch authentication: %v", err)
	}
	mainProcess, err := mainProcessSpec(spec)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "cannot encode the main process spec: %v", err)
	}
	childEnv := mergedEnvironment(spec)

	channel, supervisorStore := d.volumeNames(workspace, sandboxID)
	channelVolume, err := d.helper.EnsureVolume(protocol.EnsureVolumeInput{
		Name:   channel,
		Labels: d.volumeLabels(workspace, sandboxID, "channel"),
	})
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot create the channel volume: %v", err)
	}
	supervisorVolume, err := d.helper.EnsureVolume(protocol.EnsureVolumeInput{
		Name:   supervisorStore,
		Labels: d.volumeLabels(workspace, sandboxID, "supervisor"),
	})
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot create the supervisor volume: %v", err)
	}
	if channelVolume.Mountpoint == "" || supervisorVolume.Mountpoint == "" {
		return nil, status.Error(codes.Unavailable,
			"the engine reported no host mountpoint for a sandbox volume")
	}

	workloadName := containerName("sandbox", sandboxID)
	supervisorName := containerName("supervisor", sandboxID)
	workloadLabels := d.sandboxLabels(workspace, sandboxID, "sandbox")
	workloadLabels[sandboxNameLabel] = name

	// The boundary binary comes either from the workload image's own root or from a host-staged
	// copy of the sandbox runtime image's binary, mounted read-only at the path the Docker driver
	// uses. Injection by upload is not available: rootless nerdctl cannot copy into a stopped
	// container, which is why the staged copy is mounted instead.
	binary := "/" + boundaryBinaryName
	mounts := []protocol.MountSpec{{Volume: channel, Target: channelDirectory}}
	if d.opts.sandboxBinary != "" {
		runtimeDir := filepath.Join(channelVolume.Mountpoint, "runtime")
		if err := stageBoundaryBinary(d.opts.sandboxBinary, runtimeDir); err != nil {
			d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
			return nil, status.Errorf(codes.FailedPrecondition, "cannot stage the sandbox runtime: %v", err)
		}
		binary = boundaryBinaryPath
		// Mounted read-only so the sandbox, which runs inside this container, cannot replace the
		// binary its own next generation would start.
		mounts = append(mounts, protocol.MountSpec{
			Source:   runtimeDir,
			Target:   filepath.Dir(boundaryBinaryPath),
			ReadOnly: true,
		})
	}

	// Create the workload first and learn the identity it will run as: the bootstrap configuration
	// has to declare that exact identity before the boundary process starts.
	workload, err := d.helper.RunContainer(protocol.RunContainerInput{
		Name:       workloadName,
		Image:      image,
		Network:    "none",
		Labels:     workloadLabels,
		Env:        childEnv,
		Entrypoint: []string{binary},
		Args:       []string{"--bootstrap", boundaryBootstrap},
		// The sandbox boundary: no capabilities, no privilege escalation, no writable root, and a
		// scratch filesystem only where the runtime needs one.
		NoNewPrivs:     true,
		CapDrop:        []string{"ALL"},
		ReadOnlyRootfs: true,
		Tmpfs: []protocol.TmpfsSpec{
			{Target: "/tmp", SizeBytes: 64 << 20, Mode: "1777"},
			{Target: "/run", SizeBytes: 16 << 20, Mode: "0755"},
		},
		Mounts:     mounts,
		CreateOnly: true,
	})
	if err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, status.Errorf(codes.Unavailable, "cannot create the sandbox workload: %v", err)
	}
	if workload == nil || !workload.Exists || workload.User == "" {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, status.Error(codes.FailedPrecondition,
			"the engine did not report the identity the sandbox workload would run as")
	}

	launch, err := d.stageBoundary(
		sandboxID, name, auth, mainProcess, spec.GetSandboxToken(), logLevel(spec.GetLogLevel()),
		workload.ContainerID, workload.ImageID, workload.User, childEnv,
		channelVolume.Mountpoint, supervisorVolume.Mountpoint,
	)
	if err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, err
	}

	if err := d.helper.StartContainer(protocol.StartContainerInput{
		Name:         workloadName,
		ExpectLabels: workloadLabels,
	}); err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, status.Errorf(codes.Unavailable, "cannot start the sandbox boundary: %v", err)
	}
	if err := d.waitForBoundary(channelVolume.Mountpoint, workloadName); err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, err
	}

	supervisorLabels := d.sandboxLabels(workspace, sandboxID, "supervisor")
	supervisorLabels[sandboxNameLabel] = name
	_, err = d.helper.RunContainer(protocol.RunContainerInput{
		Name:       supervisorName,
		Image:      d.opts.supervisorImage,
		Network:    "host",
		Labels:     supervisorLabels,
		Env:        launch.environment,
		Entrypoint: []string{supervisorBinaryPath},
		Args:       launch.args,
		// The supervisor is this sandbox's control plane: it holds the gateway session and owns the
		// workload's policy. It still runs without new privileges and with every capability dropped.
		NoNewPrivs: true,
		CapDrop:    []string{"ALL"},
		Mounts: []protocol.MountSpec{
			{Volume: channel, Target: channelDirectory, ReadOnly: true},
			{Volume: supervisorStore, Target: supervisorDirectory},
		},
	})
	if err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, status.Errorf(codes.Unavailable, "cannot start the sandbox supervisor: %v", err)
	}
	// The supervisor is the sandbox. If it does not stay running, the workload must not outlive it.
	if _, err := d.awaitSupervisor(supervisorName); err != nil {
		d.discardSandbox(workspace, sandboxID, workloadName, supervisorName)
		return nil, err
	}

	log.Printf("openshell-driver-containerd: sandbox %s provisioned as %s and %s",
		sandboxID, workloadName, supervisorName)

	return &computev1.CreateSandboxResponse{RuntimeIdentity: workload.ContainerID}, nil
}

func (d *driver) GetSandbox(
	ctx context.Context,
	request *computev1.GetSandboxRequest,
) (*computev1.GetSandboxResponse, error) {
	sandbox, err := d.observe(ctx, request.GetSandboxId(), request.GetName())
	if err != nil {
		return nil, err
	}
	if sandbox == nil {
		return nil, status.Error(codes.NotFound, "no such sandbox on this engine")
	}
	return &computev1.GetSandboxResponse{Sandbox: sandbox}, nil
}

func (d *driver) ListSandboxes(
	ctx context.Context,
	_ *computev1.ListSandboxesRequest,
) (*computev1.ListSandboxesResponse, error) {
	listed, err := d.helper.ListContainers(managedLabel + "=" + driverName + "," + roleLabel + "=sandbox")
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot list sandboxes: %v", err)
	}
	sandboxes := make([]*computev1.DriverSandbox, 0, len(listed.Names))
	for _, name := range listed.Names {
		labels := listed.Labels[name]
		sandbox, err := d.observe(ctx, labels[sandboxLabel], name)
		if err != nil {
			return nil, err
		}
		if sandbox != nil {
			sandboxes = append(sandboxes, sandbox)
		}
	}
	return &computev1.ListSandboxesResponse{Sandboxes: sandboxes}, nil
}

// observe reads the platform state for one sandbox. The workload container is the sandbox; the
// supervisor companion is only reported through it.
func (d *driver) observe(
	_ context.Context,
	sandboxID string,
	name string,
) (*computev1.DriverSandbox, error) {
	if sandboxID == "" {
		return nil, nil
	}
	workload, err := d.helper.InspectContainer(containerName("sandbox", sandboxID), nil)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot inspect the sandbox: %v", err)
	}
	if workload == nil || !workload.Exists {
		return nil, nil
	}
	supervisor, err := d.helper.InspectContainer(containerName("supervisor", sandboxID), nil)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot inspect the supervisor: %v", err)
	}
	conditions := []*computev1.DriverCondition{{
		Type:    "WorkloadRunning",
		Status:  conditionStatus(workload.Running),
		Reason:  "container",
		Message: workload.Health,
	}}
	if supervisor != nil && supervisor.Exists {
		conditions = append(conditions, &computev1.DriverCondition{
			Type:   "SupervisorRunning",
			Status: conditionStatus(supervisor.Running),
			Reason: "container",
		})
	} else {
		conditions = append(conditions, &computev1.DriverCondition{
			Type:    "SupervisorRunning",
			Status:  "False",
			Reason:  "missing",
			Message: "the supervisor companion is not running; the workload has no mediated egress",
		})
	}
	// The gateway compares the reported name against the name the sandbox was created with, so a
	// container name must never be reported as a sandbox name. Containers created before this
	// label existed fall back to their sandbox ID, which is stable.
	name = workload.Labels[sandboxNameLabel]
	if name == "" {
		name = sandboxID
	}
	return &computev1.DriverSandbox{
		Id:        sandboxID,
		Name:      name,
		Namespace: d.opts.namespace,
		Workspace: workload.Labels[workspaceLabel],
		Status: &computev1.DriverSandboxStatus{
			Name:       name,
			InstanceId: workload.ContainerID,
			Conditions: conditions,
		},
	}, nil
}

func (d *driver) StopSandbox(
	_ context.Context,
	request *computev1.StopSandboxRequest,
) (*computev1.StopSandboxResponse, error) {
	// Stop is idempotent and keeps persistent state: the containers remain, merely stopped.
	for _, role := range []string{"supervisor", "sandbox"} {
		name := containerName(role, request.GetSandboxId())
		state, err := d.helper.InspectContainer(name, nil)
		if err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot inspect %s: %v", name, err)
		}
		if state == nil || !state.Exists || !state.Running {
			continue
		}
		if err := d.helper.StopContainer(protocol.StopContainerInput{
			Name:         name,
			ExpectLabels: sandboxProof(request.GetSandboxId()),
		}); err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot stop %s: %v", name, err)
		}
	}
	return &computev1.StopSandboxResponse{}, nil
}

// StartSandbox restarts a stopped sandbox.
//
// A restart is a new launch: the gateway mints fresh launch material with its own session and
// generation, the boundary consumes a fresh bootstrap configuration, and the supervisor receives a
// fresh descriptor and auth bundle. The boundary starts first because the supervisor dials it, and
// a supervisor that does not stay running stops the boundary again rather than leaving a workload
// with no policy control.
func (d *driver) StartSandbox(
	_ context.Context,
	request *computev1.StartSandboxRequest,
) (*computev1.StartSandboxResponse, error) {
	sandboxID := request.GetSandboxId()
	if sandboxID == "" {
		return nil, status.Error(codes.InvalidArgument, "a sandbox id is required")
	}
	if len(request.GetLaunchAuthentication()) == 0 {
		return nil, status.Error(codes.FailedPrecondition,
			"the gateway supplied no launch authentication for this start; refusing to restart an unauthenticated sandbox")
	}
	auth, err := parseLaunchAuthentication(request.GetLaunchAuthentication())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid launch authentication: %v", err)
	}

	supervisorName := containerName("supervisor", sandboxID)
	workloadName := containerName("sandbox", sandboxID)
	workload, err := d.helper.InspectContainer(workloadName, nil)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot inspect the sandbox workload: %v", err)
	}
	if workload == nil || !workload.Exists {
		return nil, status.Error(codes.NotFound, "no such sandbox on this engine")
	}
	supervisor, err := d.helper.InspectContainer(supervisorName, nil)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot inspect the sandbox supervisor: %v", err)
	}
	if supervisor == nil || !supervisor.Exists {
		return nil, status.Error(codes.FailedPrecondition,
			"the sandbox supervisor container is missing; the sandbox cannot be started safely")
	}
	workspace := workload.Labels[workspaceLabel]
	sandboxName := workload.Labels[sandboxNameLabel]
	if sandboxName == "" {
		sandboxName = sandboxID
	}
	if workload.User == "" || workload.ImageID == "" {
		return nil, status.Error(codes.FailedPrecondition,
			"the engine did not report the identity the sandbox workload runs as")
	}

	channel, supervisorStore := d.volumeNames(workspace, sandboxID)
	channelVolume, err := d.helper.EnsureVolume(protocol.EnsureVolumeInput{
		Name:   channel,
		Labels: d.volumeLabels(workspace, sandboxID, "channel"),
	})
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot open the channel volume: %v", err)
	}
	supervisorVolume, err := d.helper.EnsureVolume(protocol.EnsureVolumeInput{
		Name:   supervisorStore,
		Labels: d.volumeLabels(workspace, sandboxID, "supervisor"),
	})
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot open the supervisor volume: %v", err)
	}
	if channelVolume.Mountpoint == "" || supervisorVolume.Mountpoint == "" {
		return nil, status.Error(codes.Unavailable,
			"the engine reported no host mountpoint for a sandbox volume")
	}

	// The canonical main process is fixed for the sandbox's lifetime: reuse what create staged.
	mainProcess, err := os.ReadFile(filepath.Join(supervisorVolume.Mountpoint, mainProcessFile))
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition,
			"cannot read the sandbox main process spec: %v", err)
	}
	childEnv := map[string]string{}
	if _, err := d.stageBoundary(
		sandboxID, sandboxName, auth, mainProcess, auth.Supervisor.GatewayToken, logLevel(""),
		workload.ContainerID, workload.ImageID, workload.User, childEnv,
		channelVolume.Mountpoint, supervisorVolume.Mountpoint,
	); err != nil {
		return nil, err
	}

	if err := d.helper.StartContainer(protocol.StartContainerInput{
		Name:         workloadName,
		ExpectLabels: sandboxProof(sandboxID),
	}); err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot start the sandbox boundary: %v", err)
	}
	if err := d.waitForBoundary(channelVolume.Mountpoint, workloadName); err != nil {
		return nil, err
	}
	if err := d.helper.StartContainer(protocol.StartContainerInput{
		Name:         supervisorName,
		ExpectLabels: sandboxProof(sandboxID),
	}); err != nil {
		_ = d.helper.StopContainer(protocol.StopContainerInput{
			Name:         workloadName,
			ExpectLabels: sandboxProof(sandboxID),
		})
		return nil, status.Errorf(codes.Unavailable, "cannot start the sandbox supervisor: %v", err)
	}
	if _, err := d.awaitSupervisor(supervisorName); err != nil {
		_ = d.helper.StopContainer(protocol.StopContainerInput{
			Name:         workloadName,
			ExpectLabels: sandboxProof(sandboxID),
		})
		return nil, err
	}
	return &computev1.StartSandboxResponse{RuntimeIdentity: workload.ContainerID}, nil
}

func (d *driver) DeleteSandbox(
	_ context.Context,
	request *computev1.DeleteSandboxRequest,
) (*computev1.DeleteSandboxResponse, error) {
	deleted := false
	for _, role := range []string{"supervisor", "sandbox"} {
		name := containerName(role, request.GetSandboxId())
		state, err := d.helper.InspectContainer(name, nil)
		if err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot inspect %s: %v", name, err)
		}
		if state == nil || !state.Exists {
			continue
		}
		if err := d.helper.RemoveContainer(protocol.RemoveContainerInput{
			Name:         name,
			ExpectLabels: sandboxProof(request.GetSandboxId()),
		}); err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot remove %s: %v", name, err)
		}
		deleted = true
	}
	if _, err := d.helper.RemoveVolumes(protocol.RemoveVolumesInput{
		LabelSelector: sandboxLabel + "=" + request.GetSandboxId(),
		ExpectLabels:  managedLabels(),
	}); err == nil {
		deleted = true
	}
	// The sandbox is gone from this engine now, whether this request removed it or it had already
	// been reclaimed. The gateway waits for the deletion observation before it finalises the
	// record, so a repeated delete must still publish it instead of leaving the sandbox deleting.
	d.rememberDeletion(request.GetSandboxId())
	return &computev1.DeleteSandboxResponse{Deleted: deleted}, nil
}

// WatchSandboxes streams platform observations. It polls the engine instead of watching
// containerd directly: every poll re-reads the whole set of managed sandboxes, so the stream
// cannot miss a sandbox that was created while no consumer was attached and stays correct when
// the driver is restarted. The first poll is a full snapshot, and a sandbox that disappears
// between two polls is reported as deleted.
func (d *driver) WatchSandboxes(
	_ *computev1.WatchSandboxesRequest,
	stream grpc.ServerStreamingServer[computev1.WatchSandboxesEvent],
) error {
	ctx := stream.Context()
	interval := d.opts.watchInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// known maps a sandbox ID to the fingerprint of the snapshot the gateway last received.
	known := map[string]string{}
	for {
		// Deletions this driver performed are reported first: they are authoritative and must not
		// be confused with a sandbox that merely disappeared between two polls.
		for _, sandboxID := range d.pendingDeletions() {
			delete(known, sandboxID)
			if err := stream.Send(deletionEvent(sandboxID)); err != nil {
				return err
			}
		}
		observed, err := d.observeSandboxes(ctx)
		if err != nil {
			// Ending the stream makes the gateway retry it; a broken engine is not a driver
			// protocol error, and the next attempt polls again.
			return err
		}
		for _, id := range sortedIDs(observed) {
			entry := observed[id]
			if known[id] == entry.fingerprint {
				continue
			}
			known[id] = entry.fingerprint
			if err := stream.Send(sandboxEvent(entry.sandbox)); err != nil {
				return err
			}
		}
		removed := make([]string, 0)
		for id := range known {
			if _, ok := observed[id]; !ok {
				removed = append(removed, id)
			}
		}
		sort.Strings(removed)
		for _, id := range removed {
			delete(known, id)
			if err := stream.Send(deletionEvent(id)); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// ---------------------------------------------------------------------------
// helpers

const version = "0.1.0"

func managed() string { return managedLabel + "=" + driverName }

// managedLabels is the ownership proof the engine requires before it removes a resource. A label
// selector alone is not proof: a foreign volume of another installation could match it.
func managedLabels() protocol.LabelSet {
	return protocol.LabelSet{managedLabel: driverName}
}

// sandboxProof is the ownership proof for every container and volume of one sandbox.
func sandboxProof(sandboxID string) protocol.LabelSet {
	labels := managedLabels()
	labels[sandboxLabel] = sandboxID
	return labels
}

// workspaceProof is the ownership proof for resources scoped to one workspace.
func workspaceProof(workspace string) protocol.LabelSet {
	labels := managedLabels()
	if workspace != "" {
		labels[workspaceLabel] = workspace
	}
	return labels
}

func labelSelector(workspace string, sandboxID string) string {
	selector := managed()
	if workspace != "" {
		selector += "," + workspaceLabel + "=" + workspace
	}
	if sandboxID != "" {
		selector += "," + sandboxLabel + "=" + sandboxID
	}
	return selector
}

func (d *driver) sandboxLabels(workspace, sandboxID, role string) map[string]string {
	return map[string]string{
		managedLabel:   driverName,
		workspaceLabel: workspace,
		sandboxLabel:   sandboxID,
		roleLabel:      role,
	}
}

func (d *driver) volumeLabels(workspace, sandboxID, kind string) map[string]string {
	labels := d.sandboxLabels(workspace, sandboxID, kind)
	labels["containerd.openshell.volume"] = kind
	return labels
}

func (d *driver) volumeNames(workspace, sandboxID string) (string, string) {
	short := shortDigest(sandboxID)
	return "openshell-" + short + "-" + channelVolumeSuffix,
		"openshell-" + short + "-" + supervisorVolumeSuffix
}

func containerName(role, sandboxID string) string {
	return "openshell-" + role + "-" + shortDigest(sandboxID)
}

func shortDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:12]
}

func templateImage(sandbox *computev1.DriverSandbox) (string, string) {
	if sandbox == nil {
		return "", ""
	}
	return sandbox.GetSpec().GetTemplate().GetImage(), sandbox.GetName()
}

func conditionStatus(running bool) string {
	if running {
		return "True"
	}
	return "False"
}

// ---------------------------------------------------------------------------
// supervisor material

// mergedEnvironment is the environment both the workload container and the boundary's child
// processes get: the sandbox spec's environment plus the template's. Neither can override the
// supervisor's own driver-controlled environment, which is built separately.
func mergedEnvironment(spec *computev1.DriverSandboxSpec) map[string]string {
	environment := map[string]string{}
	for key, value := range spec.GetEnvironment() {
		environment[key] = value
	}
	for key, value := range spec.GetTemplate().GetEnvironment() {
		environment[key] = value
	}
	return environment
}

// mainProcessSpec renders the canonical process the supervisor launches, in the exact wire form
// the supervisor decodes (MainProcessConfig version 1). An empty command means "no command
// supplied": the sandbox boundary resolves a login shell against the agent image, which is why
// that case requests a TTY.
func mainProcessSpec(spec *computev1.DriverSandboxSpec) ([]byte, error) {
	command := append([]string{}, spec.GetCommand()...)
	tty := spec.GetTty()
	if len(command) == 0 {
		tty = true
	}
	return json.Marshal(struct {
		Version                    uint32   `json:"version"`
		Command                    []string `json:"command"`
		TTY                        bool     `json:"tty"`
		AwaitMainProcessAttachment bool     `json:"await_main_process_attachment"`
	}{
		Version:                    1,
		Command:                    command,
		TTY:                        tty,
		AwaitMainProcessAttachment: spec.GetAwaitMainProcessAttachment(),
	})
}

// writeSupervisorFiles stages the supervisor's files 0600 inside the supervisor-only volume. The
// volume mountpoint is owned by the driver's own user, so this is the same trust boundary as the
// driver process; no other container mounts it.
func writeSupervisorFiles(directory string, files map[string][]byte) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	for name, content := range files {
		if name != filepath.Base(name) {
			return fmt.Errorf("invalid supervisor file name %q", name)
		}
		if err := os.WriteFile(filepath.Join(directory, name), content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// awaitSupervisor requires the supervisor to stay running for the settle window. The supervisor
// owns the sandbox's gateway session, so a supervisor that exited can never mediate a workload;
// its caller removes the sandbox instead of creating one.
func (d *driver) awaitSupervisor(name string) (*protocol.ContainerState, error) {
	grace := d.opts.supervisorGrace
	if grace < 0 {
		grace = 0
	}
	deadline := time.Now().Add(grace)
	started := false
	for {
		state, err := d.helper.InspectContainer(name, nil)
		if err != nil {
			return nil, status.Errorf(codes.Unavailable, "cannot inspect the sandbox supervisor: %v", err)
		}
		if state == nil || !state.Exists {
			return nil, status.Error(codes.FailedPrecondition,
				"the sandbox supervisor container disappeared before its workload was created")
		}
		if state.Running {
			started = true
		}
		if started && !state.Running {
			// It ran and stopped: the gateway session a workload depends on is gone.
			return nil, status.Errorf(codes.FailedPrecondition,
				"the sandbox supervisor exited with status %d; refusing to run an unmediated workload: %s",
				state.ExitCode, d.diagnosis(name))
		}
		if !time.Now().Before(deadline) {
			if !state.Running {
				return nil, status.Errorf(codes.FailedPrecondition,
					"the sandbox supervisor did not reach a running state; refusing to run an unmediated workload: %s",
					d.diagnosis(name))
			}
			return state, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// discardSandbox removes the containers and the volumes of a sandbox that could not be created,
// so a retry starts from an empty sandbox. Failures are logged, not returned: the caller already
// has the more useful failure to report.
func (d *driver) discardSandbox(workspace, sandboxID string, names ...string) {
	for _, name := range names {
		if name == "" {
			continue
		}
		if err := d.helper.RemoveContainer(protocol.RemoveContainerInput{
			Name:         name,
			ExpectLabels: sandboxProof(sandboxID),
		}); err != nil {
			log.Printf("openshell-driver-containerd: cannot remove %s while discarding sandbox %s: %v",
				name, sandboxID, err)
		}
	}
	if _, err := d.helper.RemoveVolumes(protocol.RemoveVolumesInput{
		LabelSelector: labelSelector(workspace, sandboxID),
		ExpectLabels:  managedLabels(),
	}); err != nil {
		log.Printf("openshell-driver-containerd: cannot remove the volumes of sandbox %s: %v", sandboxID, err)
	}
}

// ---------------------------------------------------------------------------
// watch

// observation is one sandbox snapshot plus the fingerprint that decides whether the gateway
// needs to see it again.
type observation struct {
	sandbox     *computev1.DriverSandbox
	fingerprint string
}

func (d *driver) observeSandboxes(ctx context.Context) (map[string]observation, error) {
	listed, err := d.helper.ListContainers(managedLabel + "=" + driverName + "," + roleLabel + "=sandbox")
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot list sandboxes: %v", err)
	}
	observed := make(map[string]observation, len(listed.Names))
	for _, name := range listed.Names {
		sandboxID := listed.Labels[name][sandboxLabel]
		if sandboxID == "" {
			continue
		}
		sandbox, err := d.observe(ctx, sandboxID, name)
		if err != nil {
			return nil, err
		}
		if sandbox == nil {
			continue
		}
		observed[sandboxID] = observation{sandbox: sandbox, fingerprint: fingerprint(sandbox)}
	}
	return observed, nil
}

// fingerprint reduces a snapshot to the part the gateway acts on, so a poll that observes nothing
// new does not emit a duplicate event.
func fingerprint(sandbox *computev1.DriverSandbox) string {
	status := sandbox.GetStatus()
	parts := []string{status.GetName(), status.GetInstanceId()}
	for _, condition := range status.GetConditions() {
		parts = append(parts, condition.GetType()+"="+condition.GetStatus()+"="+condition.GetReason())
	}
	sort.Strings(parts[2:])
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:8])
}

// rememberDeletion records a sandbox this driver removed so every watch stream reports it once.
func (d *driver) rememberDeletion(sandboxID string) {
	if sandboxID == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.deleted == nil {
		d.deleted = map[string]time.Time{}
	}
	d.deleted[sandboxID] = time.Now()
}

// pendingDeletions returns the sandboxes to report as deleted and forgets them. A stream that
// attaches later cannot learn about a sandbox whose containers are already gone, so the record is
// kept long enough for the gateway to reconnect.
func (d *driver) pendingDeletions() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	ids := make([]string, 0, len(d.deleted))
	for sandboxID, at := range d.deleted {
		if time.Since(at) > deletionRetention {
			delete(d.deleted, sandboxID)
			continue
		}
		ids = append(ids, sandboxID)
	}
	sort.Strings(ids)
	return ids
}

func sortedIDs(observed map[string]observation) []string {
	ids := make([]string, 0, len(observed))
	for id := range observed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func sandboxEvent(sandbox *computev1.DriverSandbox) *computev1.WatchSandboxesEvent {
	return &computev1.WatchSandboxesEvent{
		Payload: &computev1.WatchSandboxesEvent_Sandbox{
			Sandbox: &computev1.WatchSandboxesSandboxEvent{Sandbox: sandbox},
		},
	}
}

func deletionEvent(sandboxID string) *computev1.WatchSandboxesEvent {
	return &computev1.WatchSandboxesEvent{
		Payload: &computev1.WatchSandboxesEvent_Deleted{
			Deleted: &computev1.WatchSandboxesDeletedEvent{SandboxId: sandboxID},
		},
	}
}

// ---------------------------------------------------------------------------
// options

// validateGatewayEndpoint refuses an endpoint the supervisor cannot use: an https endpoint
// without a CA leaves the supervisor unable to verify the gateway, and TLS material handed to a
// cleartext endpoint would never be used.
func validateGatewayEndpoint(endpoint, caPath string) error {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("--gateway-endpoint %q is not a URL", endpoint)
	}
	switch parsed.Scheme {
	case "http":
		if caPath != "" {
			return errors.New("--gateway-tls-ca is set but --gateway-endpoint is http; the certificate would not be used")
		}
	case "https":
		if caPath == "" {
			return errors.New("an https --gateway-endpoint requires --gateway-tls-ca")
		}
	default:
		return fmt.Errorf("--gateway-endpoint scheme %q is not supported", parsed.Scheme)
	}
	return nil
}

func gatewayHost(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

func logLevel(level string) string {
	if level == "" {
		return "warn"
	}
	return level
}

// resolveHelper locates the compute-containerd helper. nerdctl registers a createRuntime OCI hook
// with every container it creates, and that hook has to be a program that serves `internal
// oci-hook`; this driver does not. Defaulting to the helper next to this binary keeps the two
// halves of one build together, and an explicit --helper can point at an installed helper.
func resolveHelper(explicit string) (string, error) {
	candidate := explicit
	if candidate == "" {
		self, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("cannot resolve this binary's path: %v", err)
		}
		// The driver is installed as openshell-driver-containerd; its helper sits beside it.
		candidate = filepath.Join(filepath.Dir(self), helperBinaryName)
	}
	absolute, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("cannot resolve the helper path %q: %v", candidate, err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("the engine helper %q is not available; build it and pass --helper: %v", absolute, err)
	}
	if info.IsDir() || info.Mode()&0o111 == 0 {
		return "", fmt.Errorf("the engine helper %q is not executable", absolute)
	}
	return absolute, nil
}
