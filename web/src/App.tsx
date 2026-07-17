import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useProjectSync } from "./useProjectSync";
import { STATUSES, type Project, type Status, type Task } from "./types";
import "./styles.css";

const STATUS_LABEL: Record<Status, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const sync = useProjectSync(selected);

  const refreshProjects = () =>
    api.listProjects().then((ps) => {
      setProjects(ps);
      setSelected((cur) => cur ?? ps[0]?.id ?? null);
    });
  useEffect(() => {
    refreshProjects();
  }, []);

  const addProject = async () => {
    const name = prompt("Project name?");
    if (!name) return;
    const p = await api.createProject(name);
    await refreshProjects();
    setSelected(p.id);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h2>Projects</h2>
          <button onClick={addProject}>+</button>
        </div>
        {projects.map((p) => (
          <button
            key={p.id}
            className={"project" + (p.id === selected ? " active" : "")}
            onClick={() => setSelected(p.id)}
          >
            {p.name}
          </button>
        ))}
      </aside>

      <main className="main">
        {sync.project ? (
          <>
            <header className="board-head">
              <h1>{sync.project.name}</h1>
              <span className={"conn " + (sync.connected ? "on" : "off")}>
                {sync.connected ? "● live" : "○ offline"}
              </span>
            </header>
            {sync.error && <div className="error">{sync.error}</div>}
            <Board sync={sync} />
          </>
        ) : (
          <p className="empty">Select or create a project.</p>
        )}
      </main>
    </div>
  );
}

function Board({ sync }: { sync: ReturnType<typeof useProjectSync> }) {
  const [openTask, setOpenTask] = useState<string | null>(null);
  const tasks = Object.values(sync.tasks);

  return (
    <>
      <div className="board">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={tasks.filter((t) => t.status === status)}
            sync={sync}
            onOpen={setOpenTask}
          />
        ))}
      </div>
      {openTask && sync.tasks[openTask] && (
        <TaskDetail task={sync.tasks[openTask]} sync={sync} onClose={() => setOpenTask(null)} />
      )}
    </>
  );
}

function Column({
  status,
  tasks,
  sync,
  onOpen,
}: {
  status: Status;
  tasks: Task[];
  sync: ReturnType<typeof useProjectSync>;
  onOpen: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const add = () => {
    if (!title.trim()) return;
    sync.createTask(title.trim());
    setTitle("");
  };

  return (
    <section className="column">
      <h3>
        {STATUS_LABEL[status]} <span className="count">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <article key={t.id} className="card" onClick={() => onOpen(t.id)}>
          <div className="card-title">{t.title}</div>
          <div className="card-meta">
            {t.configuration.priority && (
              <span className={"prio " + t.configuration.priority}>
                {t.configuration.priority}
              </span>
            )}
            {(t.configuration.tags || []).map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
          <div className="card-actions" onClick={(e) => e.stopPropagation()}>
            <select
              value={t.status}
              onChange={(e) => sync.moveTask(t.id, e.target.value as Status)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button className="del" onClick={() => sync.deleteTask(t.id)}>
              ✕
            </button>
          </div>
        </article>
      ))}
      {status === "todo" && (
        <div className="add">
          <input
            value={title}
            placeholder="New task…"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button onClick={add}>Add</button>
        </div>
      )}
    </section>
  );
}

function TaskDetail({
  task,
  sync,
  onClose,
}: {
  task: Task;
  sync: ReturnType<typeof useProjectSync>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const comments = sync.comments[task.id] || [];
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (loadedFor.current !== task.id) {
      loadedFor.current = task.id;
      sync.loadComments(task.id);
    }
  }, [task.id, sync]);

  const send = () => {
    if (!text.trim()) return;
    sync.addComment(task.id, text.trim());
    setText("");
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{task.title}</h2>
        <p className="muted">Status: {STATUS_LABEL[task.status]}</p>

        <h4>Comments</h4>
        <div className="comments">
          {comments.length === 0 && <p className="muted">No comments yet.</p>}
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <b>{c.author}</b> {c.content}
            </div>
          ))}
        </div>
        <div className="add">
          <input
            value={text}
            placeholder="Add a comment…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
