#!/usr/bin/env bash
# Load-test seed: create a project, bulk-insert N tasks straight into Postgres
# (via generate_series, so it's instant), then time the cursor-paginated API to
# show it stays fast regardless of dataset size. Proves the indexing + keyset
# pagination strategy at scale.
#
# Usage: ./scripts/seed.sh [count]   (default 10000)
set -euo pipefail

COUNT="${1:-10000}"
API="${API:-http://localhost:8080/api}"
PG="docker compose exec -T postgres psql -U taskflow -d taskflow -tA"

echo "Creating project 'Scale Test (${COUNT})' ..."
PID=$(curl -s -X POST "$API/projects" \
  -d "{\"name\":\"Scale Test (${COUNT})\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "  project id = $PID"

echo "Inserting ${COUNT} tasks ..."
# Round-robin the three statuses so all columns are populated.
$PG -c "INSERT INTO tasks (project_id, number, position, title, status, configuration)
     SELECT '$PID',
            g,
            g,
            'Task ' || g,
            (ARRAY['todo','in_progress','done'])[1 + (g % 3)],
            jsonb_build_object('priority', (ARRAY['low','','high'])[1 + (g % 3)], 'tags', '[]'::jsonb)
     FROM generate_series(1, $COUNT) g;" >/dev/null
$PG -c "UPDATE projects SET task_seq = $COUNT WHERE id = '$PID';" >/dev/null
$PG -c "ANALYZE tasks;" >/dev/null # refresh planner stats after the bulk load
echo "  done."

echo
echo "Row count for project:"
$PG -c "SELECT count(*) FROM tasks WHERE project_id = '$PID';"

echo
echo "Timing first page (limit=200) - should be single-digit ms:"
curl -s -o /dev/null -w "  page 1: %{time_total}s\n" "$API/projects/$PID/tasks?limit=200"

echo
echo "EXPLAIN for the paginated query (expect an Index Scan, not Seq Scan):"
$PG -c "EXPLAIN SELECT id FROM tasks
     WHERE project_id = '$PID'
     ORDER BY created_at, id LIMIT 200;"

echo
echo "Open the UI and select 'Scale Test (${COUNT})' to see virtual scrolling."
