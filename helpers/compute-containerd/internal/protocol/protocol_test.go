package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// Messages reach driver logs and user-facing diagnostics, so they stay bounded and
// must not be cut mid-rune.
func TestBoundKeepsMessagesBoundedAndValid(t *testing.T) {
	short := "short message"
	if got := Bound(short); got != short {
		t.Errorf("short message changed: %q", got)
	}

	long := strings.Repeat("ä", 400)
	bounded := Bound(long)
	if len(bounded) > maxMessage {
		t.Errorf("bounded length: got %d, want at most %d", len(bounded), maxMessage)
	}
	if !json.Valid([]byte(`"` + bounded + `"`)) {
		t.Error("bounded message is not valid UTF-8")
	}
	if got := Errorf(CodeInternal, "value %s", long).Message; len(got) > maxMessage {
		t.Errorf("Errorf did not bound its message: %d", len(got))
	}
}

func TestEncodeFailureShape(t *testing.T) {
	failure := &Failure{Code: CodeOwnership, Message: "mismatch", Retryable: false}
	var decoded Response
	if err := json.Unmarshal(EncodeFailure(failure), &decoded); err != nil {
		t.Fatalf("failure envelope is not valid JSON: %v", err)
	}
	if decoded.Ok {
		t.Error("failure envelope must not report success")
	}
	if decoded.Error == nil || decoded.Error.Code != CodeOwnership || decoded.Error.Message != "mismatch" {
		t.Errorf("unexpected failure detail: %+v", decoded.Error)
	}
	if decoded.Output != nil {
		t.Error("failure envelope must not carry output")
	}
}

// Retryable distinguishes a transient engine problem from a refusal the driver must
// not retry, such as an ownership mismatch.
func TestEncodeRetainsRetryable(t *testing.T) {
	var decoded Response
	if err := json.Unmarshal(EncodeFailure(&Failure{Code: CodeUnavailable, Message: "busy", Retryable: true}), &decoded); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	if decoded.Error == nil || !decoded.Error.Retryable {
		t.Error("retryable must survive encoding")
	}
}

func TestEncodeSuccessRoundTripsOutput(t *testing.T) {
	encoded, err := Encode(EnsureNetworkOutput{Created: true, Labels: LabelSet{"a": "b"}})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded Response
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	if !decoded.Ok || decoded.Error != nil {
		t.Errorf("unexpected envelope: %+v", decoded)
	}
	var output EnsureNetworkOutput
	if err := json.Unmarshal(decoded.Output, &output); err != nil {
		t.Fatalf("invalid output: %v", err)
	}
	if !output.Created || output.Labels["a"] != "b" {
		t.Errorf("output did not round-trip: %+v", output)
	}
}
