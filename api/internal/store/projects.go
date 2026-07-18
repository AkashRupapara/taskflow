package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"

	"taskflow/internal/domain"
)

// ProjectInput is the writable subset of a project (create/update).
type ProjectInput struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Metadata    json.RawMessage `json:"metadata"`
}

func (s *Store) ListProjects(ctx context.Context) ([]domain.Project, error) {
	s.cacheMu.RLock()
	if s.cacheValid {
		cached := s.projectsCache
		s.cacheMu.RUnlock()
		return cached, nil // cache hit
	}
	s.cacheMu.RUnlock()

	rows, err := s.pool.Query(ctx,
		`SELECT id, name, key, description, metadata, version, created_at
		 FROM projects ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	projects := []domain.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	s.cacheMu.Lock()
	s.projectsCache = projects
	s.cacheValid = true
	s.cacheMu.Unlock()
	return projects, nil
}

func (s *Store) GetProject(ctx context.Context, id string) (domain.Project, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, name, key, description, metadata, version, created_at FROM projects WHERE id = $1`, id)
	p, err := scanProject(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Project{}, ErrNotFound
	}
	return p, err
}

func (s *Store) CreateProject(ctx context.Context, in ProjectInput) (domain.Project, error) {
	if len(in.Metadata) == 0 {
		in.Metadata = json.RawMessage(`{}`)
	}
	row := s.pool.QueryRow(ctx,
		`INSERT INTO projects (name, key, description, metadata) VALUES ($1, $2, $3, $4)
		 RETURNING id, name, key, description, metadata, version, created_at`,
		in.Name, projectKey(in.Name), in.Description, in.Metadata)
	p, err := scanProject(row)
	if err == nil {
		s.invalidateProjects()
	}
	return p, err
}

// UpdateProject writes the new fields and records a project.updated event.
func (s *Store) UpdateProject(ctx context.Context, id string, in ProjectInput) (domain.Project, error) {
	if len(in.Metadata) == 0 {
		in.Metadata = json.RawMessage(`{}`)
	}
	var p domain.Project
	var ev domain.Event
	err := s.tx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx,
			`UPDATE projects SET name = $2, description = $3, metadata = $4 WHERE id = $1
			 RETURNING id, name, key, description, metadata, version, created_at`,
			id, in.Name, in.Description, in.Metadata)
		var err error
		if p, err = scanProject(row); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		ev, err = appendEvent(ctx, tx, id, domain.EventProjectUpdated, p, "")
		return err
	})
	if err != nil {
		return p, err
	}
	s.invalidateProjects() // name/description may have changed
	s.publish(ev)
	return p, nil
}

func (s *Store) DeleteProject(ctx context.Context, id string) error {
	// ON DELETE CASCADE removes tasks, comments, and events with the project.
	tag, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	s.invalidateProjects()
	return nil
}

// scanProject reads a project row from either a Row or Rows.
func scanProject(row pgx.Row) (domain.Project, error) {
	var p domain.Project
	err := row.Scan(&p.ID, &p.Name, &p.Key, &p.Description, &p.Metadata, &p.Version, &p.CreatedAt)
	return p, err
}

// projectKey derives a short uppercase code from a project name for task ids:
// initials of each word (e.g. "Website Redesign" -> "WR"), falling back to the
// first few alphanumerics if that yields too little.
func projectKey(name string) string {
	var initials strings.Builder
	for _, word := range strings.Fields(name) {
		for _, r := range word {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				initials.WriteRune(unicode.ToUpper(r))
				break
			}
		}
	}
	if key := initials.String(); len(key) >= 2 {
		if len(key) > 5 {
			key = key[:5]
		}
		return key
	}

	var b strings.Builder
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToUpper(r))
		}
		if b.Len() >= 3 {
			break
		}
	}
	if b.Len() == 0 {
		return "TSK"
	}
	return b.String()
}
