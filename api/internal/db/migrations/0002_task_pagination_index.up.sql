-- Supports the keyset-paginated board query:
--   WHERE project_id = $1 ORDER BY created_at, id
-- With this composite index the planner does an index range scan and avoids a
-- sort, so page latency stays flat as a project grows to tens of thousands of
-- tasks.
CREATE INDEX idx_tasks_project_created ON tasks (project_id, created_at, id);
