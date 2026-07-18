# TaskFlow

A collaborative, real-time task management system. Multiple clients see each
other's changes in near real-time, the system stays consistent across clients,
and it is built to stay fast as projects grow large - without any managed
real-time database (no Firebase/Supabase). Backend is Go, frontend is React,
Postgres is the store, and an append-only event log drives efficient delta sync.

---

## Features

- Multiple projects; create / update / delete tasks within a project
- Task dependencies and status transitions (a task can only start/finish when its
  dependencies are done - enforced server-side)
- Comment threads on tasks, updated in real-time
- Changes by one client appear on all others in near real-time
- Consistency across clients via per-project event versioning + reconnect catch-up
- Kanban board with drag-and-drop between columns (chosen extension)
- Jira-style task ids (e.g. `WR-1`), a create modal, and a non-blocking detail panel
- Undo/Redo of task moves and edits (Cmd/Ctrl+Z), built on before/after snapshots
- Scales to 10k+ tasks per project (virtual scrolling + keyset pagination + indexing)

## Tech stack and why

| Concern | Choice | Why |
| --- | --- | --- |
| Backend | **Go** (stdlib `net/http`) | Strong concurrency for the WebSocket hub; a single static binary; the router in Go 1.22+ covers method + path params without a framework. |
| Realtime | **WebSockets** (`gorilla/websocket`) | Low-latency bidirectional push; fits drag-and-drop and future presence/cursors better than SSE/polling. |
| Store | **Postgres** (`pgx`) | Transactions to keep the event log and read models consistent; JSONB for flexible task config; proven indexing for scale. |
| Frontend | **React + Vite + TypeScript** | Vanilla React SPA (allowed with a Go backend); Vite is light and fast; end-to-end types mirror the Go JSON. |
| Board DnD | **@dnd-kit** | Accessible, unopinionated drag-and-drop. |
| Large lists | **@tanstack/react-virtual** | Render only visible rows so a 3k-card column stays smooth. |

## Architecture

The system is **event-sourced**. Every mutation, inside a single Postgres
transaction, (1) updates the read-model tables, (2) appends a row to the
append-only `events` log, and (3) bumps a monotonic per-project `version`. After
the transaction commits, the event is published to an in-process **hub** that
fans it out to every WebSocket client subscribed to that project's "room".

### System architecture

```mermaid
flowchart LR
  A["Browser A<br/>React SPA"]
  B["Browser B<br/>React SPA"]

  subgraph API["Go API (single binary)"]
    RL["Rate limiter<br/>per-IP token bucket"]
    REST["REST handlers"]
    STORE["Store<br/>transactions + event append"]
    HUB["WebSocket hub<br/>per-project rooms"]
    CACHE["Project-list cache"]
  end

  subgraph PG["PostgreSQL"]
    RM["Read models<br/>projects / tasks / comments"]
    LOG["events<br/>append-only log"]
  end

  A -->|"REST mutation"| RL
  RL --> REST
  REST --> STORE
  REST -.->|"list reads"| CACHE
  STORE -->|"txn: update"| RM
  STORE -->|"txn: append + version++"| LOG
  STORE -->|"publish committed event"| HUB
  A -.->|"WS connect ?since=N"| HUB
  B -.->|"WS connect ?since=N"| HUB
  HUB -->|"delta"| A
  HUB -->|"delta"| B
```

### Write + sync flow

```mermaid
sequenceDiagram
  participant A as Client A
  participant API as Go API
  participant DB as Postgres
  participant B as Client B (subscribed)

  A->>API: REST mutation (applied optimistically on A)
  API->>DB: BEGIN
  API->>DB: update read model
  API->>DB: append event, version++
  API->>DB: COMMIT
  API-->>A: HTTP 200 (echo)
  API->>B: WebSocket delta (single event)
  Note over A,B: both apply the delta, dedupe by version
```

Key point: only **deltas** cross the wire (the single changed task or comment),
never the whole project. That is what satisfies the "2MB+ payloads / avoid
resending entire projects" constraint.

### Database design

`projects`, `tasks`, `comments` are the materialized read models; `events` is the
append-only source of truth. Task `configuration` (`{priority, description, tags,
customFields}`) and project `metadata` are JSONB for flexibility. See the
[migrations](api/internal/db/migrations).

```mermaid
erDiagram
  PROJECTS ||--o{ TASKS : contains
  PROJECTS ||--o{ EVENTS : logs
  TASKS ||--o{ COMMENTS : has
  TASKS }o--o{ TASKS : "blocked by"

  PROJECTS {
    uuid id PK
    text name
    text key "task-id prefix, e.g. WR"
    text description
    jsonb metadata
    bigint version "last applied event"
    bigint task_seq "per-project task counter"
    timestamptz created_at
  }
  TASKS {
    uuid id PK
    uuid project_id FK
    bigint number "display id = key-number"
    text title
    text status "todo | in_progress | done"
    text_array assigned_to
    jsonb configuration "priority, description, tags, customFields"
    text_array dependencies "task ids that block this one"
    timestamptz created_at
  }
  COMMENTS {
    uuid id PK
    uuid task_id FK
    text content
    text author
    timestamptz created_at
  }
  EVENTS {
    bigserial id PK
    uuid project_id FK
    bigint version "per-project sequence"
    text type "task.created, task.updated, ..."
    jsonb payload "the delta"
    text actor
    timestamptz created_at
  }
```

**Keys & integrity**
- `events` has `UNIQUE (project_id, version)` - the monotonic per-project sequence
  that guarantees a total order of changes and powers reconnect catch-up.
- `project_id` / `task_id` foreign keys use `ON DELETE CASCADE`, so deleting a
  project cleanly removes its tasks, comments, and events in one operation.
- Task `dependencies` is a `text[]` of task ids; a recursive-CTE check rejects any
  edit that would create a dependency cycle.

**Indexes** (see [0001](api/internal/db/migrations/0001_init.up.sql) / [0002](api/internal/db/migrations/0002_task_pagination_index.up.sql))
- `(project_id, created_at, id)` on `tasks` - keyset pagination as an index-only
  scan (no sort), flat latency at 10k+ tasks.
- `(project_id, status)` on `tasks` - column grouping for the board.
- `(project_id, version)` on `events` - fast catch-up (`WHERE version > N`).
- `(task_id)` on `comments` - thread loads.

### Data flow / synchronization strategy

1. **Snapshot then subscribe.** On opening a project the client fetches a snapshot
   (project + tasks, cursor-paginated) once, records the project `version`, then
   opens `GET /ws?projectId=X&since=<version>`.
2. **Live deltas.** Each committed event is broadcast to the room. Clients apply
   it and advance their local version. Events are keyed by entity id, so applying
   the same event twice is idempotent.
3. **Catch-up on reconnect.** The socket URL carries `since=<lastVersion>`; on
   connect the server replays every missed event from the log, so a client that
   dropped offline converges without reloading the whole project.
4. **Optimistic UI with rollback.** Mutations apply locally immediately; the
   server's echoed event confirms them, and a failed request rolls the local
   state back (e.g. a move rejected because dependencies aren't done).
5. **Ordering / consistency.** `appendEvent` increments the project version with
   `UPDATE ... RETURNING`, which row-locks the project and serializes concurrent
   writers, giving every client the same event order.

## Scaling strategy

- **Efficient updates.** Delta broadcast (not full-project resend) keeps payloads
  tiny regardless of project size.
- **Large task lists.** `GET /projects/{id}/tasks` uses **keyset (cursor)
  pagination**, which is O(log n) to seek and flat as you page deep - unlike
  `OFFSET`. Backed by a composite index `(project_id, created_at, id)`, the query
  plan is an `Index Only Scan` with no sort. At 10k tasks the first page returns
  in single-digit milliseconds (see [scripts/seed.sh](scripts/seed.sh)).
- **Rendering at scale.** The board virtualizes each column, so only visible cards
  mount - a 3,000-task column stays smooth.
- **Horizontal scale (documented path).** The hub is an in-process publisher today
  (single API instance). To run multiple API instances, swap the in-process
  publisher for **Postgres `LISTEN/NOTIFY`** (notify with `projectId + version`,
  each instance fetches and fans out) or **Redis pub/sub**. Because the store
  already publishes through a `Publisher` interface, this is a drop-in change with
  no domain code touched.
- **Backpressure.** Each client has a bounded send buffer; a slow client's
  messages are dropped rather than blocking the hub, and it re-syncs from its last
  version on reconnect.
- **Rate limiting.** A per-IP token-bucket middleware (100 req/s sustained, burst
  300) rejects floods with `429`, protecting the API alongside the WebSocket
  backpressure above. See [middleware/ratelimit.go](api/internal/middleware/ratelimit.go).
- **Caching.** Three layers: (1) the client keeps the project snapshot in memory
  and applies deltas rather than refetching; (2) the hub holds live room state in
  memory; (3) the server caches the project list (read on every sidebar load,
  written rarely) with invalidation on any project write. The same read-through
  pattern extends to Redis for a multi-instance deployment.

## Tradeoffs

- **In-process hub** keeps the design simple and fast for a single instance; multi
  instance needs the LISTEN/NOTIFY or Redis swap above (interface is already in
  place).
- **Board loads all tasks** to group them into columns. Fine to tens of thousands;
  beyond that, per-column lazy loading (the cursor API already supports it) would
  be the next step.
- **Last-writer-wins** on concurrent field edits. Ordered event application keeps
  clients consistent; a field-level CRDT/OT could be layered on for simultaneous
  text editing.
- **Event log is unbounded.** In production it would be snapshotted/compacted so
  catch-up replays from a recent checkpoint rather than the beginning.

## Project structure

```
api/
  main.go                     # wiring: DB, migrations, hub, routes
  internal/
    domain/                   # types + status/dependency rules
    store/                    # transactions + event append + queries
    server/                   # REST handlers, error -> HTTP mapping
    ws/                       # WebSocket hub + client
    db/                       # migration runner + SQL migrations
web/
  src/
    api/                      # REST client + ws URL
    hooks/useProjectSync.ts   # realtime state + optimistic actions
    components/               # Sidebar, Board, Column, TaskCard, TaskDetail
scripts/seed.sh               # load test: 10k tasks + timing + EXPLAIN
```

## Running it

Full stack in Docker (pulls Postgres automatically):

```bash
docker compose up
# web -> http://localhost:5173
# api -> http://localhost:8080/api/health
```

### Local dev (hot reload)

```bash
docker compose up -d postgres

# API (migrations run on startup)
cd api && DATABASE_URL="postgres://taskflow:taskflow@localhost:5432/taskflow?sslmode=disable" go run .

# Web
cd web && npm install && npm run dev
```

### Load test

```bash
./scripts/seed.sh 10000   # creates a project with 10k tasks, prints timing + query plan
```

Open two browser tabs on the same project to see real-time sync: a change in one
appears in the other with no reload.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/api/projects` | list / create projects |
| GET/PATCH/DELETE | `/api/projects/{id}` | read / update / delete |
| GET | `/api/projects/{id}/tasks?limit&cursor` | cursor-paginated tasks |
| POST | `/api/projects/{id}/tasks` | create task |
| PATCH/DELETE | `/api/tasks/{id}` | update / delete task |
| GET/POST | `/api/tasks/{id}/comments` | list / add comments |
| GET | `/api/projects/{id}/events?since=N` | catch-up event feed |
| WS | `/ws?projectId=X&since=N` | realtime delta stream |
