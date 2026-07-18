// REST client. All calls go through the Vite proxy to the Go API, so paths are
// relative (/api/...). Mutations return the updated entity.
import type { Comment, Event, NewTaskInput, Project, Task, TaskConfiguration } from "../types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  listProjects: () => req<Project[]>("/projects"),
  getProject: (id: string) => req<Project>(`/projects/${id}`),
  createProject: (name: string) =>
    req<Project>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  // PATCH replaces the whole project, so callers pass the full current values.
  updateProject: (
    id: string,
    input: { name: string; description: string; metadata: Record<string, unknown> }
  ) => req<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  // Task lists are cursor-paginated; walk all pages for the board snapshot.
  listAllTasks: async (projectId: string): Promise<Task[]> => {
    const out: Task[] = [];
    let cursor = "";
    do {
      const page = await req<{ items: Task[]; nextCursor: string }>(
        `/projects/${projectId}/tasks?limit=200&cursor=${cursor}`
      );
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  },

  createTask: (projectId: string, input: NewTaskInput) =>
    req<Task>(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTask: (
    id: string,
    patch: Partial<{
      title: string;
      status: string;
      configuration: TaskConfiguration;
      dependencies: string[];
    }>
  ) => req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (id: string) => req<{ status: string }>(`/tasks/${id}`, { method: "DELETE" }),

  // Full ordered event history for a project (paginated by version).
  listAllEvents: async (projectId: string): Promise<Event[]> => {
    const out: Event[] = [];
    let since = 0;
    for (;;) {
      const batch = await req<Event[]>(`/projects/${projectId}/events?since=${since}&limit=500`);
      out.push(...batch);
      if (batch.length < 500) break;
      since = batch[batch.length - 1].version;
    }
    return out;
  },

  listComments: (taskId: string) => req<Comment[]>(`/tasks/${taskId}/comments`),
  addComment: (taskId: string, content: string, author: string) =>
    req<Comment>(`/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content, author }),
    }),
};
