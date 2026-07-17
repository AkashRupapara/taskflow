// Package ws is the realtime layer: a hub that groups client connections into
// per-project "rooms" and fans out committed events (deltas) to everyone in the
// room. The store publishes into Hub.Publish; the hub never touches the DB
// except to fetch catch-up events for a reconnecting client.
package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"

	"github.com/gorilla/websocket"

	"taskflow/internal/domain"
)

// eventLister is the slice of the store the hub needs for catch-up.
type eventLister interface {
	ListEvents(ctx context.Context, projectID string, since int64, limit int) ([]domain.Event, error)
}

type Hub struct {
	mu     sync.RWMutex
	rooms  map[string]map[*Client]bool // projectID -> connected clients
	store  eventLister
	logger func(string, ...any)
}

func NewHub(store eventLister, logger func(string, ...any)) *Hub {
	return &Hub{rooms: map[string]map[*Client]bool{}, store: store, logger: logger}
}

var upgrader = websocket.Upgrader{
	// Dev: allow any origin. In prod this would check against an allowlist.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ServeHTTP upgrades GET /ws?projectId=<id>&since=<version> to a WebSocket,
// registers the client in the project room, and replays any missed events.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	projectID := r.URL.Query().Get("projectId")
	if projectID == "" {
		http.Error(w, "projectId required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error response
	}

	client := newClient(h, conn, projectID)
	h.add(client)

	// Catch-up: replay events the client missed while disconnected. We register
	// BEFORE replaying so no live event is lost in the gap; the client dedupes
	// by version (applies only version > last seen).
	if since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64); err == nil && since >= 0 {
		if events, err := h.store.ListEvents(r.Context(), projectID, since, 500); err == nil {
			for _, ev := range events {
				if data, err := json.Marshal(ev); err == nil {
					client.trySend(data)
				}
			}
		}
	}

	go client.writePump()
	go client.readPump()
}

// Publish fans an event out to every client in its project room. Implements
// store.Publisher.
func (h *Hub) Publish(ev domain.Event) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[ev.ProjectID] {
		c.trySend(data)
	}
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[c.projectID] == nil {
		h.rooms[c.projectID] = map[*Client]bool{}
	}
	h.rooms[c.projectID][c] = true
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[c.projectID]
	if room == nil {
		return
	}
	delete(room, c)
	if len(room) == 0 {
		delete(h.rooms, c.projectID)
	}
}
