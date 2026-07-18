package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

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
// ExpectedRev opts into optimistic concurrency: if set and it no longer matches
// the task's current rev, someone else changed it first and we reject the write
// rather than silently overwriting them.
type TaskPatch struct {
	Title         *string                   `json:"title"`
	Status        *string                   `json:"status"`
	AssignedTo    *[]string                 `json:"assignedTo"`
	Configuration *domain.TaskConfiguration `json:"configuration"`
	Dependencies  *[]string                 `json:"dependencies"`
	ExpectedRev   *int                      `json:"expectedRev"`
	Position      *float64                  `json:"position"` // fractional rank (manual reorder)
}

// Page is a cursor-paginated result. NextCursor is empty when there are no more.
type Page struct {
	Items      []domain.Task `json:"items"`
	NextCursor string        `json:"nextCursor"`
}

// ListTasks returns a keyset-paginated page of tasks ordered by (position, id),
// i.e. the project's manual ordering used by the backlog view.
// Keyset (not OFFSET) keeps paging O(1) no matter how deep the client scrolls,
// which is what makes 10k+ task boards viable.
func (s *Store) ListTasks(ctx context.Context, projectID string, limit int, cursor string) (Page, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	args := []any{projectID}
	where := "project_id = $1"
	if cursor != "" {
		pos, id, err := decodeCursor(cursor)
		if err != nil {
			return Page{}, err
		}
		// Rows strictly after the cursor position in the same ordering.
		where += " AND (position, id) > ($2, $3)"
		args = append(args, pos, id)
	}
	args = append(args, limit+1) // fetch one extra to know if there's a next page

	query := fmt.Sprintf(
		`SELECT id, project_id, title, status, assigned_to, configuration, dependencies, created_at, number, rev, position
		 FROM tasks WHERE %s ORDER BY position, id LIMIT $%d`, where, len(args))

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
		page.NextCursor = encodeCursor(last.Position, last.ID)
	}
	return page, nil
}

func (s *Store) CreateTask(ctx context.Context, projectID string, in TaskInput, actor string) (domain.Task, error) {
	if in.Status == "" {
		in.Status = "todo"
	}
	if !domain.IsValidStatus(in.Status) {
		return domain.Task{}, ErrInvalidStatus
	}
	in.AssignedTo = orEmpty(in.AssignedTo)
	in.Dependencies = orEmpty(in.Dependencies)

	var t domain.Task
	var ev domain.Event
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if err := checkDependencies(ctx, tx, in.Status, in.Dependencies); err != nil {
			return err
		}
		// Claim the next per-project task number (locks the project row too).
		var number int64
		err := tx.QueryRow(ctx,
			`UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq`,
			projectID).Scan(&number)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		// New tasks land at the end of the project's manual ordering.
		var nextPos float64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE project_id = $1`,
			projectID).Scan(&nextPos); err != nil {
			return err
		}

		cfg, _ := json.Marshal(in.Configuration)
		row := tx.QueryRow(ctx,
			`INSERT INTO tasks (project_id, number, title, status, assigned_to, configuration, dependencies, position)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING id, project_id, title, status, assigned_to, configuration, dependencies, created_at, number, rev, position`,
			projectID, number, in.Title, in.Status, in.AssignedTo, cfg, in.Dependencies, nextPos)
		if t, err = scanTask(row); err != nil {
			return err
		}
		ev, err = s.appendEvent(ctx, tx, projectID, domain.EventTaskCreated, t, actor)
		return err
	})
	if err != nil {
		return t, err
	}
	s.publish(ev)
	return t, nil
}

// UpdateTask applies a partial patch, validating status + dependencies, and
// records a task.updated event carrying the new task state (the delta).
func (s *Store) UpdateTask(ctx context.Context, id string, patch TaskPatch, actor string) (domain.Task, error) {
	var t domain.Task
	var ev domain.Event
	err := s.tx(ctx, func(tx pgx.Tx) error {
		// Load current state (locked) so we can merge the patch onto it.
		row := tx.QueryRow(ctx,
			`SELECT id, project_id, title, status, assigned_to, configuration, dependencies, created_at, number, rev, position
			 FROM tasks WHERE id = $1 FOR UPDATE`, id)
		cur, err := scanTask(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		// Optimistic concurrency: reject if the task moved on since the client read it.
		if patch.ExpectedRev != nil && *patch.ExpectedRev != cur.Rev {
			return ErrStaleWrite
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
		if patch.Position != nil {
			cur.Position = *patch.Position
		}
		if patch.Dependencies != nil {
			cur.Dependencies = *patch.Dependencies
			cyclic, err := wouldCreateCycle(ctx, tx, id, cur.Dependencies)
			if err != nil {
				return err
			}
			if cyclic {
				return ErrDependencyCycle
			}
		}
		if err := checkDependencies(ctx, tx, cur.Status, cur.Dependencies); err != nil {
			return err
		}

		cfg, _ := json.Marshal(cur.Configuration)
		row = tx.QueryRow(ctx,
			`UPDATE tasks SET title=$2, status=$3, assigned_to=$4, configuration=$5, dependencies=$6,
			        position=$7, rev = rev + 1
			 WHERE id=$1
			 RETURNING id, project_id, title, status, assigned_to, configuration, dependencies, created_at, number, rev, position`,
			id, cur.Title, cur.Status, orEmpty(cur.AssignedTo), cfg, orEmpty(cur.Dependencies), cur.Position)
		if t, err = scanTask(row); err != nil {
			return err
		}
		ev, err = s.appendEvent(ctx, tx, t.ProjectID, domain.EventTaskUpdated, t, actor)
		return err
	})
	if err != nil {
		return t, err
	}
	s.publish(ev)
	return t, nil
}

func (s *Store) DeleteTask(ctx context.Context, id string, actor string) error {
	var ev domain.Event
	err := s.tx(ctx, func(tx pgx.Tx) error {
		var projectID string
		err := tx.QueryRow(ctx, `DELETE FROM tasks WHERE id = $1 RETURNING project_id`, id).Scan(&projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		ev, err = s.appendEvent(ctx, tx, projectID, domain.EventTaskDeleted, map[string]string{"id": id}, actor)
		return err
	})
	if err != nil {
		return err
	}
	s.publish(ev)
	return nil
}

// wouldCreateCycle reports whether making taskID depend on deps introduces a
// cycle - i.e. taskID is reachable by following the dependency edges out of
// deps. A recursive CTE walks the graph in the database in one round-trip.
func wouldCreateCycle(ctx context.Context, tx pgx.Tx, taskID string, deps []string) (bool, error) {
	if len(deps) == 0 {
		return false, nil
	}
	for _, d := range deps {
		if d == taskID {
			return true, nil // direct self-dependency
		}
	}
	var cycle bool
	err := tx.QueryRow(ctx, `
		WITH RECURSIVE reach(id) AS (
			SELECT unnest($1::text[])
			UNION
			SELECT unnest(t.dependencies)
			FROM tasks t JOIN reach r ON t.id::text = r.id
		)
		SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2)`,
		deps, taskID).Scan(&cycle)
	return cycle, err
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
	err := row.Scan(&t.ID, &t.ProjectID, &t.Title, &t.Status, &t.AssignedTo, &cfg, &t.Dependencies, &t.CreatedAt, &t.Number, &t.Rev, &t.Position)
	if err != nil {
		return t, err
	}
	if len(cfg) > 0 {
		_ = json.Unmarshal(cfg, &t.Configuration)
	}
	return t, nil
}

// Cursor helpers: encode the last row's (position, id) as an opaque token, which
// matches the list's ORDER BY so paging stays a keyset scan.
func encodeCursor(position float64, id string) string {
	raw := strconv.FormatFloat(position, 'g', 17, 64) + "|" + id
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(cursor string) (float64, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, "", fmt.Errorf("bad cursor")
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return 0, "", fmt.Errorf("bad cursor")
	}
	pos, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0, "", fmt.Errorf("bad cursor")
	}
	return pos, parts[1], nil
}

// orEmpty normalizes a nil slice to an empty one so Postgres stores '{}' not NULL.
func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
