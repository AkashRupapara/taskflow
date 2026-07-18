// Fractional ranking for manual ordering.
//
// Moving a task means giving it a position between its new neighbours, so a
// reorder is one row update instead of renumbering the whole list. Pure
// functions, so the ranking rules are unit tested rather than trusted.
import type { Task } from "../types";

// Position for a task moved to sit between prev and next (either may be absent
// at the ends of the list).
export function positionBetween(prev?: Task, next?: Task): number {
  if (!prev && !next) return 1; // empty list
  if (!prev) return next!.position - 1; // moved to the top
  if (!next) return prev.position + 1; // moved to the bottom
  return (prev.position + next.position) / 2; // midpoint
}

// Position for a task dragged from `fromIndex` and dropped onto `toIndex`.
// Dropping downward lands it after the target, upward lands it before, which is
// what makes a drag feel like it "takes the slot" you dropped on.
// Returns null when the position wouldn't change.
export function positionForDrop(ordered: Task[], fromIndex: number, toIndex: number): number | null {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return null;
  return fromIndex < toIndex
    ? positionBetween(ordered[toIndex], ordered[toIndex + 1]) // moved down
    : positionBetween(ordered[toIndex - 1], ordered[toIndex]); // moved up
}

// Sort helper matching the server's ORDER BY (position, id).
export function byPosition(a: Task, b: Task): number {
  return a.position - b.position || a.id.localeCompare(b.id);
}
