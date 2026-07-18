import { useEffect, useState } from "react";
import { api } from "./api/client";
import { useProjectSync } from "./hooks/useProjectSync";
import { Sidebar } from "./components/Sidebar";
import { Board } from "./components/Board";
import { TaskModal } from "./components/TaskModal";
import { ProjectModal } from "./components/ProjectModal";
import { TaskDetail } from "./components/TaskDetail";
import type { Project } from "./types";
import "./styles.css";

// Top-level layout: owns the project list + selection, and renders the board
// for the selected project. The task detail sits beside the board as a panel
// (not a modal), so the board stays interactive while a task is open.
export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const sync = useProjectSync(selected);

  const refreshProjects = () =>
    api.listProjects().then((ps) => {
      setProjects(ps);
      setSelected((cur) => cur ?? ps[0]?.id ?? null);
    });

  useEffect(() => {
    refreshProjects();
  }, []);

  // Close the detail panel when switching projects.
  useEffect(() => {
    setOpenTask(null);
  }, [selected]);

  // Keyboard shortcuts: Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z to redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) sync.redo();
        else sync.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sync.undo, sync.redo]);

  const onProjectCreated = async (p: Project) => {
    setCreatingProject(false);
    await refreshProjects();
    setSelected(p.id);
  };

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selected={selected}
        onSelect={setSelected}
        onCreate={() => setCreatingProject(true)}
      />
      <main className="main">
        {sync.project ? (
          <>
            <header className="board-head">
              <h1>{sync.project.name}</h1>
              <span className={"conn " + (sync.connected ? "on" : "off")}>
                {sync.connected ? "● live" : "○ offline"}
              </span>
              <div className="head-actions">
                <button
                  className="ghost-btn small"
                  onClick={() => sync.undo()}
                  disabled={!sync.canUndo}
                  title="Undo (Cmd/Ctrl+Z)"
                >
                  ↶ Undo
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => sync.redo()}
                  disabled={!sync.canRedo}
                  title="Redo (Cmd/Ctrl+Shift+Z)"
                >
                  ↷ Redo
                </button>
                <button className="primary-btn" onClick={() => setCreatingTask(true)}>
                  + New Task
                </button>
              </div>
            </header>
            {/* Editable project description (saved on blur, broadcast to others). */}
            <input
              key={sync.project.id + "-desc"}
              className="project-desc"
              placeholder="Add a project description…"
              defaultValue={sync.project.description}
              onBlur={(e) => sync.editProject({ description: e.target.value })}
            />
            {sync.error && <div className="error">{sync.error}</div>}
            <Board sync={sync} onOpen={setOpenTask} />
            {creatingTask && <TaskModal sync={sync} onClose={() => setCreatingTask(false)} />}
          </>
        ) : (
          <p className="empty">Select or create a project.</p>
        )}
      </main>

      {/* Detail panel is a flex sibling of main, so the board stays interactive. */}
      {openTask && sync.tasks[openTask] && (
        <TaskDetail task={sync.tasks[openTask]} sync={sync} onClose={() => setOpenTask(null)} />
      )}

      {creatingProject && (
        <ProjectModal onCreated={onProjectCreated} onClose={() => setCreatingProject(false)} />
      )}
    </div>
  );
}
