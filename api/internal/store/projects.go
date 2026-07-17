package store

import (
	"context"
	"encoding/json"
	"errors"

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
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, description, metadata, version, created_at
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
	return projects, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id string) (domain.Project, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, name, description, metadata, version, created_at FROM projects WHERE id = $1`, id)
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
		`INSERT INTO projects (name, description, metadata) VALUES ($1, $2, $3)
		 RETURNING id, name, description, metadata, version, created_at`,
		in.Name, in.Description, in.Metadata)
	return scanProject(row)
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
			 RETURNING id, name, description, metadata, version, created_at`,
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
	return nil
}

// scanProject reads a project row from either a Row or Rows.
func scanProject(row pgx.Row) (domain.Project, error) {
	var p domain.Project
	err := row.Scan(&p.ID, &p.Name, &p.Description, &p.Metadata, &p.Version, &p.CreatedAt)
	return p, err
}
