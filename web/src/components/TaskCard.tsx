import { useDraggable } from "@dnd-kit/core";
import type { Sync } from "../hooks/useProjectSync";
import type { Task } from "../types";

interface Props {
  task: Task;
  sync: Sync;
  onOpen: (id: string) => void;
}

// A draggable task card. Click (without dragging) opens the detail drawer.
export function TaskCard({ task, sync, onOpen }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={"card" + (isDragging ? " ghost" : "")}
      onClick={() => onOpen(task.id)}
    >
      <button
        className="del"
        onClick={(e) => {
          e.stopPropagation();
          sync.deleteTask(task.id);
        }}
      >
        ✕
      </button>
      {sync.project && <div className="card-id">{sync.project.key}-{task.number}</div>}
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        {task.configuration.priority && (
          <span className={"prio " + task.configuration.priority}>
            {task.configuration.priority}
          </span>
        )}
        {(task.configuration.tags || []).map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}
