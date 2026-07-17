// useProjectSync owns one project's realtime state. It loads a snapshot once,
// then keeps it current by applying deltas from the WebSocket. Mutations are
// optimistic: apply locally now, reconcile on the server's echoed event, roll
// back if the request fails.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { wsURL } from "../api/ws";
import type { Comment, Event, Project, Status, Task } from "../types";

type TaskMap = Record<string, Task>;

export interface Sync {
  project: Project | null;
  tasks: TaskMap;
  comments: Record<string, Comment[]>; // by taskId, loaded lazily
  connected: boolean;
  error: string | null;
  createTask: (title: string) => Promise<void>;
  moveTask: (id: string, status: Status) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  loadComments: (taskId: string) => Promise<void>;
  addComment: (taskId: string, content: string) => Promise<void>;
}

export function useProjectSync(projectId: string | null): Sync {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<TaskMap>({});
  const [comments, setComments] = useState<Record<string, Comment[]>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Highest event version applied, so we ignore anything we've already seen.
  const version = useRef(0);

  const applyEvent = useCallback((ev: Event) => {
    if (ev.version <= version.current) return; // already applied (dedupe)
    version.current = ev.version;
    switch (ev.type) {
      case "task.created":
      case "task.updated":
        setTasks((t) => ({ ...t, [ev.payload.id]: ev.payload as Task }));
        break;
      case "task.deleted":
        setTasks((t) => {
          const next = { ...t };
          delete next[ev.payload.id];
          return next;
        });
        break;
      case "project.updated":
        setProject(ev.payload as Project);
        break;
      case "comment.added": {
        const c = ev.payload as Comment;
        // Append only if this task's thread is currently loaded/open.
        setComments((all) =>
          all[c.taskId] ? { ...all, [c.taskId]: [...all[c.taskId], c] } : all
        );
        break;
      }
    }
  }, []);

  // Load snapshot + open the socket whenever the selected project changes.
  useEffect(() => {
    if (!projectId) return;
    let ws: WebSocket | null = null;
    let cancelled = false;

    (async () => {
      setError(null);
      const p = await api.getProject(projectId);
      const list = await api.listAllTasks(projectId);
      if (cancelled) return;

      setProject(p);
      setTasks(Object.fromEntries(list.map((t) => [t.id, t])));
      version.current = p.version; // resume the stream after the snapshot

      ws = new WebSocket(wsURL(projectId, p.version));
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (e) => applyEvent(JSON.parse(e.data) as Event);
    })().catch((e) => setError(String(e)));

    return () => {
      cancelled = true;
      ws?.close();
      setConnected(false);
    };
  }, [projectId, applyEvent]);

  const createTask = useCallback(
    async (title: string) => {
      if (!projectId) return;
      // The echoed task.created event will upsert by id (idempotent), so we just
      // fire the request and let the stream fill in the card.
      try {
        await api.createTask(projectId, title);
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId]
  );

  const moveTask = useCallback(
    async (id: string, status: Status) => {
      const prev = tasks[id];
      if (!prev) return;
      setTasks((t) => ({ ...t, [id]: { ...prev, status } })); // optimistic
      try {
        await api.updateTask(id, { status });
      } catch (e) {
        setTasks((t) => ({ ...t, [id]: prev })); // rollback on failure
        setError(String(e));
      }
    },
    [tasks]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      const prev = tasks[id];
      setTasks((t) => {
        const next = { ...t };
        delete next[id];
        return next;
      });
      try {
        await api.deleteTask(id);
      } catch (e) {
        if (prev) setTasks((t) => ({ ...t, [id]: prev })); // rollback
        setError(String(e));
      }
    },
    [tasks]
  );

  const loadComments = useCallback(async (taskId: string) => {
    const list = await api.listComments(taskId);
    setComments((all) => ({ ...all, [taskId]: list }));
  }, []);

  const addComment = useCallback(async (taskId: string, content: string) => {
    // The echoed comment.added event appends it to the thread (see applyEvent).
    try {
      await api.addComment(taskId, content, "you");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return {
    project,
    tasks,
    comments,
    connected,
    error,
    createTask,
    moveTask,
    deleteTask,
    loadComments,
    addComment,
  };
}
