// Time-travel: reconstruct the board's state at any past version by replaying
// the event log. This works precisely because the backend is event-sourced -
// each task event carries the full entity, so folding them left from an empty
// map yields the exact state at that point. Reuses the same applyTaskEvent
// reducer the live client uses, so history and live can never diverge.
import { applyTaskEvent, type TaskMap } from "./applyEvent";
import type { Event } from "../types";

// reconstructTasks folds events (ordered ascending by version) up to and
// including uptoVersion, returning the task map as it was at that moment.
export function reconstructTasks(events: Event[], uptoVersion: number): TaskMap {
  let tasks: TaskMap = {};
  for (const ev of events) {
    if (ev.version > uptoVersion) break;
    tasks = applyTaskEvent(tasks, ev);
  }
  return tasks;
}

// eventAt returns the latest event at or before the given version (the change
// that produced the currently-viewed state), or undefined at version 0.
export function eventAt(events: Event[], version: number): Event | undefined {
  let found: Event | undefined;
  for (const ev of events) {
    if (ev.version <= version) found = ev;
    else break;
  }
  return found;
}
