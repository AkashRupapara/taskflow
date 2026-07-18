// Turns two consecutive snapshots of a task into human-readable change lines.
//
// Design note: each task.updated event stores the FULL task, not an explicit
// delta. Deriving "what changed" by diffing consecutive snapshots keeps replay
// trivial and idempotent (see applyEvent.ts) at the cost of computing the diff
// on read. Pure function, so it's cheap to test.
import { STATUS_LABEL } from "../constants";
import type { Task } from "../types";

const listDiff = (before: string[], after: string[]) => ({
  added: after.filter((x) => !before.includes(x)),
  removed: before.filter((x) => !after.includes(x)),
});

export function diffTasks(prev: Task, next: Task): string[] {
  const out: string[] = [];

  if (prev.title !== next.title) {
    out.push(`renamed to "${next.title}"`);
  }
  if (prev.status !== next.status) {
    out.push(`status ${STATUS_LABEL[prev.status]} → ${STATUS_LABEL[next.status]}`);
  }

  const before = prev.configuration;
  const after = next.configuration;

  if ((before.priority || "") !== (after.priority || "")) {
    out.push(`priority ${before.priority || "none"} → ${after.priority || "none"}`);
  }
  if ((before.description || "") !== (after.description || "")) {
    out.push(after.description ? "edited the description" : "cleared the description");
  }

  const tags = listDiff(before.tags || [], after.tags || []);
  if (tags.added.length) out.push(`added tag ${tags.added.join(", ")}`);
  if (tags.removed.length) out.push(`removed tag ${tags.removed.join(", ")}`);

  const deps = listDiff(prev.dependencies || [], next.dependencies || []);
  if (deps.added.length) out.push(`added ${deps.added.length} blocker(s)`);
  if (deps.removed.length) out.push(`removed ${deps.removed.length} blocker(s)`);

  const people = listDiff(prev.assignedTo || [], next.assignedTo || []);
  if (people.added.length) out.push(`assigned ${people.added.join(", ")}`);
  if (people.removed.length) out.push(`unassigned ${people.removed.join(", ")}`);

  return out;
}
