package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// realRun drives the built helper over its wire protocol against the host's real
// rootless containerd. It is skipped unless OCC_TEST_CONTAINERD_REAL=1, because it needs
// a running rootless engine, CNI plugins and image network access.
func realRun(t *testing.T, helper string, request any) protocol.Response {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	command := exec.Command(helper)
	command.Stdin = bytes.NewReader(encoded)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("helper failed: %v (stderr: %s)", err, truncate(stderr.String()))
	}
	response := protocol.Response{}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &response); err != nil {
		t.Fatalf("helper did not answer one JSON envelope: %v (stdout: %s)", err, truncate(stdout.String()))
	}
	return response
}

func truncate(text string) string {
	if len(text) > 400 {
		return text[:400]
	}
	return text
}

// mustSucceed decodes output and fails the test when the helper refused the request.
func mustSucceed(t *testing.T, response protocol.Response, output any) {
	t.Helper()
	if !response.Ok {
		t.Fatalf("helper refused the request: %+v", response.Error)
	}
	if output == nil {
		return
	}
	if err := json.Unmarshal(response.Output, output); err != nil {
		t.Fatalf("decode output: %v", err)
	}
}

// TestRealRootlessLifecycle proves the helper's contract against a live engine:
// owned resources are created, adopted idempotently, reported, stopped and removed,
// and a resource carrying another installation's labels is never touched.
func TestRealRootlessLifecycle(t *testing.T) {
	if os.Getenv("OCC_TEST_CONTAINERD_REAL") != "1" {
		t.Skip("set OCC_TEST_CONTAINERD_REAL=1 to exercise the rootless engine")
	}

	helper := os.Getenv("OCC_TEST_CONTAINERD_HELPER")
	if helper == "" {
		built := filepath.Join(t.TempDir(), "compute-containerd")
		build := exec.Command("go", "build", "-trimpath", "-o", built, ".")
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build helper: %v (%s)", err, truncate(string(output)))
		}
		helper = built
	}

	// A unique suffix keeps the test independent of name reservations left behind by
	// an earlier failed create, which this release cannot release yet.
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	// Derive a loopback port in a high range so parallel runs rarely collide.
	publishedPort := 18000 + int(time.Now().UnixNano()%1000)
	networkName := "oce-real-" + suffix
	agentName := "oce-real-agent-" + suffix
	engineRef := protocol.EngineRef{Namespace: "default", NamespaceName: "default"}
	labels := protocol.LabelSet{
		"org.openclaw.enterprise.namespace": "real-" + suffix,
		"org.openclaw.enterprise.kind":      "agent",
	}
	foreign := protocol.LabelSet{"org.openclaw.enterprise.namespace": "someone-else"}

	cleanup := func() {
		realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "remove-container",
			Engine: engineRef, Input: mustInput(t, protocol.RemoveContainerInput{Name: agentName, ExpectLabels: labels})})
		realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "remove-network",
			Engine: engineRef, Input: mustInput(t, protocol.RemoveNetworkInput{Name: networkName, ExpectLabels: labels})})
	}
	defer cleanup()

	if listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", publishedPort)); err != nil {
		t.Skipf("loopback port %d is busy: %v", publishedPort, err)
	} else {
		listener.Close()
	}

	preflight := protocol.PreflightOutput{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "preflight",
		Engine: engineRef, Input: mustInput(t, protocol.PreflightInput{})}), &preflight)
	if !preflight.Rootless {
		t.Fatalf("expected a rootless engine, got server %q", preflight.ServerVersion)
	}
	if preflight.ServerVersion == "" || preflight.CNIPath == "" {
		t.Fatalf("preflight must report the engine and CNI paths: %+v", preflight)
	}

	// An owned network is created once and then adopted without change.
	created := protocol.EnsureNetworkOutput{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "ensure-network",
		Engine: engineRef, Input: mustInput(t, protocol.EnsureNetworkInput{Name: networkName, Labels: labels, Internal: true})}), &created)
	if !created.Created {
		t.Fatalf("first ensure-network must create the network: %+v", created)
	}
	adopted := protocol.EnsureNetworkOutput{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "ensure-network",
		Engine: engineRef, Input: mustInput(t, protocol.EnsureNetworkInput{Name: networkName, Labels: labels, Internal: true})}), &adopted)
	if adopted.Created {
		t.Error("a repeated ensure-network must adopt the existing network")
	}

	// Another installation's labels must stop the operation.
	refused := realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "ensure-network",
		Engine: engineRef, Input: mustInput(t, protocol.EnsureNetworkInput{Name: networkName, Labels: foreign})})
	if refused.Ok || refused.Error == nil || refused.Error.Code != protocol.CodeOwnership {
		t.Errorf("a foreign label set must be refused with OWNERSHIP: %+v", refused)
	}

	spec := protocol.RunContainerInput{
		Name:           agentName,
		Image:          "docker.io/library/alpine:3.20",
		Network:        networkName,
		Labels:         labels,
		User:           "1000:1000",
		Args:           []string{"sleep", "120"},
		ReadOnlyRootfs: true,
		CapDrop:        []string{"ALL"},
		NoNewPrivs:     true,
		Tmpfs:          []protocol.TmpfsSpec{{Target: "/tmp", Mode: "1777", SizeBytes: 67108864}},
		Limits:         &protocol.LimitsSpec{MemoryBytes: 134217728, CPUs: 0.5},
		// A published loopback port is what the gateway endpoint resolves to.
		Publish:   []protocol.PortPublish{{HostIP: "127.0.0.1", HostPort: publishedPort, ContainerPort: 80}},
		Readiness: &protocol.ReadinessSpec{Command: []string{"true"}, IntervalMs: 1000, DeadlineMs: 60000},
	}
	started := protocol.ContainerState{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "run-container",
		Engine: engineRef, DeadlineMs: 240000, Input: mustInput(t, spec)}), &started)
	if !started.Exists || !started.Running {
		t.Fatalf("the container must be running after a ready probe: %+v", started)
	}
	if started.Health != "ready" {
		t.Errorf("a successful probe must report ready, got %q", started.Health)
	}
	if started.Labels["org.openclaw.enterprise.kind"] != "agent" {
		t.Errorf("ownership labels must be recorded on the container: %v", started.Labels)
	}
	if started.Ports["published"] == "" {
		t.Errorf("a published port must be reported so the driver can resolve an endpoint: %+v", started.Ports)
	}

	listed := protocol.ListContainersOutput{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "list-containers",
		Engine: engineRef, Input: mustInput(t, protocol.ListContainersInput{LabelSelector: "org.openclaw.enterprise.namespace=real-" + suffix})}), &listed)
	if !contains(listed.Names, agentName) {
		t.Errorf("the container must be listed by its labels: %v", listed.Names)
	}

	// The gateway endpoint is only usable if the published loopback port forwards.
	deadline := time.Now().Add(20 * time.Second)
	for {
		connection, dialErr := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", publishedPort), 2*time.Second)
		if dialErr == nil {
			connection.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the published loopback port never accepted a connection: %v", dialErr)
		}
		time.Sleep(500 * time.Millisecond)
	}

	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "stop-container",
		Engine: engineRef, Input: mustInput(t, protocol.StopContainerInput{Name: agentName, ExpectLabels: labels, TimeoutMs: 10000})}), nil)

	stopped := protocol.ContainerState{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "inspect-container",
		Engine: engineRef, Input: mustInput(t, protocol.InspectContainerInput{Name: agentName})}), &stopped)
	if stopped.Running {
		t.Error("the container must be stopped")
	}

	refusedRemoval := realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "remove-container",
		Engine: engineRef, Input: mustInput(t, protocol.RemoveContainerInput{Name: agentName, ExpectLabels: foreign})})
	if refusedRemoval.Ok || refusedRemoval.Error == nil || refusedRemoval.Error.Code != protocol.CodeOwnership {
		t.Errorf("removal with foreign labels must be refused: %+v", refusedRemoval)
	}

	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "remove-container",
		Engine: engineRef, Input: mustInput(t, protocol.RemoveContainerInput{Name: agentName, ExpectLabels: labels})}), nil)
	gone := protocol.ContainerState{}
	mustSucceed(t, realRun(t, helper, protocol.Request{Version: protocol.Version, Operation: "inspect-container",
		Engine: engineRef, Input: mustInput(t, protocol.InspectContainerInput{Name: agentName})}), &gone)
	if gone.Exists {
		t.Error("the container must be gone after removal")
	}
}

func mustInput(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return encoded
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == wanted {
			return true
		}
	}
	return false
}
