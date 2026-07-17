# TaskFlow

Collaborative, real-time task management. Go backend + React frontend, with an
append-only event log for efficient delta-based sync across clients.

> Status: Phase 0 (scaffold). Domain API, WebSocket sync, and the Kanban UI land
> in later phases.

## Architecture (target)

Event-sourced backend: every mutation appends an event to an append-only log
(the source of truth) inside a Postgres transaction, bumps a per-project version,
and broadcasts only the **delta** to subscribed clients over WebSockets. Clients
load a snapshot once, then apply deltas and catch up from their last version on
reconnect. This keeps sync efficient even for large (2MB+) projects.

- **Backend:** Go (stdlib HTTP), Postgres via pgx, embedded SQL migrations
- **Frontend:** React + Vite (TypeScript)
- **Realtime:** per-project WebSocket rooms broadcasting deltas
- **Infra:** Docker Compose (postgres + api + web)

## Data model

`projects`, `tasks`, `comments` are materialized read models. `events` is the
append-only log; `projects.version` tracks the last applied event. See
[api/internal/db/migrations](api/internal/db/migrations).

## Run it

Full stack in Docker (pulls Postgres automatically):

```bash
docker compose up
# web  -> http://localhost:5173
# api  -> http://localhost:8080/api/health
```

### Local dev (hot reload)

Run just the database in Docker, and the app natively:

```bash
docker compose up -d postgres

# API
cd api && DATABASE_URL="postgres://taskflow:taskflow@localhost:5432/taskflow?sslmode=disable" go run .

# Web (separate terminal)
cd web && npm install && npm run dev
```

The Vite dev server proxies `/api` and `/ws` to the Go server, so the browser
talks to a single origin.
