-- Drop the index added in 0002.
--
-- 0002 indexed (project_id, created_at, id) because the task list was ordered by
-- creation time. 0005 introduced manual ordering, so the list now sorts by
-- (position, id) and nothing orders tasks by created_at any more. The only part
-- of this index still doing work was its leading project_id column, which
-- idx_tasks_project_position already covers - so it was pure write overhead on
-- every task insert and update.
DROP INDEX IF EXISTS idx_tasks_project_created;
