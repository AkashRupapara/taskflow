package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"taskflow/internal/domain"
)

func (s *Store) ListComments(ctx context.Context, taskID string) ([]domain.Comment, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, task_id, content, author, created_at
		 FROM comments WHERE task_id = $1 ORDER BY created_at ASC`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	comments := []domain.Comment{}
	for rows.Next() {
		var c domain.Comment
		if err := rows.Scan(&c.ID, &c.TaskID, &c.Content, &c.Author, &c.CreatedAt); err != nil {
			return nil, err
		}
		comments = append(comments, c)
	}
	return comments, rows.Err()
}

// AddComment inserts a comment and records a comment.added event on the task's
// project (looked up from the task) so subscribers see the new comment.
func (s *Store) AddComment(ctx context.Context, taskID, content, author string) (domain.Comment, error) {
	var c domain.Comment
	var ev domain.Event
	err := s.tx(ctx, func(tx pgx.Tx) error {
		var projectID string
		err := tx.QueryRow(ctx, `SELECT project_id FROM tasks WHERE id = $1`, taskID).Scan(&projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		row := tx.QueryRow(ctx,
			`INSERT INTO comments (task_id, content, author) VALUES ($1, $2, $3)
			 RETURNING id, task_id, content, author, created_at`,
			taskID, content, author)
		if err := row.Scan(&c.ID, &c.TaskID, &c.Content, &c.Author, &c.CreatedAt); err != nil {
			return err
		}
		ev, err = s.appendEvent(ctx, tx, projectID, domain.EventCommentAdded, c, author)
		return err
	})
	if err != nil {
		return c, err
	}
	s.publish(ev)
	return c, nil
}
