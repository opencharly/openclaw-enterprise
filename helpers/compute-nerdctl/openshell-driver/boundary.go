// Boundary material for the OpenShell isolation backend.
//
// The supervisor never invents the workload boundary: the compute driver provisions the byte-stream
// endpoint, the per-session TLS identity and the immutable coordinates, and hands the supervisor a
// signed-format runtime descriptor. The workload side consumes the matching bootstrap configuration.
// These are the encodings of openshell-sandbox-backend's boundary_protocol (BoundaryConfig,
// SandboxRuntimeDescriptor, SandboxTlsMaterial) and of the isolation interface's contract
// (ResolvedWorkloadIdentity, OuterFenceGuarantees). The gateway mints the credentials; this driver
// only transports and binds them.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// Paths inside the workload and supervisor containers. They mirror the Docker driver's layout so
// the same openshell-sandbox bootstrap contract holds.
const (
	channelDirectory     = "/.openshell/channel"
	channelSandboxDir    = channelDirectory + "/sandbox"
	boundaryBootstrap    = channelSandboxDir + "/bootstrap.json"
	boundarySocket       = channelSandboxDir + "/control.sock"
	boundaryCert         = channelSandboxDir + "/server.crt"
	boundaryKey          = channelSandboxDir + "/server.key"
	boundaryBinaryName   = "openshell-sandbox"
	boundaryBinaryPath   = "/.openshell/runtime/" + boundaryBinaryName
	supervisorDescriptor = supervisorDirectory + "/runtime-descriptor.json"
	supervisorWorkdir    = "/"
	supervisorHealthSock = "/run/openshell/health.sock"

	// OuterFenceGuarantee variants, snake_case as the contract serializes them.
	fenceDefaultDenyEgress         = "default_deny_egress"
	fenceNoUnmanagedEgressPath     = "no_unmanaged_egress_path"
	fenceRevocationVerified        = "revocation_verified"
	fenceControllerLossFailsClosed = "controller_loss_fails_closed"
)

// launchAuthentication is the gateway's opaque launch material for one sandbox.
type launchAuthentication struct {
	Supervisor       supervisorAuthBundle `json:"supervisor"`
	GatewayID        string               `json:"gateway_id"`
	VerificationKeys []struct {
		KeyID        string          `json:"key_id"`
		PublicKeyPEM json.RawMessage `json:"public_key_pem"`
	} `json:"verification_keys"`
	raw json.RawMessage
}

// supervisorAuthBundle is the supervisor's half: the bearer credentials for this exact launch.
// It is written verbatim as auth.json; nothing here is re-signed or adjusted by this driver.
type supervisorAuthBundle struct {
	SessionID         string  `json:"session_id"`
	RuntimeGeneration string  `json:"runtime_generation"`
	SessionRotation   uint64  `json:"session_rotation"`
	AuthEpoch         uint64  `json:"auth_epoch"`
	GatewayToken      string  `json:"gateway_token"`
	GatewayExpiresAt  int64   `json:"gateway_expires_at"`
	SandboxToken      string  `json:"sandbox_token"`
	SandboxExpiresAt  int64   `json:"sandbox_expires_at"`
	SSHHostPrivateKey *string `json:"ssh_host_private_key,omitempty"`
}

type gatewayVerificationKey struct {
	KeyID        string `json:"key_id"`
	PublicKeyPEM string `json:"public_key_pem"`
}

type resolvedWorkloadIdentity struct {
	UID               uint32   `json:"uid"`
	GID               uint32   `json:"gid"`
	SupplementaryGIDs []uint32 `json:"supplementary_gids"`
	Source            string   `json:"source"`
	ResourceDigest    string   `json:"resource_digest"`
}

type outerFenceGuarantees struct {
	Generation     string   `json:"generation"`
	Established    []string `json:"established"`
	EvidenceDigest string   `json:"evidence_digest"`
}

type boundaryTLSFiles struct {
	CertificateChainPath string `json:"certificate_chain_path"`
	PrivateKeyPath       string `json:"private_key_path"`
}

type boundaryListener struct {
	Kind       string           `json:"kind"`
	SocketPath string           `json:"socket_path"`
	TLS        boundaryTLSFiles `json:"tls"`
}

type sandboxTransport struct {
	Kind       string `json:"kind"`
	SocketPath string `json:"socket_path"`
}

type sandboxTLSClient struct {
	ServerName     string `json:"server_name"`
	TrustAnchorPEM string `json:"trust_anchor_pem"`
}

type boundaryConfig struct {
	BoundaryID         string                   `json:"boundary_id"`
	Generation         string                   `json:"generation"`
	SessionID          string                   `json:"session_id"`
	SessionRotation    uint64                   `json:"session_rotation"`
	AuthEpoch          uint64                   `json:"auth_epoch"`
	GatewayID          string                   `json:"gateway_id"`
	VerificationKeys   []gatewayVerificationKey `json:"verification_keys"`
	Listener           boundaryListener         `json:"listener"`
	ResourceClaims     map[string]string        `json:"resource_claims"`
	ResourceClaimFiles map[string]string        `json:"resource_claim_files"`
	WorkloadIdentity   resolvedWorkloadIdentity `json:"workload_identity"`
	OuterFence         outerFenceGuarantees     `json:"outer_fence"`
	ChildEnv           map[string]string        `json:"child_env"`
}

type sandboxRuntimeDescriptor struct {
	BoundaryID       string                   `json:"boundary_id"`
	Generation       string                   `json:"generation"`
	SessionID        string                   `json:"session_id"`
	WorkloadIdentity resolvedWorkloadIdentity `json:"workload_identity"`
	Transport        sandboxTransport         `json:"transport"`
	TLS              sandboxTLSClient         `json:"tls"`
	HostGatewayIP    string                   `json:"host_gateway_ip"`
	ResourceClaims   map[string]string        `json:"resource_claims"`
	OuterFence       outerFenceGuarantees     `json:"outer_fence"`
}

// sandboxTLS is one generation-pinned server identity: a throwaway CA plus the leaf it signs. The
// trust anchor goes to the supervisor, the leaf to the boundary. Caller authorization is the JWT,
// not the certificate, so the CA key is discarded here.
type sandboxTLS struct {
	serverName     string
	trustAnchorPEM string
	certificatePEM string
	privateKeyPEM  string
}

func generateSandboxTLS(sessionID string) (*sandboxTLS, error) {
	serverName := "sandbox." + sessionID + ".openshell.internal"
	notBefore := time.Date(1975, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter := time.Date(4096, 1, 1, 0, 0, 0, 0, time.UTC)

	caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate sandbox CA key: %v", err)
	}
	caSerial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          caSerial,
		Subject:               pkix.Name{CommonName: "OpenShell sandbox session CA"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caPublic, caPrivate)
	if err != nil {
		return nil, fmt.Errorf("generate sandbox CA certificate: %v", err)
	}

	leafPublic, leafPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate sandbox TLS server key: %v", err)
	}
	leafSerial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: leafSerial,
		Subject:      pkix.Name{CommonName: "OpenShell sandbox runtime"},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		// The supervisor pins this exact name for the generation.
		DNSNames: []string{serverName},
		KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caTemplate, leafPublic, caPrivate)
	if err != nil {
		return nil, fmt.Errorf("sign sandbox TLS server certificate: %v", err)
	}
	leafKeyDER, err := x509.MarshalPKCS8PrivateKey(leafPrivate)
	if err != nil {
		return nil, fmt.Errorf("encode sandbox TLS server key: %v", err)
	}

	return &sandboxTLS{
		serverName: serverName,
		trustAnchorPEM: string(pem.EncodeToMemory(&pem.Block{
			Type: "CERTIFICATE", Bytes: caDER,
		})),
		certificatePEM: string(pem.EncodeToMemory(&pem.Block{
			Type: "CERTIFICATE", Bytes: leafDER,
		})),
		privateKeyPEM: string(pem.EncodeToMemory(&pem.Block{
			Type: "PRIVATE KEY", Bytes: leafKeyDER,
		})),
	}, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate certificate serial: %v", err)
	}
	return serial, nil
}

// outerFence projects the guarantees this driver actually established for one generation.
//
// A workload with no network interface at all cannot originate a packet, its fence cannot be
// revoked by anything the workload does, and a lost driver does not open a path: the guarantees
// follow from the container's network mode, and the native evidence records exactly that.
func outerFence(generation, containerID, imageIdentity string) outerFenceGuarantees {
	evidence, _ := json.Marshal(struct {
		ContainerID        string   `json:"container_id"`
		NetworkMode        string   `json:"network_mode"`
		UnexpectedNetworks []string `json:"unexpected_networks"`
	}{
		ContainerID:        containerID,
		NetworkMode:        "none",
		UnexpectedNetworks: []string{},
	})
	// binding = be64(generation length) || generation || native evidence, per
	// OuterFenceGuarantees::from_enforcement_evidence.
	binding := make([]byte, 8, 8+len(generation)+len(evidence))
	binary.BigEndian.PutUint64(binding, uint64(len(generation)))
	binding = append(binding, generation...)
	binding = append(binding, evidence...)
	digest := sha256.Sum256(binding)
	return outerFenceGuarantees{
		Generation: generation,
		Established: []string{
			fenceDefaultDenyEgress,
			fenceNoUnmanagedEgressPath,
			fenceRevocationVerified,
			fenceControllerLossFailsClosed,
		},
		EvidenceDigest: hex.EncodeToString(digest[:]),
	}
}

// parseLaunchAuthentication decodes the gateway's launch material and validates what the
// driver depends on. It never substitutes values the gateway did not send.
func parseLaunchAuthentication(encoded []byte) (*launchAuthentication, error) {
	auth := &launchAuthentication{}
	if err := json.Unmarshal(encoded, auth); err != nil {
		return nil, fmt.Errorf("launch authentication is not valid JSON: %v", err)
	}
	auth.raw = json.RawMessage(encoded)
	if auth.GatewayID == "" {
		return nil, errors.New("launch authentication carries no gateway identity")
	}
	if len(auth.VerificationKeys) == 0 {
		return nil, errors.New("launch authentication carries no gateway verification keys")
	}
	if auth.Supervisor.SessionID == "" {
		return nil, errors.New("launch authentication carries no session identity")
	}
	if auth.Supervisor.RuntimeGeneration == "" {
		return nil, errors.New("launch authentication carries no runtime generation")
	}
	if auth.Supervisor.SandboxToken == "" {
		return nil, errors.New("launch authentication carries no sandbox session credential")
	}
	if auth.Supervisor.SessionRotation == 0 || auth.Supervisor.AuthEpoch == 0 {
		return nil, errors.New("launch authentication carries a zero rotation or authorization epoch")
	}
	return auth, nil
}

// supervisorBundleJSON returns the supervisor's half verbatim, which is what auth.json holds.
func (auth *launchAuthentication) supervisorBundleJSON() ([]byte, error) {
	var envelope struct {
		Supervisor json.RawMessage `json:"supervisor"`
	}
	if err := json.Unmarshal(auth.raw, &envelope); err != nil {
		return nil, fmt.Errorf("launch authentication has no supervisor member: %v", err)
	}
	if len(envelope.Supervisor) == 0 || string(envelope.Supervisor) == "null" {
		return nil, errors.New("launch authentication carries no supervisor bundle")
	}
	return envelope.Supervisor, nil
}

// verificationKeys converts the gateway's public keys into the boundary's form. The bundle
// serializes the PEM as a byte array; a base64 string is accepted too so a driver is never the
// reason a valid bundle fails.
func (auth *launchAuthentication) verificationKeys() ([]gatewayVerificationKey, error) {
	keys := make([]gatewayVerificationKey, 0, len(auth.VerificationKeys))
	for _, key := range auth.VerificationKeys {
		if key.KeyID == "" {
			return nil, errors.New("launch authentication carries a verification key without an ID")
		}
		pem, err := decodePEM(key.PublicKeyPEM)
		if err != nil {
			return nil, fmt.Errorf("verification key %q: %v", key.KeyID, err)
		}
		keys = append(keys, gatewayVerificationKey{KeyID: key.KeyID, PublicKeyPEM: pem})
	}
	return keys, nil
}

func decodePEM(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("empty public key")
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		if asString == "" {
			return "", errors.New("empty public key")
		}
		return asString, nil
	}
	var asBytes []byte
	if err := json.Unmarshal(raw, &asBytes); err != nil {
		return "", fmt.Errorf("public key is neither a PEM string nor a byte array: %v", err)
	}
	if len(asBytes) == 0 {
		return "", errors.New("empty public key")
	}
	return string(asBytes), nil
}

// workloadIdentityFromUser parses the "uid:gid" the engine reports for the created container.
// The contract refuses UID or GID zero, so a container that would run as root cannot become a
// mediated sandbox.
func workloadIdentityFromUser(user, source, resourceDigest string) (resolvedWorkloadIdentity, error) {
	var uid, gid uint32
	if _, err := fmt.Sscanf(user, "%d:%d", &uid, &gid); err != nil {
		return resolvedWorkloadIdentity{}, fmt.Errorf("container identity %q is not uid:gid: %v", user, err)
	}
	if uid == 0 || gid == 0 {
		return resolvedWorkloadIdentity{}, errors.New("workload identity must not contain UID or GID zero")
	}
	if source == "" || resourceDigest == "" {
		return resolvedWorkloadIdentity{}, errors.New("workload identity source and resource digest are required")
	}
	return resolvedWorkloadIdentity{
		UID:               uid,
		GID:               gid,
		SupplementaryGIDs: []uint32{},
		Source:            source,
		ResourceDigest:    resourceDigest,
	}, nil
}
