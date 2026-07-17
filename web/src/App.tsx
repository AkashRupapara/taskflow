import { useEffect, useState } from "react";
import { api } from "./api/client";
import { useProjectSync } from "./hooks/useProjectSync";
import { Sidebar } from "./components/Sidebar";
import { Board } from "./components/Board";
import type { Project } from "./types";
import "./styles.css";

// Top-level layout: owns the project list + selection, and renders the board
// for the selected project. All realtime state lives in useProjectSync.
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
      <Sidebar
        projects={projects}
        selected={selected}
        onSelect={setSelected}
        onCreate={addProject}
      />
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
