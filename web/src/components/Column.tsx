import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
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

const ROW_HEIGHT = 78; // estimated card height incl. margin, for the virtualizer

// A droppable status column. Its droppable id is the status itself, so a drop
// tells the board exactly which status to move the task into. The card list is
// virtualized, so a column with thousands of tasks only renders visible rows.
export function Column({ status, tasks, sync, onOpen }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });

  return (
    <section ref={setNodeRef} className={"column" + (isOver ? " over" : "")}>
      <h3>
        {STATUS_LABEL[status]} <span className="count">{tasks.length}</span>
      </h3>

      <div ref={scrollRef} className="column-scroll">
        {/* Spacer sized to the full list; only visible rows are mounted. */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const task = tasks[row.index];
            return (
              <div
                key={task.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <TaskCard task={task} sync={sync} onOpen={onOpen} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
