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
- Two views: Kanban **board** (drag-and-drop between columns) and a ranked
  **backlog** list where tasks can be moved up/down to set priority
- Jira-style task ids (e.g. `WR-1`), a create modal, and a non-blocking detail panel
- Undo/Redo of task moves and edits (Cmd/Ctrl+Z), built on before/after snapshots
- Activity log: who changed what, when - at project level and per task
- Time-travel: scrub the board back to any past version by replaying the event log
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
    int rev "optimistic-concurrency revision"
    double position "fractional rank for manual ordering"
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

**Indexes** (see [migrations](api/internal/db/migrations))
- `(project_id, position, id)` on `tasks` - keyset pagination in the user's chosen
  order, as an index scan with no sort; flat latency at 10k+ tasks.
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

## Board and backlog views

The **Board** groups tasks by status for day-to-day flow. The **Backlog** is a
single ranked list of every task, reordered with ↑/↓.

Ordering uses a **fractional rank**: moving a task stores the midpoint of its new
neighbours' positions (e.g. between 2 and 3 → 2.5), so a reorder is a *single-row
update* rather than renumbering everything below it. The list query and the
keyset pagination cursor both order by `(position, id)`, so paging stays
consistent with whatever order the user has chosen.

*Tradeoff:* repeatedly halving the same gap eventually exhausts float precision
(~50 moves into the identical slot). The standard fix is to renormalise a
project's positions to 1..n in a background job; Jira solved this with LexoRank
strings. Not implemented here - documented rather than hidden.

## Activity log & time-travel (open-ended extension)

The **History** view offers two reads of the same event log:

- **Activity** - a plain-language audit trail: `Dhruvi · WR-3 Build homepage ·
  status In Progress → Done · 2m ago`. The same feed, filtered to one task,
  appears inside that task's detail panel (like Jira's issue history).
- **Board at time** - the time-travel scrubber described below.

Field-level changes ("status In Progress → Done") are **derived**, not stored:
each `task.updated` event carries the full task, and
[`diffTasks`](web/src/lib/diff.ts) compares consecutive snapshots while
[`buildActivity`](web/src/lib/activity.ts) walks the log. Both are pure functions
and unit tested.

**Tradeoffs worth naming:**

- *Attribution is not authentication.* `X-Actor` is a client-supplied display
  name kept in localStorage, so the log currently reads "Akash" because the
  client said so - and "someone" when it says nothing. There is no login in this
  build. When real auth is added, the server derives the actor from the session
  instead and **every existing event keeps working unchanged**, because the
  `actor` field is already part of the event schema.
- *Snapshots over explicit deltas.* Events store the whole entity rather than
  `{field: {from, to}}`. That keeps replay trivial and idempotent (the same fold
  powers live sync, catch-up, and time-travel) at the cost of computing diffs on
  read. Storing explicit deltas would make the activity log cheaper to render but
  complicate replay.

## Time-travel

The "History" button replays a project's event log so you can **scrub the board
back to any past version** - drag the slider (or hit Play) and watch tasks
un-move, reappear, and revert. It's read-only; "Back to live" resumes editing.

This exists *because* the backend is event-sourced, and it reuses the exact same
[`applyTaskEvent`](web/src/lib/applyEvent.ts) reducer the live client uses:
reconstructing the state at version N is just folding events `1..N` from an empty
map ([`reconstructTasks`](web/src/lib/history.ts)). History and live can never
disagree because they run the identical fold. Both functions are pure and unit
tested. It's the clearest demonstration that the event log was the right call - a
capability most task tools can't offer, delivered by an architectural decision
rather than a bolted-on feature.

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
- **Horizontal scale (implemented).** Events fan out across API instances via
  Postgres **`LISTEN/NOTIFY`**. The notification is emitted *inside* the writing
  transaction (so Postgres only delivers it on commit) and carries just
  `projectId + version + origin` - well under the 8KB payload cap. Every instance
  listens, skips the echo of its own writes, fetches the event row, and delivers
  it to its own subscribers. Verified with two instances: a client connected to
  instance B receives changes written through instance A. Swapping this for Redis
  Streams or Kafka later is a drop-in change behind the same `Publisher` seam.
- **Optimistic concurrency.** Each task carries a `rev`; clients send the rev they
  read as `expectedRev`. A write against a stale rev is rejected with `409` rather
  than silently overwriting a concurrent edit, turning last-writer-wins into an
  explicit, resolvable conflict.
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

## Load testing results

Measured on the local Docker stack against a project seeded with **10,000 tasks**
(`./scripts/seed.sh 10000`). Scripts: [seed.sh](scripts/seed.sh) (bulk insert +
single-query timing + `EXPLAIN`) and [loadtest.py](scripts/loadtest.py)
(concurrent benchmark).

The paginated list query is an **index-only scan with no sort** at 10k rows:

```
Index Only Scan using idx_tasks_project_created on tasks
```

Single-page latency is ~5-6 ms for `GET /projects/{id}/tasks?limit=200`.

**Concurrent load** (`loadtest.py <id> 50 10000`, rate limiter disabled to measure
raw capacity):

| Metric | Result |
| --- | --- |
| Requests | 10,000 (0 errors) |
| Concurrency | 50 connections |
| Throughput | ~1,090 req/s (~220k task rows/s, 200 per page) |
| Latency p50 | ~44 ms |
| Latency p95 | ~57 ms |
| Latency p99 | ~117 ms |

Latency stays flat as the dataset grows because pagination is keyset (index range
scan), not `OFFSET`. Under abuse, the rate limiter holds: 500 requests fired as
fast as possible from one client (limit 100 req/s, burst 300) let 349 through and
rejected 151 with `429`.

## Testing & developer experience

| Layer | Tool | Covers | Run |
| --- | --- | --- | --- |
| Backend unit | `go test` | status/dependency rules, cursor codec, key gen | `cd api && go test ./...` |
| Backend integration | `go test` + Postgres | REST CRUD, dependency 409, cycle 409, pagination, events | `cd api && DATABASE_URL=... go test ./...` |
| Frontend unit | Vitest | event-apply reducer (idempotent upsert/delete) | `cd web && npm test` |
| E2E | Playwright | create project → add task → see it on the board | `cd web && npm run test:e2e` |

Integration tests skip automatically when no `DATABASE_URL` is set, so the unit
suite always runs standalone.

- **CI:** [.github/workflows/ci.yml](.github/workflows/ci.yml) runs three jobs on
  every push/PR - backend (vet + tests against a Postgres service), frontend
  (typecheck + build + unit), and e2e (boots API + Postgres, runs Playwright).
- **API docs:** browsable **Swagger UI at <http://localhost:8080/api/docs>** while
  the API is running, backed by the OpenAPI 3.0 spec at
  [openapi.yaml](api/internal/server/openapi.yaml) (also served raw at
  `GET /api/openapi.yaml`). Both are embedded in the binary; the UI pulls its
  assets from a CDN, while the raw spec works offline.
- **Migrations & seeding:** migrations are embedded and applied on startup
  (tracked in `schema_migrations`). Seed data via `./scripts/seed-demo.sh` (small
  demo project with a dependency chain) or `./scripts/seed.sh <n>` (n tasks).

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
