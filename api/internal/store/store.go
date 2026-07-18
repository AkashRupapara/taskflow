// Package store is the data layer. Every mutation runs in a transaction that
// updates the read model AND appends to the event log atomically, so the two
// never drift. appendEvent also bumps the project version that clients use to
// catch up after a disconnect (Phase 2).
package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

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
	ErrStaleWrite       = errors.New("task was changed by someone else")
)

// Publisher receives events after their transaction commits, so subscribers
// never see a change that was rolled back. The WebSocket hub implements it.
type Publisher interface {
	Publish(domain.Event)
}

type Store struct {
	pool      *pgxpool.Pool
	publisher Publisher

	// Identifies this API process. Notifications carry it so an instance can
	// ignore the echo of its own writes (it already published them in-process).
	instanceID string

	// Read-through cache for the project list (hit on every sidebar load,
	// changes rarely). Invalidated on any project create/update/delete.
	cacheMu       sync.RWMutex
	projectsCache []domain.Project
	cacheValid    bool
}

func New(pool *pgxpool.Pool) *Store {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return &Store{pool: pool, instanceID: hex.EncodeToString(buf)}
}

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
func (s *Store) appendEvent(ctx context.Context, tx pgx.Tx, projectID, eventType string, payload any, actor string) (domain.Event, error) {
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
	if err != nil {
		return ev, err
	}

	// Tell other API instances. NOTIFY is transactional - Postgres only delivers
	// it if this transaction commits - and we send just an id + version (well
	// under the 8KB payload cap); listeners fetch the row themselves.
	note, err := json.Marshal(notification{Project: projectID, Version: version, Origin: s.instanceID})
	if err != nil {
		return ev, err
	}
	_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, eventChannel, string(note))
	return ev, err
}

const eventChannel = "taskflow_events"

type notification struct {
	Project string `json:"p"`
	Version int64  `json:"v"`
	Origin  string `json:"o"`
}

// GetEvent fetches a single event by its project + version.
func (s *Store) GetEvent(ctx context.Context, projectID string, version int64) (domain.Event, error) {
	var e domain.Event
	err := s.pool.QueryRow(ctx,
		`SELECT id, project_id, version, type, payload, actor, created_at
		 FROM events WHERE project_id = $1 AND version = $2`,
		projectID, version,
	).Scan(&e.ID, &e.ProjectID, &e.Version, &e.Type, &e.Payload, &e.Actor, &e.CreatedAt)
	return e, err
}

// Listen forwards events written by OTHER API instances to this instance's
// subscribers, which is what makes horizontal scaling possible: any instance can
// hold a client's WebSocket and still see every change. Reconnects on failure.
func (s *Store) Listen(ctx context.Context, logf func(string, ...any)) {
	for ctx.Err() == nil {
		if err := s.listenOnce(ctx); err != nil && ctx.Err() == nil {
			logf("listener: %v (retrying)", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func (s *Store) listenOnce(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "LISTEN "+eventChannel); err != nil {
		return err
	}
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var note notification
		if err := json.Unmarshal([]byte(n.Payload), &note); err != nil {
			continue
		}
		if note.Origin == s.instanceID {
			continue // our own write; already delivered in-process
		}
		if ev, err := s.GetEvent(ctx, note.Project, note.Version); err == nil {
			s.publish(ev)
		}
	}
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
