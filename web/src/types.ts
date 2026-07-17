// Mirrors the JSON shapes emitted by the Go API (api/internal/domain).

export type Status = "todo" | "in_progress" | "done";
export const STATUSES: Status[] = ["todo", "in_progress", "done"];

export interface Project {
  id: string;
  name: string;
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
  title: string;
  status: Status;
  assignedTo: string[];
  configuration: TaskConfiguration;
  dependencies: string[];
  createdAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  content: string;
  author: string;
  createdAt: string;
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
