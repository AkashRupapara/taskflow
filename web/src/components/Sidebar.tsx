import { useState } from "react";
import { getActor, setActor } from "../lib/actor";
import type { Project } from "../types";

interface Props {
  projects: Project[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

// Project navigation rail.
export function Sidebar({ projects, selected, onSelect, onCreate }: Props) {
  const [name, setName] = useState(getActor());

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

      {/* Display name used to attribute changes in the activity log. */}
      <div className="sidebar-user">
        <label className="sidebar-user-label">You</label>
        <input
          className="sidebar-user-input"
          value={name}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setActor(name)}
        />
      </div>
    </aside>
  );
}
