-- Per-task revision for optimistic concurrency control.
--
-- Distinct from projects.version (which orders the project's event stream):
-- tasks.rev tracks how many times THIS task changed. A client sends the rev it
-- last saw as `expectedRev`; if it no longer matches, someone else edited the
-- task in between and the write is rejected with 409 instead of silently
-- clobbering their change.
ALTER TABLE tasks ADD COLUMN rev INT NOT NULL DEFAULT 0;
