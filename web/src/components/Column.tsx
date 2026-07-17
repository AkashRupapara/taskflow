import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { STATUS_LABEL } from "../constants";
import type { Sync } from "../hooks/useProjectSync";
import type { Status, Task } from "../types";
import { TaskCard } from "./TaskCard";

interface Props {
  status: Status;
  tasks: Task[];
  sync: Sync;
  onOpen: (id: string) => void;
}

// A droppable status column. Its droppable id is the status itself, so a drop
// tells the board exactly which status to move the task into.
export function Column({ status, tasks, sync, onOpen }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [title, setTitle] = useState("");

  const add = () => {
    if (!title.trim()) return;
    sync.createTask(title.trim());
    setTitle("");
  };

  return (
    <section ref={setNodeRef} className={"column" + (isOver ? " over" : "")}>
      <h3>
        {STATUS_LABEL[status]} <span className="count">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} sync={sync} onOpen={onOpen} />
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
