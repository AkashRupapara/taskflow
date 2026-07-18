// Mirrors the JSON shapes emitted by the Go API (api/internal/domain).

export type Status = "todo" | "in_progress" | "done";
export const STATUSES: Status[] = ["todo", "in_progress", "done"];

export interface Project {
  id: string;
  name: string;
  key: string; // short code for task ids, e.g. "WR"
  description: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: string;
}

export interface TaskConfiguration {
  priority: string;
  description: string;
  tags: string[] | null;
  customFields: Record<string, unknown> | null;
}

export interface Task {
  id: string;
  projectId: string;
  number: number; // sequential per project; display id is `${project.key}-${number}`
  title: string;
  status: Status;
  assignedTo: string[];
  configuration: TaskConfiguration;
  dependencies: string[];
  createdAt: string;
  rev: number; // bumped on each update; sent back as expectedRev for optimistic concurrency
  position: number; // fractional rank for manual ordering (backlog view)
}

export interface Comment {
  id: string;
  taskId: string;
  content: string;
  author: string;
  createdAt: string;
}

// Payload for creating a task (mirrors the Go store.TaskInput).
export interface NewTaskInput {
  title: string;
  status: Status;
  configuration: TaskConfiguration;
  dependencies: string[];
  assignedTo: string[];
}

// One entry from the append-only log, delivered over the WebSocket.
export interface Event {
  id: number;
  projectId: string;
  version: number;
  type:
    | "task.created"
    | "task.updated"
    | "task.deleted"
    | "comment.added"
    | "project.updated";
  payload: any;
  actor: string;
  createdAt: string;
}
