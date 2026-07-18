// Pure reducer for applying a realtime event to the task map. Kept separate from
// the hook so it can be unit-tested without React or a WebSocket.
import type { Event, Task } from "../types";

export type TaskMap = Record<string, Task>;

// applyTaskEvent returns the next task map after applying one event. It is a
// pure function: same inputs -> same output, no mutation of the input.
export function applyTaskEvent(tasks: TaskMap, ev: Event): TaskMap {
  switch (ev.type) {
    case "task.created":
    case "task.updated":
      return { ...tasks, [ev.payload.id]: ev.payload as Task };
    case "task.deleted": {
      const next = { ...tasks };
      delete next[ev.payload.id];
      return next;
    }
    default:
      return tasks; // project.updated / comment.added handled elsewhere
  }
}
