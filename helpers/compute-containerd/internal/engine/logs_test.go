package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/containerd/nerdctl/v2/pkg/api/types"
)

// The engine records container output in the json-file envelope. A caller wants the workload's
// words, so the envelope is unwrapped; anything that is not an envelope passes through untouched.
func TestDecodeLogLineUnwrapsTheEngineEnvelope(t *testing.T) {
	envelope := `{"log":"hello from the gateway\n","stream":"stdout","time":"2026-10-09T15:53:21.000000000Z"}`
	if got := decodeLogLine(envelope); got != "hello from the gateway" {
		t.Fatalf("decoded %q, want the message", got)
	}
	if got := decodeLogLine("plain output"); got != "plain output" {
		t.Fatalf("plain line became %q", got)
	}
	if got := decodeLogLine(`{"stream":"stderr"}`); got != `{"stream":"stderr"}` {
		t.Fatalf("an envelope without a message became %q", got)
	}
}

// The log store is derived from the datastore, the namespace and the container id, which the
// Driver passes in; guessing produced an empty log with no reason for it.
func TestLogFilePathFollowsTheEngineLayout(t *testing.T) {
	root := t.TempDir()
	const (
		ns = "openclaw-enterprise"
		id = "0123456789abcdef"
	)
	directory := filepath.Join(root, "containers", ns, id)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("prepare store: %v", err)
	}
	logPath := filepath.Join(directory, id+"-json.log")
	if err := os.WriteFile(logPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("write log: %v", err)
	}
	e := &Engine{global: types.GlobalCommandOptions{DataRoot: root, Namespace: ns}}
	if got := e.logFilePath("gateway", id); got != logPath {
		t.Fatalf("logFilePath = %q, want %q", got, logPath)
	}
}
