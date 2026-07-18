// Builds a human-readable activity feed from the append-only event log.
//
// It walks events in order, keeping the evolving task state so a task.updated
// event can be diffed against the previous snapshot of that same task. The
// result is a "who changed what, when" trail at both project and task level -
// another consumer of the same log that powers realtime sync and time-travel.
import { applyTaskEvent, type TaskMap } from "./applyEvent";
import { diffTasks } from "./diff";
import type { Comment, Event, Task } from "../types";

export type ActivityKind = "created" | "updated" | "deleted" | "comment" | "project";

export interface Activity {
  version: number;
  at: string; // ISO timestamp
  actor: string;
  kind: ActivityKind;
  taskId?: string;
  ref: string; // e.g. "WR-3", or "Project"
  title: string; // task title (or project name)
  lines: string[]; // the change(s) in plain language
}

const who = (ev: Event) => ev.actor || "someone";

// buildActivity returns entries newest-first.
export function buildActivity(events: Event[], projectKey: string): Activity[] {
  let tasks: TaskMap = {};
  const out: Activity[] = [];

  for (const ev of events) {
    const base = { version: ev.version, at: ev.createdAt, actor: who(ev) };

    switch (ev.type) {
      case "task.created": {
        const t = ev.payload as Task;
        out.push({
          ...base,
          kind: "created",
          taskId: t.id,
          ref: `${projectKey}-${t.number}`,
          title: t.title,
          lines: ["created this task"],
        });
        break;
      }
      case "task.updated": {
        const t = ev.payload as Task;
        const prev = tasks[t.id]; // state BEFORE this event
        const lines = prev ? diffTasks(prev, t) : [];
        out.push({
          ...base,
          kind: "updated",
          taskId: t.id,
          ref: `${projectKey}-${t.number}`,
          title: t.title,
          lines: lines.length ? lines : ["updated this task"],
        });
        break;
      }
      case "task.deleted": {
        const prev = tasks[ev.payload.id as string];
        out.push({
          ...base,
          kind: "deleted",
          taskId: ev.payload.id,
          ref: prev ? `${projectKey}-${prev.number}` : "",
          title: prev?.title ?? "a task",
          lines: ["deleted this task"],
        });
        break;
      }
      case "comment.added": {
        const c = ev.payload as Comment;
        const t = tasks[c.taskId];
        out.push({
          ...base,
          actor: ev.actor || c.author || "someone",
          kind: "comment",
          taskId: c.taskId,
          ref: t ? `${projectKey}-${t.number}` : "",
          title: t?.title ?? "",
          lines: [`commented: “${c.content}”`],
        });
        break;
      }
      case "project.updated": {
        out.push({
          ...base,
          kind: "project",
          ref: "Project",
          title: (ev.payload as { name?: string }).name ?? "",
          lines: ["updated project details"],
        });
        break;
      }
    }

    // Advance state AFTER recording, so the next diff sees the right "before".
    tasks = applyTaskEvent(tasks, ev);
  }

  return out.reverse(); // newest first
}

// Short relative time like "just now", "5m ago", "3h ago", "2d ago".
export function relativeTime(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
