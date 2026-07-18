# TaskFlow

A collaborative, real-time task management system. Several people can work on the
same board at once and see each other's changes within milliseconds, without any
managed real-time database. Go backend, React frontend, Postgres, and an
append-only event log that drives efficient delta sync.

## What it does

- **Projects and tasks** - create, edit, delete; Jira-style ids (`WR-1`)
- **Two views** - a Kanban **board** (drag between columns) and a ranked
  **backlog** (drag to prioritise)
- **Dependencies** - a task can't be closed while a blocker is open; cycles are
  rejected
- **Comments** on tasks, live for everyone
- **Real-time** - one person's change appears on every other client immediately
- **Activity log** - who changed what, when (per project and per task)
- **Time-travel** - scrub the board back to any past moment
- **Undo/Redo** (Cmd/Ctrl+Z)
- **Scale** - 10k+ tasks per project stay smooth

## Run it

Everything in Docker (pulls Postgres automatically):

```bash
docker compose up
```

- App: <http://localhost:5173>
- API docs (Swagger UI): <http://localhost:8080/api/docs>

The database starts empty. For demo data with a dependency chain:

```bash
./scripts/seed-demo.sh
```

<details>
<summary>Local dev with hot reload</summary>

```bash
docker compose up -d postgres

# API (migrations run automatically on startup)
cd api && DATABASE_URL="postgres://taskflow:taskflow@localhost:5432/taskflow?sslmode=disable" go run .

# Web (separate terminal)
cd web && npm install && npm run dev
```
</details>

**See the real-time sync:** open two browser tabs on the same project. A change in
one appears in the other instantly, with no refresh.

## Technology choices

| Concern | Choice | Why |
| --- | --- | --- |
| Backend | **Go**, stdlib `net/http` | Cheap goroutines for thousands of WebSocket connections; one static binary; Go 1.22+ routing needs no framework |
| Real-time | **WebSockets** (`gorilla/websocket`) | Lowest-latency push, and bidirectional for future presence/cursors |
| Store | **Postgres** (`pgx`) | Transactions keep the event log and read models in lockstep; JSONB for flexible task config; strong indexing |
| Frontend | **React + Vite + TypeScript** | Types mirror the Go JSON end to end; Vite is fast and light |
| Drag & drop | **@dnd-kit** | Accessible, unopinionated |
| Long lists | **@tanstack/react-virtual** | Only visible rows mount, so 10k tasks stay smooth |

## Architecture

The system is **event-sourced**. Every mutation runs in one Postgres transaction
that (1) updates the read-model tables, (2) appends a row to the append-only
`events` log, and (3) bumps a per-project `version`. After commit, the event is
fanned out to subscribed clients.

```mermaid
flowchart LR
  A["Browser A<br/>React SPA"]
  B["Browser B<br/>React SPA"]

  subgraph API["Go API (any number of instances)"]
    RL["Rate limiter"]
    REST["REST handlers"]
    STORE["Store<br/>transaction + event append"]
    HUB["WebSocket hub<br/>per-project rooms"]
  end

  subgraph PG["PostgreSQL"]
    RM["Read models<br/>projects / tasks / comments"]
    LOG["events<br/>append-only log"]
  end

  A -->|"REST mutation"| RL --> REST --> STORE
  STORE -->|"txn: update"| RM
  STORE -->|"txn: append + version++"| LOG
  STORE -->|"publish"| HUB
  LOG -.->|"LISTEN/NOTIFY to other instances"| HUB
  A -.->|"WS ?since=N"| HUB
  B -.->|"WS ?since=N"| HUB
  HUB -->|"delta"| A
  HUB -->|"delta"| B
```

Only **deltas** cross the wire - the single changed task or comment, never the
whole project. That is what keeps large (2MB+) projects cheap to keep in sync.

## How sync works

```mermaid
sequenceDiagram
  participant A as Client A
  participant API as Go API
  participant DB as Postgres
  participant B as Client B

  A->>API: mutation (already applied locally, optimistically)
  API->>DB: BEGIN · update read model · append event, version++ · COMMIT
  API-->>A: 200 (authoritative state)
  API->>B: WebSocket delta
  Note over A,B: both apply it, ignoring versions they already have
```

1. **Snapshot, then subscribe.** The client loads the project once
   (cursor-paginated), records its `version`, then opens
   `GET /ws?projectId=X&since=<version>`.
2. **Live deltas.** Each committed event is broadcast to that project's room.
3. **Catch-up on reconnect.** `since=<lastVersion>` replays only what was missed,
   so a dropped connection heals without reloading the project.
4. **Optimistic UI.** Changes render instantly and roll back if the server
   rejects them (e.g. closing a blocked task).
5. **Consistent ordering.** The version counter is incremented with
   `UPDATE … RETURNING`, which row-locks the project and serialises concurrent
   writers - so every client applies changes in the same order.
6. **Conflicts.** Clients send the `rev` they read; a write against a stale `rev`
   returns `409` instead of overwriting someone's concurrent edit.

## Database design

`projects`, `tasks`, `comments` are read models; `events` is the append-only
source of truth. See [migrations](api/internal/db/migrations).

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
    jsonb metadata
    bigint version "last applied event"
    bigint task_seq "per-project task counter"
  }
  TASKS {
    uuid id PK
    uuid project_id FK
    bigint number "display id = key-number"
    text title
    text status "todo | in_progress | done"
    jsonb configuration "priority, description, tags, customFields"
    text_array dependencies "tasks that block this one"
    int rev "optimistic-concurrency revision"
    double position "fractional rank for manual ordering"
  }
  COMMENTS {
    uuid id PK
    uuid task_id FK
    text content
    text author
  }
  EVENTS {
    bigserial id PK
    uuid project_id FK
    bigint version "per-project sequence"
    text type "task.created, task.updated, ..."
    jsonb payload "the delta"
    text actor
  }
```

- `UNIQUE (project_id, version)` on `events` guarantees a total order per project.
- Foreign keys cascade, so deleting a project cleans up everything it owns.
- Indexes: `(project_id, position, id)` for ordered keyset pagination,
  `(project_id, status)` for the board, `(project_id, version)` for catch-up,
  `(task_id)` for comment threads.

## Scaling

**Implemented**

- **Delta-only updates** - payload size is independent of project size.
- **Keyset pagination** on `(position, id)` - an index-only scan, so page latency
  is flat however deep you go (no `OFFSET`).
- **Virtualized rendering** in both views - a 10k-task list mounts ~30 rows.
- **Horizontal scale** - Postgres `LISTEN/NOTIFY` fans events out across API
  instances. The notification is sent inside the writing transaction (so it only
  fires on commit) and carries an instance id, so a process ignores the echo of
  its own writes. Verified with two instances: a client on B sees writes made
  through A.
- **Backpressure** - bounded per-client send buffers; a slow client's messages are
  dropped rather than stalling the hub, and it re-syncs on reconnect.
- **Rate limiting** - per-IP token bucket (100 req/s, burst 300 → `429`).
- **Caching** - the client keeps the project in memory and applies deltas; the
  server caches the project list with invalidation on write.

**Next steps as it grows**

- Snapshot/compact the event log so catch-up and time-travel replay from a recent
  checkpoint rather than from zero.
- Move fan-out to Redis Streams or Kafka partitioned by `projectId` when one
  Postgres can't carry the notification volume.
- Lazy-load tasks per page instead of loading a project's full task list.

### Load testing results

Against a project seeded with **10,000 tasks**
([`scripts/seed.sh`](scripts/seed.sh), [`scripts/loadtest.py`](scripts/loadtest.py)):

| Metric | Result |
| --- | --- |
| Query plan | `Index Only Scan`, no sort |
| Single page (200 tasks) | ~6 ms |
| Throughput @ 50 connections | ~1,090 req/s, 0 errors |
| Latency p50 / p95 / p99 | 44 / 57 / 117 ms |

## Testing & developer experience

| Layer | Tool | Run |
| --- | --- | --- |
| Backend unit | `go test` | `cd api && go test ./...` |
| Backend integration (real Postgres) | `go test` | `cd api && DATABASE_URL=… go test ./...` |
| Frontend unit | Vitest | `cd web && npm test` |
| End-to-end | Playwright | `cd web && npm run test:e2e` |

Integration tests skip themselves when no `DATABASE_URL` is set, so the unit
suite always runs standalone.

- **CI:** [.github/workflows/ci.yml](.github/workflows/ci.yml) - backend, frontend,
  and a full-stack e2e job on every push/PR.
- **API docs:** Swagger UI at `/api/docs`; raw spec at `/api/openapi.yaml`
  ([source](api/internal/server/openapi.yaml)).
- **Migrations & seeding:** applied automatically at startup;
  `./scripts/seed-demo.sh` for demo data, `./scripts/seed.sh <n>` for load data.

## Challenges

The two problems that shaped the design most.

**1. Getting every client to agree on the order of changes - without a global lock.**
Clients apply changes independently, so "who saw what first" has to be decided
somewhere. A single global sequence would serialise every write in the system.
Instead each project owns a counter, incremented as
`UPDATE projects SET version = version + 1 … RETURNING version` inside the same
transaction as the write. That row lock makes writers to *one project* queue up,
which is exactly the scope where ordering matters - projects don't block each
other. Clients then apply events in version order and ignore versions they have
already seen, so replays and duplicates are harmless.

*The cost, stated plainly:* a single very busy project is capped by how fast that
one row can be updated - roughly hundreds of writes/second, bounded by commit
latency. It scales horizontally across projects, not within one. Pushing past
that means partitioning the log by `projectId` (Kafka/Redis Streams) or deriving
order from Postgres' WAL via CDC instead of an application-level counter.

**2. Concurrent edits silently overwriting each other.**
Two people editing the same task both sent a full update, so whoever wrote last
won and the other's change vanished with no error - invisible data loss. Each
task now carries a `rev`; clients send the rev they read as `expectedRev`, and a
write against a stale rev is rejected with `409` instead of applied. The bug
becomes a visible, resolvable conflict rather than a silent one. See the
tradeoffs below for what this still doesn't solve (field-level merging).

## Assumptions

Deliberately out of scope, and what each would become in a real deployment:

- **No authentication.** Anyone who can reach the API can act on any project. The
  "You" name in the sidebar is a display name sent as `X-Actor` and stored on each
  event - useful for the activity log, but **not** a verified identity. With auth,
  the server derives the actor from the session and every existing event still
  reads correctly.
- **No authorisation or multi-tenancy.** No org/team boundaries, no per-task
  permissions; every project is visible to everyone.
- **Single logical database.** No sharding or read replicas.
- **Fixed status model** (`todo / in_progress / done`) rather than configurable
  workflows.
- **Comments are plain text** - no editing, deletion, or attachments.

## Tradeoffs

- **Events store whole entities, not field-level deltas.** Replay stays trivial
  and idempotent - the same fold powers live sync, catch-up, and time-travel - at
  the cost of computing "what changed" on read for the activity log.
- **The event log is unbounded.** Catch-up and time-travel replay from the
  beginning. Fine at this scale; production wants periodic snapshots.
- **Fractional ordering can run out of precision.** A reorder stores the midpoint
  of the new neighbours, so it's a single-row update - but roughly 50 moves into
  the *same* gap exhausts float precision. The fix is background renormalisation
  to `1..n`; Jira solved this with LexoRank strings.
- **Conflicts are per-entity, not per-field.** `expectedRev` stops one user
  silently overwriting another, but two people editing *different fields of the
  same task* still conflict rather than merging; field-level CRDTs would be needed
  for true simultaneous editing. Undo/redo intentionally skips the check, so it
  can overwrite a concurrent change.
- **The client loads a project's whole task list** to group and rank it. Fine into
  the tens of thousands (rendering is virtualized); beyond that it needs the lazy
  loading the cursor API already supports.
- **Swagger UI loads assets from a CDN**, so `/api/docs` needs internet; the raw
  spec at `/api/openapi.yaml` works offline.

## Project structure

```
api/
  main.go                     # wiring: DB, migrations, hub, routes
  internal/
    domain/                   # types + status/dependency rules
    store/                    # transactions, event append, queries, fan-out
    server/                   # REST handlers, OpenAPI spec + Swagger UI
    ws/                       # WebSocket hub and clients
    middleware/               # rate limiting
    db/                       # migration runner + SQL migrations
web/
  src/
    api/                      # REST client, WebSocket URL
    hooks/useProjectSync.ts   # real-time state + optimistic mutations
    lib/                      # pure logic: event fold, diffing, ranking
    components/               # board, backlog, detail panel, history
scripts/                      # demo seed, load seed, benchmark
```
