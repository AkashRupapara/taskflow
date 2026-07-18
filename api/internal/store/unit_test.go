package store

import "testing"

func TestCursorRoundTrip(t *testing.T) {
	// Fractional positions must survive the round trip exactly, otherwise paging
	// could skip or repeat a row sitting between two closely-ranked neighbours.
	for _, pos := range []float64{1, 2.5, 1.0000000000000002, 1234567.75} {
		id := "3788b96c-3027-48e1-af29-5730c7ccc556"
		gotPos, gotID, err := decodeCursor(encodeCursor(pos, id))
		if err != nil {
			t.Fatalf("decodeCursor(%v): %v", pos, err)
		}
		if gotPos != pos {
			t.Errorf("position mismatch: got %v want %v", gotPos, pos)
		}
		if gotID != id {
			t.Errorf("id mismatch: got %q want %q", gotID, id)
		}
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
