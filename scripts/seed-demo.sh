#!/usr/bin/env bash
# Seed a small, demo-friendly project via the REST API (so it generates events
# and realtime broadcasts, exactly like real usage). Creates "Website Redesign"
# with a dependency chain that shows off status transitions and the "can't close
# a task while a blocker is open" rule.
#
# Usage: ./scripts/seed-demo.sh        (API must be running on :8080)
set -euo pipefail

API="${API:-http://localhost:8080/api}"

pid() { python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'; }

echo "Creating project 'Website Redesign' ..."
PID=$(curl -s -X POST "$API/projects" -H "X-Actor: Akash" \
  -d '{"name":"Website Redesign","description":"Q3 marketing site refresh"}' | pid)

# X-Actor attributes each change in the activity log (see README: it is a
# display name, not an authenticated identity).
mk() { curl -s -X POST "$API/projects/$PID/tasks" -H "X-Actor: ${2:-Akash}" -d "$1" | pid; }

A=$(mk '{"title":"Design mockups","status":"done","configuration":{"priority":"high","tags":["design"]}}')
mk '{"title":"Write homepage copy","status":"in_progress","configuration":{"priority":"medium","tags":["content"]}}' "Dhruvi" >/dev/null
B=$(mk "{\"title\":\"Build homepage\",\"status\":\"in_progress\",\"configuration\":{\"priority\":\"high\",\"tags\":[\"frontend\"]},\"dependencies\":[\"$A\"]}")
mk "{\"title\":\"Deploy to production\",\"status\":\"todo\",\"configuration\":{\"priority\":\"high\"},\"dependencies\":[\"$B\"]}" >/dev/null

echo "Done. 'Deploy to production' is blocked by 'Build homepage' (still in progress),"
echo "so it can't be marked Done yet - a live demo of the dependency rule."
