package store

import (
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	ts := time.Date(2026, 7, 17, 10, 30, 0, 123456789, time.UTC)
	id := "3788b96c-3027-48e1-af29-5730c7ccc556"

	cursor := encodeCursor(ts, id)
	if cursor == "" {
		t.Fatal("encodeCursor returned empty string")
	}

	gotTS, gotID, err := decodeCursor(cursor)
	if err != nil {
		t.Fatalf("decodeCursor: %v", err)
	}
	if !gotTS.Equal(ts) {
		t.Errorf("timestamp mismatch: got %v want %v", gotTS, ts)
	}
	if gotID != id {
		t.Errorf("id mismatch: got %q want %q", gotID, id)
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"not-base64!!", "", "aGVsbG8"} { // last is valid b64 but no separator
		if _, _, err := decodeCursor(bad); err == nil {
			t.Errorf("expected error for cursor %q", bad)
		}
	}
}

func TestProjectKey(t *testing.T) {
	cases := map[string]string{
		"Website Redesign": "WR",
		"Mobile App":       "MA",
		"Q3 Launch Plan":   "QLP", // digits count as leading chars too
		"Backend":          "BAC", // single word -> first 3 letters
		"a":                "A",
		"":                 "TSK", // fallback
		"!!!":              "TSK", // no alphanumerics -> fallback
	}
	for name, want := range cases {
		if got := projectKey(name); got != want {
			t.Errorf("projectKey(%q) = %q, want %q", name, got, want)
		}
	}
}
