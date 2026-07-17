import type { Project } from "../types";

interface Props {
  projects: Project[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

// Project navigation rail.
export function Sidebar({ projects, selected, onSelect, onCreate }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h2>Projects</h2>
        <button onClick={onCreate}>+</button>
      </div>
      {projects.map((p) => (
        <button
          key={p.id}
          className={"project" + (p.id === selected ? " active" : "")}
          onClick={() => onSelect(p.id)}
        >
          {p.name}
        </button>
      ))}
    </aside>
  );
}
