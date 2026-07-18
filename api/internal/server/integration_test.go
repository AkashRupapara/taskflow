package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"taskflow/internal/db"
	"taskflow/internal/server"
	"taskflow/internal/store"
)

// These integration tests run against a real Postgres. Set TEST_DATABASE_URL
// (or DATABASE_URL) to enable them; they are skipped otherwise so `go test`
// still passes in environments without a database.
func newTestClient(t *testing.T) *client {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL or DATABASE_URL to run integration tests")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	srv := httptest.NewServer(server.New(store.New(pool)).Routes())
	t.Cleanup(func() {
		srv.Close()
		pool.Close()
	})
	return &client{t: t, base: srv.URL}
}

type client struct {
	t    *testing.T
	base string
}

// do sends a request and returns the status code plus decoded JSON body.
func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return resp.StatusCode, out
}

// newProject creates a project and registers cleanup, returning its id.
func (c *client) newProject(name string) string {
	code, body := c.do("POST", "/api/projects", map[string]any{"name": name})
	if code != http.StatusCreated {
		c.t.Fatalf("create project: got %d", code)
	}
	id := body["id"].(string)
	c.t.Cleanup(func() { c.do("DELETE", "/api/projects/"+id, nil) })
	return id
}

func (c *client) newTask(projectID string, task map[string]any) string {
	code, body := c.do("POST", "/api/projects/"+projectID+"/tasks", task)
	if code != http.StatusCreated {
		c.t.Fatalf("create task: got %d (%v)", code, body)
	}
	return body["id"].(string)
}

func TestProjectAndTaskLifecycle(t *testing.T) {
	c := newTestClient(t)

	_, proj := c.do("POST", "/api/projects", map[string]any{"name": "Integration Test"})
	pid := proj["id"].(string)
	t.Cleanup(func() { c.do("DELETE", "/api/projects/"+pid, nil) })

	if proj["key"] == "" || proj["key"] == nil {
		t.Errorf("expected a generated project key, got %v", proj["key"])
	}

	// First task in a project should be number 1.
	code, task := c.do("POST", "/api/projects/"+pid+"/tasks", map[string]any{"title": "First"})
	if code != http.StatusCreated {
		t.Fatalf("create task: %d", code)
	}
	if task["number"].(float64) != 1 {
		t.Errorf("expected task number 1, got %v", task["number"])
	}

	tid := task["id"].(string)
	if code, _ := c.do("PATCH", "/api/tasks/"+tid, map[string]any{"title": "Renamed"}); code != http.StatusOK {
		t.Errorf("update task: %d", code)
	}
	if code, _ := c.do("DELETE", "/api/tasks/"+tid, nil); code != http.StatusOK {
		t.Errorf("delete task: %d", code)
	}
}

func TestDependencyEnforcement(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Deps Test")

	a := c.newTask(pid, map[string]any{"title": "A"})
	b := c.newTask(pid, map[string]any{"title": "B", "dependencies": []string{a}})

	// B can't be closed while A is open.
	if code, _ := c.do("PATCH", "/api/tasks/"+b, map[string]any{"status": "done"}); code != http.StatusConflict {
		t.Errorf("closing B with open blocker: got %d, want 409", code)
	}
	// Close A, then B can close.
	if code, _ := c.do("PATCH", "/api/tasks/"+a, map[string]any{"status": "done"}); code != http.StatusOK {
		t.Fatalf("close A: %d", code)
	}
	if code, _ := c.do("PATCH", "/api/tasks/"+b, map[string]any{"status": "done"}); code != http.StatusOK {
		t.Errorf("close B after A done: got %d, want 200", code)
	}
}

func TestOptimisticConcurrency(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Concurrency Test")
	id := c.newTask(pid, map[string]any{"title": "Shared"})

	// Client A writes with the rev it read (0) and wins.
	code, updated := c.do("PATCH", "/api/tasks/"+id, map[string]any{
		"title": "Edited by A", "expectedRev": 0,
	})
	if code != http.StatusOK {
		t.Fatalf("first write: got %d, want 200", code)
	}
	if updated["rev"].(float64) != 1 {
		t.Errorf("expected rev to bump to 1, got %v", updated["rev"])
	}

	// Client B still holds rev 0 - its write must be rejected, not clobber A.
	if code, _ := c.do("PATCH", "/api/tasks/"+id, map[string]any{
		"title": "Edited by B", "expectedRev": 0,
	}); code != http.StatusConflict {
		t.Errorf("stale write: got %d, want 409", code)
	}

	// After refreshing to rev 1 it succeeds.
	if code, _ := c.do("PATCH", "/api/tasks/"+id, map[string]any{
		"title": "Edited by B", "expectedRev": 1,
	}); code != http.StatusOK {
		t.Errorf("retry after refresh: got %d, want 200", code)
	}

	// Omitting expectedRev opts out of the check (backwards compatible).
	if code, _ := c.do("PATCH", "/api/tasks/"+id, map[string]any{"title": "No rev"}); code != http.StatusOK {
		t.Errorf("write without expectedRev: got %d, want 200", code)
	}
}

func TestManualOrdering(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Ordering Test")

	// Created tasks land at the end, so the initial order is creation order.
	a := c.newTask(pid, map[string]any{"title": "A"})
	c.newTask(pid, map[string]any{"title": "B"})
	last := c.newTask(pid, map[string]any{"title": "C"})

	titles := func() []string {
		_, page := c.do("GET", "/api/projects/"+pid+"/tasks?limit=50", nil)
		var out []string
		for _, it := range page["items"].([]any) {
			out = append(out, it.(map[string]any)["title"].(string))
		}
		return out
	}
	if got := titles(); !reflect.DeepEqual(got, []string{"A", "B", "C"}) {
		t.Fatalf("initial order = %v, want [A B C]", got)
	}

	// Move C between A and B by giving it the midpoint position (one row changes).
	_, taskA := c.do("PATCH", "/api/tasks/"+a, map[string]any{}) // read A's position
	posA := taskA["position"].(float64)
	if code, _ := c.do("PATCH", "/api/tasks/"+last, map[string]any{"position": posA + 0.5}); code != http.StatusOK {
		t.Fatalf("reorder: got %d", code)
	}
	if got := titles(); !reflect.DeepEqual(got, []string{"A", "C", "B"}) {
		t.Errorf("after moving C up: %v, want [A C B]", got)
	}

	// Keyset pagination must follow the same (position, id) ordering.
	_, p1 := c.do("GET", "/api/projects/"+pid+"/tasks?limit=2", nil)
	cursor := p1["nextCursor"].(string)
	if cursor == "" {
		t.Fatal("expected a next cursor")
	}
	_, p2 := c.do("GET", "/api/projects/"+pid+"/tasks?limit=2&cursor="+cursor, nil)
	if items := p2["items"].([]any); len(items) != 1 ||
		items[0].(map[string]any)["title"] != "B" {
		t.Errorf("second page should contain only B, got %v", items)
	}
}

func TestActorAttribution(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Actor Test")

	req, _ := http.NewRequest("POST", c.base+"/api/projects/"+pid+"/tasks",
		bytes.NewReader([]byte(`{"title":"Attributed"}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Actor", "Akash")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create with actor: %v", err)
	}
	resp.Body.Close()

	eventsReq, _ := http.NewRequest("GET", c.base+"/api/projects/"+pid+"/events?since=0", nil)
	eventsResp, err := http.DefaultClient.Do(eventsReq)
	if err != nil {
		t.Fatalf("events request: %v", err)
	}
	defer eventsResp.Body.Close()
	var events []map[string]any
	_ = json.NewDecoder(eventsResp.Body).Decode(&events)

	if len(events) == 0 || events[0]["actor"] != "Akash" {
		t.Errorf("expected event actor 'Akash', got %v", events)
	}
}

func TestCycleGuard(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Cycle Test")

	a := c.newTask(pid, map[string]any{"title": "A"})
	b := c.newTask(pid, map[string]any{"title": "B", "dependencies": []string{a}})

	// Making A depend on B would create A->B->A.
	if code, _ := c.do("PATCH", "/api/tasks/"+a, map[string]any{"dependencies": []string{b}}); code != http.StatusConflict {
		t.Errorf("cyclic dependency: got %d, want 409", code)
	}
}

func TestCursorPagination(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Paging Test")
	for i := 0; i < 5; i++ {
		c.newTask(pid, map[string]any{"title": "T"})
	}

	seen := 0
	cursor := ""
	pages := 0
	for {
		_, page := c.do("GET", "/api/projects/"+pid+"/tasks?limit=2&cursor="+cursor, nil)
		items := page["items"].([]any)
		seen += len(items)
		pages++
		cursor, _ = page["nextCursor"].(string)
		if cursor == "" {
			break
		}
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
	}
	if seen != 5 {
		t.Errorf("paginated %d tasks across %d pages, want 5", seen, pages)
	}
	if pages != 3 { // 2 + 2 + 1
		t.Errorf("expected 3 pages for 5 items at limit 2, got %d", pages)
	}
}

func TestEventsFeed(t *testing.T) {
	c := newTestClient(t)
	pid := c.newProject("Events Test")
	c.newTask(pid, map[string]any{"title": "Logged"})

	req, _ := http.NewRequest("GET", c.base+"/api/projects/"+pid+"/events?since=0", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("events request: %v", err)
	}
	defer resp.Body.Close()
	var events []map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&events)

	if len(events) == 0 || events[0]["type"] != "task.created" {
		t.Errorf("expected a task.created event, got %v", events)
	}
	if events[0]["version"].(float64) != 1 {
		t.Errorf("expected first event version 1, got %v", events[0]["version"])
	}
}
