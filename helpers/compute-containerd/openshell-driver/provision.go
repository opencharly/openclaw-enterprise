// Provisioning of one mediated sandbox: the boundary that serves the workload and the supervisor
// that attaches to it.
//
// Order matters and matches the Docker driver's: create the workload container without starting
// it, learn the identity it will run as, stage the protected bootstrap and TLS into the channel
// the two containers share, start the boundary, wait until it listens, and only then start the
// supervisor that dials it. The supervisor's first boundary call is image-policy discovery, so it
// cannot come first.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// boundaryListenTimeout bounds how long the driver waits for its boundary to listen.
const (
	boundaryListenTimeout = 20 * time.Second
	boundaryPollInterval  = 100 * time.Millisecond
)

// boundaryLaunch is the supervisor's half of one generation: what it needs in its environment and
// on its command line.
type boundaryLaunch struct {
	environment map[string]string
	args        []string
}

// stageBoundary builds one generation's boundary material and stages both halves: the bootstrap
// configuration and per-session TLS into the channel the workload and supervisor share, and the
// runtime descriptor, auth bundle and main-process spec into the supervisor-only volume.
func (d *driver) stageBoundary(
	sandboxID, sandboxName string,
	auth *launchAuthentication,
	mainProcess []byte,
	sandboxToken, logLevel string,
	containerID, imageIdentity, workloadUser string,
	childEnv map[string]string,
	channelMountpoint, supervisorMountpoint string,
) (*boundaryLaunch, error) {
	verificationKeys, err := auth.verificationKeys()
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid gateway verification keys: %v", err)
	}
	identity, err := workloadIdentityFromUser(workloadUser, "image", imageIdentity)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "cannot declare the workload identity: %v", err)
	}
	tls, err := generateSandboxTLS(auth.Supervisor.SessionID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "cannot generate the boundary TLS identity: %v", err)
	}
	claims := map[string]string{
		"nerdctl.container_id":   containerID,
		"nerdctl.image_identity": imageIdentity,
	}
	fence := outerFence(auth.Supervisor.RuntimeGeneration, containerID, imageIdentity)

	config := boundaryConfig{
		BoundaryID:       sandboxID,
		Generation:       auth.Supervisor.RuntimeGeneration,
		SessionID:        auth.Supervisor.SessionID,
		SessionRotation:  auth.Supervisor.SessionRotation,
		AuthEpoch:        auth.Supervisor.AuthEpoch,
		GatewayID:        auth.GatewayID,
		VerificationKeys: verificationKeys,
		Listener: boundaryListener{
			Kind:       "unix",
			SocketPath: boundarySocket,
			TLS: boundaryTLSFiles{
				CertificateChainPath: boundaryCert,
				PrivateKeyPath:       boundaryKey,
			},
		},
		ResourceClaims:     claims,
		ResourceClaimFiles: map[string]string{},
		WorkloadIdentity:   identity,
		OuterFence:         fence,
		ChildEnv:           childEnv,
	}
	descriptor := sandboxRuntimeDescriptor{
		BoundaryID:       sandboxID,
		Generation:       auth.Supervisor.RuntimeGeneration,
		SessionID:        auth.Supervisor.SessionID,
		WorkloadIdentity: identity,
		Transport: sandboxTransport{
			Kind:       "unix",
			SocketPath: boundarySocket,
		},
		TLS: sandboxTLSClient{
			ServerName:     tls.serverName,
			TrustAnchorPEM: tls.trustAnchorPEM,
		},
		HostGatewayIP:  "127.0.0.1",
		ResourceClaims: claims,
		OuterFence:     fence,
	}
	if err := writeBoundaryBundle(channelMountpoint, config, tls); err != nil {
		return nil, status.Errorf(codes.Internal, "cannot stage the boundary bootstrap: %v", err)
	}

	bundle, err := auth.supervisorBundleJSON()
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid launch authentication: %v", err)
	}
	descriptorJSON, err := json.Marshal(descriptor)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "cannot encode the runtime descriptor: %v", err)
	}
	files := map[string][]byte{
		authBundleFile:  bundle,
		mainProcessFile: mainProcess,
		descriptorFile:  descriptorJSON,
	}
	if sandboxToken != "" {
		files[sandboxTokenFile] = []byte(sandboxToken)
	}
	if d.opts.gatewayTLSCA != "" {
		certificate, err := os.ReadFile(d.opts.gatewayTLSCA)
		if err != nil {
			return nil, status.Errorf(codes.FailedPrecondition, "cannot read the gateway TLS CA: %v", err)
		}
		files[gatewayCAFile] = certificate
	}
	if err := writeSupervisorFiles(supervisorMountpoint, files); err != nil {
		return nil, status.Errorf(codes.Internal, "cannot stage supervisor material: %v", err)
	}

	log.Printf("openshell-driver-containerd: sandbox %s boundary staged (session=%s generation=%s identity=%d:%d token=%t)",
		sandboxID, auth.Supervisor.SessionID, auth.Supervisor.RuntimeGeneration, identity.UID, identity.GID, sandboxToken != "")

	environment := map[string]string{
		"OPENSHELL_ENDPOINT":                   d.opts.gatewayEndpoint,
		"OPENSHELL_SANDBOX_ID":                 sandboxID,
		"OPENSHELL_SANDBOX":                    sandboxName,
		"OPENSHELL_SANDBOX_TOKEN_FILE":         supervisorTokenPath,
		"OPENSHELL_MAIN_PROCESS_SPEC":          string(mainProcess),
		"OPENSHELL_ADMITTED_ISOLATION_BACKEND": admittedIsolationBackend,
		"OPENSHELL_SSH_SOCKET_PATH":            supervisorSSHSocketPath,
		"OPENSHELL_PROXY_TLS_DIR":              supervisorProxyTLSDir,
		"OPENSHELL_LOG_LEVEL":                  logLevel,
		"OPENSHELL_TELEMETRY_ENABLED":          "false",
	}
	if d.opts.gatewayTLSCA != "" {
		environment["OPENSHELL_TLS_CA"] = supervisorCAPath
		environment["OPENSHELL_GATEWAY_TLS_SERVER_NAME"] = gatewayHost(d.opts.gatewayEndpoint)
	}
	args := []string{
		"--backend-descriptor-file", supervisorDescriptor,
		"--auth-bundle-file", supervisorDirectory + "/" + authBundleFile,
		"--workdir", supervisorWorkdir,
		"--health-socket-path", supervisorHealthSock,
	}
	return &boundaryLaunch{environment: environment, args: args}, nil
}

// stageBoundaryBinary copies the sandbox runtime binary next to the channel it is mounted from.
// It is the rootless-containerd equivalent of the Docker driver's extract-and-upload: uploading into a
// stopped container is unavailable, so the binary is staged on the host and mounted read-only.
func stageBoundaryBinary(source, directory string) error {
	content, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("read sandbox runtime binary %q: %w", source, err)
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	target := filepath.Join(directory, boundaryBinaryName)
	if err := os.WriteFile(target, content, 0o555); err != nil {
		return err
	}
	return os.Chmod(target, 0o555)
}

// writeBoundaryBundle writes the protected bootstrap and the per-session TLS into the channel
// directory the workload container consumes it from.
//
// The workload runs as its image's non-root user. In rootless containerd that user maps to a
// subordinate host uid this driver cannot chown files to, so the directory is left traversable and
// writable and the files readable. The channel volume is mounted into this sandbox's two
// containers only, the bootstrap configuration holds no secret, and the TLS key authenticates the
// boundary that the sandbox itself runs.
func writeBoundaryBundle(mountpoint string, config boundaryConfig, tls *sandboxTLS) error {
	// nerdctl creates a volume's backing directory 0700 for the driver's user, which is the
	// container's root. The boundary runs as the workload image's non-root user, so it needs
	// traverse permission on the volume root before it can reach its own directory at all.
	if err := os.Chmod(mountpoint, 0o711); err != nil {
		return err
	}
	directory := filepath.Join(mountpoint, "sandbox")
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o777); err != nil {
		return err
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode boundary config: %w", err)
	}
	files := map[string][]byte{
		"bootstrap.json": encoded,
		"server.crt":     []byte(tls.certificatePEM),
		"server.key":     []byte(tls.privateKeyPEM),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(directory, name), content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// waitForBoundary waits until the boundary listens on the channel socket. The boundary consumes
// its bootstrap configuration as it starts, so a failure here means the workload exited; the
// workload's own output is the most useful diagnosis.
func (d *driver) waitForBoundary(channelMountpoint, workloadName string) error {
	socket := filepath.Join(channelMountpoint, "sandbox", "control.sock")
	deadline := time.Now().Add(boundaryListenTimeout)
	for {
		if _, err := os.Stat(socket); err == nil {
			return nil
		}
		state, err := d.helper.InspectContainer(workloadName, nil)
		if err != nil {
			return status.Errorf(codes.Unavailable, "cannot inspect the sandbox boundary: %v", err)
		}
		if state != nil && state.Exists && !state.Running {
			return status.Errorf(codes.FailedPrecondition,
				"the sandbox boundary exited before it listened (exit %d): %s",
				state.ExitCode, d.diagnosis(workloadName))
		}
		if !time.Now().Before(deadline) {
			return status.Errorf(codes.FailedPrecondition,
				"the sandbox boundary did not listen within %s: %s",
				boundaryListenTimeout, d.diagnosis(workloadName))
		}
		time.Sleep(boundaryPollInterval)
	}
}

// diagnosis reads the tail of a container's own output through the helper. It is bounded and
// carries no credential material: the boundary writes its own startup errors here.
func (d *driver) diagnosis(name string) string {
	output, err := d.helper.ReadLogs(protocol.ReadLogsInput{
		Name:         name,
		ExpectLabels: managedLabels(),
		Lines:        6,
		LimitBytes:   4096,
	})
	if err != nil || output == nil || len(output.Lines) == 0 {
		return "no output available"
	}
	joined := ""
	for _, line := range output.Lines {
		joined += line + "; "
	}
	if output.Truncated {
		joined += "(truncated)"
	}
	return joined
}
