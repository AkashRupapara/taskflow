package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"taskflow/internal/domain"
)

// TaskInput creates a task. Optional fields default to sensible zero values.
type TaskInput struct {
	Title         string                   `json:"title"`
	Status        string                   `json:"status"`
	AssignedTo    []string                 `json:"assignedTo"`
	Configuration domain.TaskConfiguration `json:"configuration"`
	Dependencies  []string                 `json:"dependencies"`
}

// TaskPatch updates a task. Nil fields are left unchanged (partial update).
type TaskPatch struct {
	Title         *string                   `json:"title"`
	Status        *string                   `json:"status"`
	AssignedTo    *[]string                 `json:"assignedTo"`
	Configuration *domain.TaskConfiguration `json:"configuration"`
	Dependencies  *[]string                 `json:"dependencies"`
}

// Page is a cursor-paginated result. NextCursor is empty when there are no more.
type Page struct {
	Items      []domain.Task `json:"items"`
	NextCursor string        `json:"nextCursor"`
}

// ListTasks returns a keyset-paginated page of tasks ordered by (created_at, id).
// Keyset (not OFFSET) keeps paging O(1) no matter how deep the client scrolls,
// which is what makes 10k+ task boards viable.
func (s *Store) ListTasks(ctx context.Context, projectID string, limit int, cursor string) (Page, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	args := []any{projectID}
	where := "project_id = $1"
	if cursor != "" {
		ts, id, err := decodeCursor(cursor)
		if err != nil {
			return Page{}, err
		}
		// Rows strictly after the cursor position in the same ordering.
		where += " AND (created_at, id) > ($2, $3)"
		args = append(args, ts, id)
	}
	args = append(args, limit+1) // fetch one extra to know if there's a next page

	query := fmt.Sprintf(
		`SELECT id, project_id, title, status, assigned_to, configuration, dependencies, created_at
		 FROM tasks WHERE %s ORDER BY created_at, id LIMIT $%d`, where, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()

	tasks := []domain.Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return Page{}, err
		}
		tasks = append(tasks, t)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}

	page := Page{Items: tasks}
	if len(tasks) > limit { // the extra row means more pages exist
		last := tasks[limit-1]
		page.Items = tasks[:limit]
		page.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

func (s *Store) CreateTask(ctx context.Context, projectID string, in TaskInput) (domain.Task, error) {
	if in.Status == "" {
		in.Status = "todo"
	}
	if !domain.IsValidStatus(in.Status) {
		return domain.Task{}, ErrInvalidStatus
	}
	in.AssignedTo = orEmpty(in.AssignedTo)
	in.Dependencies = orEmpty(in.Dependencies)

	var t domain.Task
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if err := checkDependencies(ctx, tx, in.Status, in.Dependencies); err != nil {
			return err
		}
		cfg, _ := json.Marshal(in.Configuration)
		row := tx.QueryRow(ctx,
			`INSERT INTO tasks (project_id, title, status, assigned_to, configuration, dependencies)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id, project_id, title, status, assigned_to, configuration, dependencies, created_at`,
			projectID, in.Title, in.Status, in.AssignedTo, cfg, in.Dependencies)
		var err error
		if t, err = scanTask(row); err != nil {
			return err
		}
		_, err = appendEvent(ctx, tx, projectID, domain.EventTaskCreated, t, "")
		return err
	})
	return t, err
}

// UpdateTask applies a partial patch, validating status + dependencies, and
// records a task.updated event carrying the new task state (the delta).
func (s *Store) UpdateTask(ctx context.Context, id string, patch TaskPatch) (domain.Task, error) {
	var t domain.Task
	err := s.tx(ctx, func(tx pgx.Tx) error {
		// Load current state (locked) so we can merge the patch onto it.
		row := tx.QueryRow(ctx,
			`SELECT id, project_id, title, status, assigned_to, configuration, dependencies, created_at
			 FROM tasks WHERE id = $1 FOR UPDATE`, id)
		cur, err := scanTask(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		if patch.Title != nil {
			cur.Title = *patch.Title
		}
		if patch.Status != nil {
			if !domain.IsValidStatus(*patch.Status) {
				return ErrInvalidStatus
			}
			cur.Status = *patch.Status
		}
		if patch.AssignedTo != nil {
			cur.AssignedTo = *patch.AssignedTo
		}
		if patch.Configuration != nil {
			cur.Configuration = *patch.Configuration
		}
		if patch.Dependencies != nil {
			cur.Dependencies = *patch.Dependencies
		}
		if err := checkDependencies(ctx, tx, cur.Status, cur.Dependencies); err != nil {
			return err
		}

		cfg, _ := json.Marshal(cur.Configuration)
		row = tx.QueryRow(ctx,
			`UPDATE tasks SET title=$2, status=$3, assigned_to=$4, configuration=$5, dependencies=$6
			 WHERE id=$1
			 RETURNING id, project_id, title, status, assigned_to, configuration, dependencies, created_at`,
			id, cur.Title, cur.Status, orEmpty(cur.AssignedTo), cfg, orEmpty(cur.Dependencies))
		if t, err = scanTask(row); err != nil {
			return err
		}
		_, err = appendEvent(ctx, tx, t.ProjectID, domain.EventTaskUpdated, t, "")
		return err
	})
	return t, err
}

func (s *Store) DeleteTask(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		var projectID string
		err := tx.QueryRow(ctx, `DELETE FROM tasks WHERE id = $1 RETURNING project_id`, id).Scan(&projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		_, err = appendEvent(ctx, tx, projectID, domain.EventTaskDeleted, map[string]string{"id": id}, "")
		return err
	})
}

// checkDependencies enforces that a task entering in_progress/done has all of
// its dependency tasks already done.
func checkDependencies(ctx context.Context, tx pgx.Tx, status string, deps []string) error {
	if !domain.StatusNeedsDependencies(status) || len(deps) == 0 {
		return nil
	}
	var unmet int
	err := tx.QueryRow(ctx,
		`SELECT count(*) FROM tasks WHERE id = ANY($1) AND status <> 'done'`, deps,
	).Scan(&unmet)
	if err != nil {
		return err
	}
	if unmet > 0 {
		return ErrDependencyNotMet
	}
	return nil
}

func scanTask(row pgx.Row) (domain.Task, error) {
	var t domain.Task
	var cfg []byte
	err := row.Scan(&t.ID, &t.ProjectID, &t.Title, &t.Status, &t.AssignedTo, &cfg, &t.Dependencies, &t.CreatedAt)
	if err != nil {
		return t, err
	}
	if len(cfg) > 0 {
		_ = json.Unmarshal(cfg, &t.Configuration)
	}
	return t, nil
}

// Cursor helpers: encode the last row's (created_at, id) as an opaque token.
func encodeCursor(ts time.Time, id string) string {
	raw := ts.UTC().Format(time.RFC3339Nano) + "|" + id
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(cursor string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("bad cursor")
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return time.Time{}, "", fmt.Errorf("bad cursor")
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, "", fmt.Errorf("bad cursor")
	}
	return ts, parts[1], nil
}

// orEmpty normalizes a nil slice to an empty one so Postgres stores '{}' not NULL.
func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
