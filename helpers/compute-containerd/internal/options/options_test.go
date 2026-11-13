package options

import (
	"strings"
	"testing"

	"github.com/containerd/nerdctl/v2/pkg/api/types"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

func testGlobal() types.GlobalCommandOptions {
	return types.GlobalCommandOptions{
		Namespace:      "oce-test",
		DataRoot:       "/tmp/oce-test-data",
		Address:        "/run/containerd/containerd.sock",
		CNIPath:        "/opt/cni/bin",
		CNINetConfPath: "/tmp/oce-test-cni",
		CgroupManager:  CgroupManager,
	}
}

func testSpec() protocol.RunContainerInput {
	return protocol.RunContainerInput{
		Name:    "oce-agent-1",
		Image:   "registry.example/agent@sha256:0000",
		Network: "oce-internal",
		Labels: protocol.LabelSet{
			"org.openclaw.enterprise.namespace": "ns-1",
			"org.openclaw.enterprise.kind":      "agent",
		},
		Args:    []string{"node", "-e", "1"},
		Env:     map[string]string{"B": "2", "A": "1"},
		CapDrop: []string{"ALL"},
	}
}

// The nerdctl library does not derive these from its own flags; each omission
// fails inside nerdctl at create time. This test is the contract's regression net.
func TestContainerSuppliesNerdctlDefaults(t *testing.T) {
	global := testGlobal()
	spec := testSpec()
	options := Container(global, "/usr/local/bin/compute-containerd", spec)

	if options.Name != spec.Name {
		t.Errorf("name: got %q, want %q", options.Name, spec.Name)
	}
	if options.Pull != PullMode || options.ImagePullOpt.Mode != PullMode {
		t.Errorf("pull: got %q/%q, want %q", options.Pull, options.ImagePullOpt.Mode, PullMode)
	}
	if options.LogDriver != LogDriver {
		t.Errorf("log driver: got %q, want %q", options.LogDriver, LogDriver)
	}
	if options.StopSignal != StopSignal || options.StopTimeout != StopTimeout {
		t.Errorf("stop: got %q/%d, want %q/%d", options.StopSignal, options.StopTimeout, StopSignal, StopTimeout)
	}
	if options.Cgroupns != Cgroupns {
		t.Errorf("cgroupns: got %q, want %q", options.Cgroupns, Cgroupns)
	}
	if options.Runtime != Runtime {
		t.Errorf("runtime: got %q, want %q", options.Runtime, Runtime)
	}
	// nerdctl treats any quota other than -1 as explicit and then rejects a CPUs
	// request, so the zero value must never reach it.
	if options.CPUQuota != DefaultCPUQuota {
		t.Errorf("cpu quota default: got %d, want %d", options.CPUQuota, DefaultCPUQuota)
	}
	if options.CPUs != 0 || options.CPUPeriod != 0 {
		t.Errorf("cpu limits must stay unset without a request: got cpus=%v period=%d",
			options.CPUs, options.CPUPeriod)
	}
	// The helper must not invent a user: an image that expects its own default user
	// fails when the engine is told otherwise. The driver selects the workload user.
	if options.User != "" {
		t.Errorf("user must stay unset without a request: got %q", options.User)
	}
	if options.NerdctlCmd != "/usr/local/bin/compute-containerd" {
		t.Errorf("hook command: got %q", options.NerdctlCmd)
	}
	// The OCI hook cannot recompute the creator's data store without the address.
	wantArgument := "--address=" + global.Address
	if len(options.NerdctlArgs) != 1 || options.NerdctlArgs[0] != wantArgument {
		t.Errorf("hook arguments: got %v, want [%s]", options.NerdctlArgs, wantArgument)
	}
	if len(options.Label) != 2 || options.Label[0] != "org.openclaw.enterprise.kind=agent" {
		t.Errorf("labels: got %v, want sorted key=value pairs", options.Label)
	}
	if len(options.Env) != 2 || options.Env[0] != "A=1" || options.Env[1] != "B=2" {
		t.Errorf("env: got %v, want sorted key=value pairs", options.Env)
	}
	if options.ReadOnly {
		t.Error("read-only rootfs must follow the request, not default to true")
	}

	withUser := testSpec()
	withUser.User = "1000:1000"
	if got := Container(testGlobal(), "/bin/helper", withUser).User; got != "1000:1000" {
		t.Errorf("an explicit user must pass through: got %q", got)
	}
}

// A fractional CPU request is translated into quota/period; setting CPUs as well
// would fail with "cpus and quota/period should be used separately".
func TestContainerTranslatesCPUsIntoQuota(t *testing.T) {
	spec := testSpec()
	spec.Limits = &protocol.LimitsSpec{MemoryBytes: 134217728, CPUs: 0.5}
	options := Container(testGlobal(), "/bin/helper", spec)

	if options.CPUs != 0 {
		t.Errorf("cpus must stay unset: got %v", options.CPUs)
	}
	if options.CPUPeriod != DefaultCPUPeriod {
		t.Errorf("period: got %d, want %d", options.CPUPeriod, DefaultCPUPeriod)
	}
	if want := int64(0.5 * float64(DefaultCPUPeriod)); options.CPUQuota != want {
		t.Errorf("quota: got %d, want %d", options.CPUQuota, want)
	}
	if options.Memory != "134217728b" {
		t.Errorf("memory: got %q, want %q", options.Memory, "134217728b")
	}
}

func TestContainerRendersHardening(t *testing.T) {
	spec := testSpec()
	spec.ReadOnlyRootfs = true
	spec.NoNewPrivs = true
	spec.Entrypoint = []string{"/usr/local/bin/entry"}
	spec.Tmpfs = []protocol.TmpfsSpec{
		{Target: "/tmp", Mode: "1777", SizeBytes: 67108864},
		{Target: "/run"},
	}
	spec.Mounts = []protocol.MountSpec{
		{Volume: "oce-home", Target: "/home/node"},
		{Volume: "oce-shared", Target: "/shared", ReadOnly: true},
	}
	options := Container(testGlobal(), "/bin/helper", spec)

	if !options.ReadOnly || !options.EntrypointChanged {
		t.Error("read-only rootfs and entrypoint must be marked as set")
	}
	if len(options.SecurityOpt) != 1 || options.SecurityOpt[0] != "no-new-privileges=true" {
		t.Errorf("security options: got %v", options.SecurityOpt)
	}
	if len(options.Tmpfs) != 2 ||
		!strings.Contains(options.Tmpfs[0], "mode=1777") ||
		!strings.Contains(options.Tmpfs[0], "size=67108864") ||
		options.Tmpfs[1] != "/run" {
		t.Errorf("tmpfs: got %v", options.Tmpfs)
	}
	if len(options.Volume) != 2 || !strings.HasSuffix(options.Volume[1], ":ro") {
		t.Errorf("volumes: got %v", options.Volume)
	}
}

// The nerdctl library writes progress to the option structs' writers; a nil writer is a
// nil-pointer panic inside the engine rather than an error this code could report.
func TestOptionStructsCarryWriters(t *testing.T) {
	global := testGlobal()
	if Volume(global, "oce-home", protocol.LabelSet{"k": "v"}).Stdout == nil {
		t.Error("volume create options need a writer")
	}
	created := Container(global, "/bin/helper", testSpec())
	if created.Stdout == nil || created.Stderr == nil {
		t.Error("container create options need writers")
	}
	if Start(global, "/bin/helper", global.Address).Stdout == nil {
		t.Error("container start options need a writer")
	}
}

// An egress proxy stands on two planes at once: the Agent's no-egress plane and the plane that
// reaches outside. The engine renders them in the order the Driver asked for.
func TestNetworkOptionsPlaceAContainerOnEveryPlane(t *testing.T) {
	single := NetworkOptions(protocol.RunContainerInput{Network: "oce-internal"})
	if len(single.NetworkSlice) != 1 || single.NetworkSlice[0] != "oce-internal" {
		t.Fatalf("a single plane must survive unchanged, got %v", single.NetworkSlice)
	}
	both := NetworkOptions(protocol.RunContainerInput{
		Network:  "oce-internal",
		Networks: []string{"oce-internal", "oce-edge"},
	})
	if len(both.NetworkSlice) != 2 || both.NetworkSlice[0] != "oce-internal" || both.NetworkSlice[1] != "oce-edge" {
		t.Fatalf("both planes must render in order, got %v", both.NetworkSlice)
	}
}

func TestNetworkAndVolumeOwnershipLabels(t *testing.T) {
	global := testGlobal()
	labels := protocol.LabelSet{"org.openclaw.enterprise.namespace": "ns-1"}

	network := Network(global, "oce-internal", labels, true)
	if network.Driver != NetDriver || network.IPAMDriver != IPAMDriver {
		t.Errorf("network drivers: got %q/%q", network.Driver, network.IPAMDriver)
	}
	if !network.Internal {
		t.Error("an internal network must be created with Internal set")
	}
	if len(network.Labels) != 1 || network.Labels[0] != "org.openclaw.enterprise.namespace=ns-1" {
		t.Errorf("network labels: got %v", network.Labels)
	}

	volume := Volume(global, "oce-home", labels)
	if len(volume.Labels) != 1 {
		t.Errorf("volume labels: got %v", volume.Labels)
	}
}

// An unresolved address fails inside the client with an opaque gRPC error, so the
// helper must reject it first.
func TestValidateRejectsIncompleteOptions(t *testing.T) {
	cases := map[string]func(*types.GlobalCommandOptions){
		"address":  func(g *types.GlobalCommandOptions) { g.Address = "" },
		"dataRoot": func(g *types.GlobalCommandOptions) { g.DataRoot = "" },
		"cniPath":  func(g *types.GlobalCommandOptions) { g.CNIPath = "" },
		"netConf":  func(g *types.GlobalCommandOptions) { g.CNINetConfPath = "" },
		"namespace": func(g *types.GlobalCommandOptions) {
			g.Namespace = ""
		},
	}
	for name, mutate := range cases {
		global := testGlobal()
		mutate(&global)
		if err := Validate(global); err == nil {
			t.Errorf("%s: expected validation to fail", name)
		}
	}
	if err := Validate(testGlobal()); err != nil {
		t.Errorf("complete options must validate: %v", err)
	}
}

func TestResolveAddressPrefersExplicit(t *testing.T) {
	if got := ResolveAddress("/custom/containerd.sock"); got != "/custom/containerd.sock" {
		t.Errorf("explicit address: got %q", got)
	}
}

func TestTmpfsMountsAreOwnedByTheWorkloadUser(t *testing.T) {
	// A hardened container runs read-only with no capabilities, so a mount the workload must
	// write has to be owned by that workload's user rather than left to the runtime's default.
	spec := protocol.RunContainerInput{Name: "agent", Image: "img", Tmpfs: []protocol.TmpfsSpec{
		{Target: "/home/node", SizeBytes: 1073741824, Mode: "700", Uid: 1000, Gid: 1000},
		{Target: "/tmp", SizeBytes: 67108864, Mode: "1777"},
	}}
	options := Container(types.GlobalCommandOptions{}, "self", spec)
	want := []string{"/home/node:size=1073741824,mode=700,uid=1000,gid=1000", "/tmp:size=67108864,mode=1777"}
	got := options.Tmpfs
	if len(got) != len(want) {
		t.Fatalf("tmpfs args = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tmpfs arg %d = %q, want %q", i, got[i], want[i])
		}
	}
}
