-- Manual ordering for the backlog view.
--
-- position is a FRACTIONAL rank, not a dense 1..n index: moving a task between
-- two neighbours just stores the midpoint of their positions, so a reorder is a
-- single-row UPDATE instead of renumbering everything after it.
--
-- Tradeoff: repeatedly halving the gap between the same two rows eventually
-- exhausts float precision (~50 moves in the same slot). The standard fix is to
-- renormalise a project's positions to 1..n in a background job when gaps get
-- too small; Jira solved the same problem with LexoRank strings. Not implemented
-- here - it is a documented limitation, not a hidden one.
ALTER TABLE tasks ADD COLUMN position DOUBLE PRECISION;

-- Backfill existing tasks in their current (creation) order.
UPDATE tasks t
SET position = s.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
  FROM tasks
) s
WHERE t.id = s.id AND t.position IS NULL;

ALTER TABLE tasks ALTER COLUMN position SET DEFAULT 0;
ALTER TABLE tasks ALTER COLUMN position SET NOT NULL;

-- Supports ordering + keyset pagination by (position, id).
CREATE INDEX idx_tasks_project_position ON tasks (project_id, position, id);
