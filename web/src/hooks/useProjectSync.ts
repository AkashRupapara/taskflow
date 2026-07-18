// useProjectSync owns one project's realtime state. It loads a snapshot once,
// then keeps it current by applying deltas from the WebSocket. Mutations are
// optimistic: apply locally now, reconcile on the server's echoed event, roll
// back if the request fails.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../api/client";
import { wsURL } from "../api/ws";
import { applyTaskEvent } from "../lib/applyEvent";

import type { Comment, Event, NewTaskInput, Project, Status, Task } from "../types";

// Fields editable on an existing task (all optional / partial update).
export interface TaskEdit {
  title?: string;
  description?: string;
  priority?: string;
  dependencies?: string[];
}

type TaskMap = Record<string, Task>;

// A reversible snapshot of a task's editable fields. Undo/redo restore these.
interface Snap {
  title: string;
  status: Status;
  configuration: Task["configuration"];
  dependencies: string[];
}
interface HistoryEntry {
  id: string;
  before: Snap;
  after: Snap;
}
const snapOf = (t: Task): Snap => ({
  title: t.title,
  status: t.status,
  configuration: t.configuration,
  dependencies: t.dependencies,
});

export interface Sync {
  project: Project | null;
  tasks: TaskMap;
  comments: Record<string, Comment[]>; // by taskId, loaded lazily
  connected: boolean;
  error: string | null;
  createTask: (input: NewTaskInput) => Promise<void>; // throws on failure
  moveTask: (id: string, status: Status) => Promise<void>;
  editTask: (id: string, fields: TaskEdit) => Promise<void>;
  reorderTask: (id: string, position: number) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  loadComments: (taskId: string) => Promise<void>;
  addComment: (taskId: string, content: string) => Promise<void>;
  editProject: (fields: { name?: string; description?: string }) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

export function useProjectSync(projectId: string | null): Sync {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<TaskMap>({});
  const [comments, setComments] = useState<Record<string, Comment[]>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Highest event version applied, so we ignore anything we've already seen.
  const version = useRef(0);

  // Undo/redo stacks of this client's own task changes. Held in refs (mutated
  // imperatively); `bump` forces a re-render so canUndo/canRedo stay current.
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const record = useCallback((id: string, before: Snap, after: Snap) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return; // no-op change
    undoStack.current.push({ id, before, after });
    redoStack.current = []; // a new action clears the redo branch
    bump();
  }, []);

  const applyEvent = useCallback((ev: Event) => {
    if (ev.version <= version.current) return; // already applied (dedupe)
    version.current = ev.version;
    switch (ev.type) {
      case "task.created":
      case "task.updated":
      case "task.deleted":
        setTasks((t) => applyTaskEvent(t, ev));
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
      undoStack.current = []; // history is per-project
      redoStack.current = [];
      bump();

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
    async (input: NewTaskInput) => {
      if (!projectId) return;
      // Errors bubble to the caller (the create modal shows them inline and
      // stays open); the echoed task.created event fills in the card.
      await api.createTask(projectId, input);
    },
    [projectId]
  );

  // applySnapshot restores a task's editable fields to a given snapshot. Used by
  // undo/redo; does not touch the history stacks. Returns success.
  const applySnapshot = useCallback(
    async (id: string, snap: Snap): Promise<boolean> => {
      const prev = tasks[id];
      if (!prev) return false; // task no longer exists (e.g. deleted)
      setError(null);
      setTasks((t) => ({ ...t, [id]: { ...prev, ...snap } })); // optimistic
      try {
        await api.updateTask(id, {
          title: snap.title,
          status: snap.status,
          configuration: snap.configuration,
          dependencies: snap.dependencies,
        });
        return true;
      } catch (e) {
        setTasks((t) => ({ ...t, [id]: prev })); // rollback
        setError(String(e));
        return false;
      }
    },
    [tasks]
  );

  const moveTask = useCallback(
    async (id: string, status: Status) => {
      const prev = tasks[id];
      if (!prev) return;
      setError(null); // clear any stale error from a previous action
      setTasks((t) => ({ ...t, [id]: { ...prev, status } })); // optimistic
      try {
        // expectedRev: reject rather than clobber if someone else changed this
        // task since we read it. The response carries the new rev.
        const saved = await api.updateTask(id, { status, expectedRev: prev.rev });
        setTasks((t) => ({ ...t, [id]: saved })); // authoritative state (fresh rev)
        record(id, snapOf(prev), snapOf(saved)); // for undo
      } catch (e) {
        setTasks((t) => ({ ...t, [id]: prev })); // rollback on failure
        setError(String(e));
      }
    },
    [tasks, record]
  );

  const editTask = useCallback(
    async (id: string, fields: TaskEdit) => {
      const prev = tasks[id];
      if (!prev) return;
      setError(null); // clear any stale error from a previous action
      // Merge onto the existing config so we don't wipe fields we aren't
      // changing (PATCH replaces the whole configuration object).
      const next: Task = {
        ...prev,
        title: fields.title ?? prev.title,
        dependencies: fields.dependencies ?? prev.dependencies,
        configuration: {
          ...prev.configuration,
          description: fields.description ?? prev.configuration.description,
          priority: fields.priority ?? prev.configuration.priority,
        },
      };
      setTasks((t) => ({ ...t, [id]: next })); // optimistic
      try {
        const saved = await api.updateTask(id, {
          title: next.title,
          configuration: next.configuration,
          dependencies: next.dependencies,
          expectedRev: prev.rev, // reject instead of clobbering a concurrent edit
        });
        setTasks((t) => ({ ...t, [id]: saved })); // authoritative state (fresh rev)
        record(id, snapOf(prev), snapOf(saved)); // for undo
      } catch (e) {
        setTasks((t) => ({ ...t, [id]: prev })); // rollback
        setError(String(e));
      }
    },
    [tasks, record]
  );

  // Place a task at a given fractional position in the manual ordering. Only the
  // moved task changes; the caller computes the position from its neighbours.
  const reorderTask = useCallback(
    async (id: string, position: number) => {
      const prev = tasks[id];
      if (!prev) return;
      setError(null);
      setTasks((t) => ({ ...t, [id]: { ...prev, position } })); // optimistic
      try {
        const saved = await api.updateTask(id, { position, expectedRev: prev.rev });
        setTasks((t) => ({ ...t, [id]: saved }));
      } catch (e) {
        setTasks((t) => ({ ...t, [id]: prev })); // rollback
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

  const editProject = useCallback(
    async (fields: { name?: string; description?: string }) => {
      if (!project) return;
      const next: Project = {
        ...project,
        name: fields.name ?? project.name,
        description: fields.description ?? project.description,
      };
      if (next.name === project.name && next.description === project.description) return;
      setProject(next); // optimistic
      try {
        await api.updateProject(project.id, {
          name: next.name,
          description: next.description,
          metadata: (project.metadata ?? {}) as Record<string, unknown>,
        });
      } catch (e) {
        setProject(project); // rollback
        setError(String(e));
      }
    },
    [project]
  );

  const undo = useCallback(async () => {
    const entry = undoStack.current[undoStack.current.length - 1];
    if (!entry) return;
    if (await applySnapshot(entry.id, entry.before)) {
      undoStack.current.pop();
      redoStack.current.push(entry);
      bump();
    }
  }, [applySnapshot]);

  const redo = useCallback(async () => {
    const entry = redoStack.current[redoStack.current.length - 1];
    if (!entry) return;
    if (await applySnapshot(entry.id, entry.after)) {
      redoStack.current.pop();
      undoStack.current.push(entry);
      bump();
    }
  }, [applySnapshot]);

  return {
    project,
    tasks,
    comments,
    connected,
    error,
    createTask,
    moveTask,
    editTask,
    reorderTask,
    deleteTask,
    loadComments,
    addComment,
    editProject,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}
