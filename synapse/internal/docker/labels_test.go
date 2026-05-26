package docker

import "testing"

// Bloco 12.6 — provisioned containers must carry synapse.deployment_id (UUID)
// + synapse.project_id so the Cell Control Plane can correlate them, while
// keeping the legacy synapse.deployment (name) label. No secrets in labels.

func TestMergeLabels_StampsUUIDsKeepsLegacy(t *testing.T) {
	got := mergeLabels(map[string]string{
		"synapse.managed":    "true",
		"synapse.deployment": "lush-heron-4656",
	}, "dep-uuid-123", "proj-uuid-456")

	if got["synapse.deployment_id"] != "dep-uuid-123" {
		t.Errorf("synapse.deployment_id = %q, want dep-uuid-123", got["synapse.deployment_id"])
	}
	if got["synapse.project_id"] != "proj-uuid-456" {
		t.Errorf("synapse.project_id = %q, want proj-uuid-456", got["synapse.project_id"])
	}
	if got["synapse.deployment"] != "lush-heron-4656" {
		t.Errorf("legacy synapse.deployment label must be preserved, got %q", got["synapse.deployment"])
	}
	if got["synapse.managed"] != "true" {
		t.Errorf("synapse.managed must be preserved")
	}
	// Defense-in-depth: no secret-shaped label keys were introduced.
	for k := range got {
		for _, bad := range []string{"secret", "token", "password", "admin", "env", "url", "database"} {
			if containsCI(k, bad) {
				t.Errorf("label key %q looks sensitive — labels must never carry secrets", k)
			}
		}
	}
}

func TestMergeLabels_OmitsEmptyIDs(t *testing.T) {
	// A legacy/empty-id caller must NOT get empty synapse.deployment_id /
	// synapse.project_id keys (which would confuse the drift correlation).
	got := mergeLabels(map[string]string{"synapse.managed": "true"}, "", "")
	if _, ok := got["synapse.deployment_id"]; ok {
		t.Errorf("empty deploymentID must be omitted, got %v", got)
	}
	if _, ok := got["synapse.project_id"]; ok {
		t.Errorf("empty projectID must be omitted, got %v", got)
	}
}

func containsCI(s, sub string) bool {
	ls, lsub := []rune(s), []rune(sub)
	low := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return r
	}
	for i := 0; i+len(lsub) <= len(ls); i++ {
		ok := true
		for j := range lsub {
			if low(ls[i+j]) != low(lsub[j]) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}
