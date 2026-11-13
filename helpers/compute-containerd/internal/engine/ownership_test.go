package engine

import (
	"fmt"
	"testing"

	"github.com/containerd/nerdctl/v2/pkg/cmd/container"

	"github.com/openclaw/openclaw-enterprise/helpers/compute-containerd/internal/protocol"
)

// Ownership refusal is a security boundary: a mismatch must stop the operation
// rather than adopt or mutate a resource that belongs to another installation.
func TestCompareLabelsRefusesMismatchAndEmptyExpectation(t *testing.T) {
	stored := protocol.LabelSet{
		"org.openclaw.enterprise.namespace": "ns-1",
		"org.openclaw.enterprise.kind":      "agent",
	}

	if err := compareLabels(stored, protocol.LabelSet{
		"org.openclaw.enterprise.namespace": "ns-1",
	}); err != nil {
		t.Errorf("a matching subset must be accepted: %v", err)
	}

	failure, ok := compareLabels(stored, protocol.LabelSet{
		"org.openclaw.enterprise.namespace": "ns-2",
	}).(*protocol.Failure)
	if !ok || failure.Code != protocol.CodeOwnership {
		t.Fatalf("mismatch must be an ownership failure, got %v", failure)
	}
	if failure.Retryable {
		t.Error("an ownership mismatch must not be retryable")
	}

	// An omitted expectation must fail closed: it would otherwise authorise any
	// resource with the same name.
	if _, ok := compareLabels(stored, protocol.LabelSet{}).(*protocol.Failure); !ok {
		t.Error("an empty expectation must be refused")
	}
	if _, ok := compareLabels(stored, nil).(*protocol.Failure); !ok {
		t.Error("a nil expectation must be refused")
	}
}

func TestMatchesSelector(t *testing.T) {
	labels := protocol.LabelSet{
		"org.openclaw.enterprise.namespace": "ns-1",
		"org.openclaw.enterprise.kind":      "agent",
	}
	cases := []struct {
		selector string
		want     bool
	}{
		{"", true},
		{"org.openclaw.enterprise.kind=agent", true},
		{"org.openclaw.enterprise.kind=gateway", false},
		{"org.openclaw.enterprise.namespace=ns-1,org.openclaw.enterprise.kind=agent", true},
		{"org.openclaw.enterprise.namespace=ns-1,org.openclaw.enterprise.kind=gateway", false},
		{"org.openclaw.enterprise.kind", true},
		{"org.openclaw.enterprise.missing", false},
	}
	for _, testCase := range cases {
		if got := matchesSelector(labels, testCase.selector); got != testCase.want {
			t.Errorf("selector %q: got %v, want %v", testCase.selector, got, testCase.want)
		}
	}
}

func TestSplitNamesAndLookup(t *testing.T) {
	names := splitNames("/oce-agent-1,oce-agent-1-alias")
	if len(names) != 2 || names[0] != "oce-agent-1" || names[1] != "oce-agent-1-alias" {
		t.Errorf("unexpected names: %v", names)
	}
	if len(splitNames("")) != 0 {
		t.Error("an empty name column must yield no names")
	}
	item := container.ListItem{Names: "oce-agent-1"}
	if !hasName(item, "oce-agent-1") || hasName(item, "oce-other") {
		t.Error("name lookup must match exactly")
	}
}

// The list entry carries both a rendered label string and a structured map, and the
// map is excluded from JSON. Reading the wrong one silently loses ownership data.
func TestItemLabelsPrefersStructuredMap(t *testing.T) {
	item := container.ListItem{
		Labels:    "stale=value",
		LabelsMap: map[string]string{"org.openclaw.enterprise.kind": "agent"},
	}
	labels := itemLabels(item)
	if labels["org.openclaw.enterprise.kind"] != "agent" {
		t.Errorf("structured labels must win: %v", labels)
	}
	if _, stale := labels["stale"]; stale {
		t.Error("the rendered string must not be merged in")
	}

	fallback := itemLabels(container.ListItem{Labels: "a=1,b=2"})
	if fallback["a"] != "1" || fallback["b"] != "2" {
		t.Errorf("rendered labels must still parse: %v", fallback)
	}
}

// A create failure is the only place the owning container ID appears, because the
// name store has no lookup.
func TestReservedIDFromError(t *testing.T) {
	message := `name-store error: name "oce-agent-1" is already used by ID "77ba723f7f097cf2f72bb11e9d507a32faa17b88af945a0305cd3c55c2d360ef"`
	if got := reservedIDFromError(fmt.Errorf("%s", message)); got != "77ba723f7f097cf2f72bb11e9d507a32faa17b88af945a0305cd3c55c2d360ef" {
		t.Errorf("owner id: got %q", got)
	}
	if got := reservedIDFromError(fmt.Errorf("some other failure")); got != "" {
		t.Errorf("unrelated failures must not yield an id: %q", got)
	}
	if got := reservedIDFromError(nil); got != "" {
		t.Errorf("nil error must yield no id: %q", got)
	}
}
