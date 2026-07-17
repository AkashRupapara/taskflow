-- Core schema. `events` is the append-only source of truth for realtime sync;
-- projects/tasks/comments are the materialized read models kept in step with it.
-- Each project carries a monotonic `version` that every event increments, so
-- clients can request "everything since version N" on reconnect.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata    JSONB NOT NULL DEFAULT '{}',
    version     BIGINT NOT NULL DEFAULT 0, -- last applied event version
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'todo',
    assigned_to   TEXT[] NOT NULL DEFAULT '{}',
    -- {priority, description, tags[], customFields} kept as JSONB for flexibility.
    configuration JSONB NOT NULL DEFAULT '{}',
    dependencies  UUID[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
    id         BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version    BIGINT NOT NULL,          -- per-project sequence number
    type       TEXT NOT NULL,            -- e.g. task.created, task.moved
    payload    JSONB NOT NULL,           -- the delta, not the whole project
    actor      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);

-- Indexes tuned for the common access paths (board load, catch-up, comments).
CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);
CREATE INDEX idx_events_project_version ON events (project_id, version);
CREATE INDEX idx_comments_task ON comments (task_id);
