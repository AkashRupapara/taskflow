// Package store is the data layer. Every mutation runs in a transaction that
// updates the read model AND appends to the event log atomically, so the two
// never drift. appendEvent also bumps the project version that clients use to
// catch up after a disconnect (Phase 2).
package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"taskflow/internal/domain"
)

// Sentinel errors the HTTP layer maps to status codes.
var (
	ErrNotFound         = errors.New("not found")
	ErrInvalidStatus    = errors.New("invalid status")
	ErrDependencyNotMet = errors.New("dependencies not done")
	ErrDependencyCycle  = errors.New("dependency would create a cycle")
)

// Publisher receives events after their transaction commits, so subscribers
// never see a change that was rolled back. The WebSocket hub implements it.
type Publisher interface {
	Publish(domain.Event)
}

type Store struct {
	pool      *pgxpool.Pool
	publisher Publisher

	// Read-through cache for the project list (hit on every sidebar load,
	// changes rarely). Invalidated on any project create/update/delete.
	cacheMu       sync.RWMutex
	projectsCache []domain.Project
	cacheValid    bool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// invalidateProjects drops the cached project list after a write.
func (s *Store) invalidateProjects() {
	s.cacheMu.Lock()
	s.cacheValid = false
	s.projectsCache = nil
	s.cacheMu.Unlock()
}

// SetPublisher wires an event sink (the hub). Optional; nil means no broadcast.
func (s *Store) SetPublisher(p Publisher) { s.publisher = p }

// publish forwards a committed event to the publisher if one is set.
func (s *Store) publish(events ...domain.Event) {
	if s.publisher == nil {
		return
	}
	for _, e := range events {
		s.publisher.Publish(e)
	}
}

// tx runs fn inside a transaction, committing on success and rolling back on error.
func (s *Store) tx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // no-op after a successful commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// appendEvent increments the project's version (row-locking it, which also
// serializes concurrent writers) and appends one event. Returns the stored
// event so callers can hand it straight to the broadcaster later.
func appendEvent(ctx context.Context, tx pgx.Tx, projectID, eventType string, payload any, actor string) (domain.Event, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return domain.Event{}, err
	}

	var version int64
	err = tx.QueryRow(ctx,
		`UPDATE projects SET version = version + 1 WHERE id = $1 RETURNING version`,
		projectID,
	).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Event{}, ErrNotFound // project doesn't exist
	}
	if err != nil {
		return domain.Event{}, err
	}

	ev := domain.Event{ProjectID: projectID, Version: version, Type: eventType, Payload: data, Actor: actor}
	err = tx.QueryRow(ctx,
		`INSERT INTO events (project_id, version, type, payload, actor)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		projectID, version, eventType, data, actor,
	).Scan(&ev.ID, &ev.CreatedAt)
	return ev, err
}

// ListEvents returns events for a project after the given version, oldest first.
// This is the catch-up feed a reconnecting client requests (?since=N).
func (s *Store) ListEvents(ctx context.Context, projectID string, since int64, limit int) ([]domain.Event, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, project_id, version, type, payload, actor, created_at
		 FROM events WHERE project_id = $1 AND version > $2
		 ORDER BY version ASC LIMIT $3`,
		projectID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := []domain.Event{}
	for rows.Next() {
		var e domain.Event
		if err := rows.Scan(&e.ID, &e.ProjectID, &e.Version, &e.Type, &e.Payload, &e.Actor, &e.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
