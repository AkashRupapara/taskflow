-- Jira-style task identifiers: each project has a short KEY, and each task gets
-- a sequential NUMBER within the project. Display id is KEY-NUMBER (e.g. WR-1).
-- task_seq is the per-project counter, bumped inside the create transaction.

ALTER TABLE projects ADD COLUMN key TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN task_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN number BIGINT NOT NULL DEFAULT 0;

-- Backfill keys for existing projects: first 3 alphanumerics of the name, upper.
UPDATE projects
SET key = upper(substring(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g') FROM 1 FOR 3))
WHERE key = '';

-- Backfill task numbers sequentially per project (oldest first).
UPDATE tasks t
SET number = s.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
  FROM tasks
) s
WHERE t.id = s.id AND t.number = 0;

-- Point each project's counter at its current highest task number.
UPDATE projects p
SET task_seq = COALESCE((SELECT max(number) FROM tasks WHERE project_id = p.id), 0);
