package domain

import "testing"

func TestIsValidStatus(t *testing.T) {
	valid := []string{"todo", "in_progress", "done"}
	for _, s := range valid {
		if !IsValidStatus(s) {
			t.Errorf("expected %q to be valid", s)
		}
	}
	invalid := []string{"", "TODO", "closed", "in-progress", "backlog"}
	for _, s := range invalid {
		if IsValidStatus(s) {
			t.Errorf("expected %q to be invalid", s)
		}
	}
}

func TestStatusNeedsDependencies(t *testing.T) {
	// Only closing (done) is gated on dependencies; earlier statuses are free.
	if !StatusNeedsDependencies("done") {
		t.Error("done should require dependencies to be met")
	}
	for _, s := range []string{"todo", "in_progress", ""} {
		if StatusNeedsDependencies(s) {
			t.Errorf("%q should not require dependencies", s)
		}
	}
}
