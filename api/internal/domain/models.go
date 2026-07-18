// Package domain holds the core types and the small amount of business logic
// (status transitions, dependency rules) that the store enforces on every write.
package domain

import (
	"encoding/json"
	"time"
)

type Project struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Key         string          `json:"key"` // short code, e.g. WR (for task ids like WR-1)
	Description string          `json:"description"`
	Metadata    json.RawMessage `json:"metadata"`
	Version     int64           `json:"version"` // last applied event version
	CreatedAt   time.Time       `json:"createdAt"`
}

// TaskConfiguration is the PDF's {priority, description, tags[], customFields}.
type TaskConfiguration struct {
	Priority     string            `json:"priority"`
	Description  string            `json:"description"`
	Tags         []string          `json:"tags"`
	CustomFields map[string]any    `json:"customFields"`
}

type Task struct {
	ID            string            `json:"id"`
	ProjectID     string            `json:"projectId"`
	Number        int64             `json:"number"` // sequential per project; display id is project.key-number
	Title         string            `json:"title"`
	Status        string            `json:"status"`
	AssignedTo    []string          `json:"assignedTo"`
	Configuration TaskConfiguration `json:"configuration"`
	Dependencies  []string          `json:"dependencies"`
	CreatedAt     time.Time         `json:"createdAt"`
	Rev           int               `json:"rev"`      // bumped on every update; used for optimistic concurrency
	Position      float64           `json:"position"` // fractional rank for manual ordering (backlog)
}

type Comment struct {
	ID        string    `json:"id"`
	TaskID    string    `json:"taskId"`
	Content   string    `json:"content"`
	Author    string    `json:"author"`
	CreatedAt time.Time `json:"createdAt"`
}

// Event is one entry in the append-only log. Payload carries the delta (e.g. the
// single changed task), never the whole project.
type Event struct {
	ID        int64           `json:"id"`
	ProjectID string          `json:"projectId"`
	Version   int64           `json:"version"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Actor     string          `json:"actor"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Event type constants broadcast to clients (used by Phase 2's WebSocket layer).
const (
	EventTaskCreated    = "task.created"
	EventTaskUpdated    = "task.updated"
	EventTaskDeleted    = "task.deleted"
	EventCommentAdded   = "comment.added"
	EventProjectUpdated = "project.updated"
)

// Valid task statuses and the transitions allowed between them.
var validStatuses = map[string]bool{
	"todo":        true,
	"in_progress": true,
	"done":        true,
}

func IsValidStatus(s string) bool { return validStatuses[s] }

// StatusNeedsDependencies reports whether moving into this status requires all
// dependencies to be done first. A task cannot be closed (done) while any of its
// blockers are still open; earlier statuses are always allowed.
func StatusNeedsDependencies(s string) bool {
	return s == "done"
}
