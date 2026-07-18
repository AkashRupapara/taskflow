import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Sync } from "../hooks/useProjectSync";
import { STATUSES, type Status } from "../types";
import { Column } from "./Column";
import { byPosition } from "../lib/order";

// The Kanban board: three status columns with drag-and-drop between them.
// Dropping a card onto a column moves the task to that status. Opening a task
// is handled by the parent (onOpen) so the detail panel can render beside the
// board without blocking it.
export function Board({ sync, onOpen }: { sync: Sync; onOpen: (id: string) => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const tasks = Object.values(sync.tasks);

  // A small drag threshold so a plain click still opens the card (vs. dragging).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const id = String(e.active.id);
    const dest = e.over?.id as Status | undefined; // droppable id === status
    const task = sync.tasks[id];
    if (dest && task && task.status !== dest) {
      sync.moveTask(id, dest); // optimistic move + realtime broadcast
    }
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={(e) => setDragId(String(e.active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragId(null)}
      >
        <div className="board">
          {STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasks.filter((t) => t.status === status).sort(byPosition)}
              sync={sync}
              onOpen={onOpen}
            />
          ))}
        </div>
        {/* Floating preview of the card being dragged. */}
        <DragOverlay>
          {dragId && sync.tasks[dragId] ? (
            <article className="card dragging">
              <div className="card-title">{sync.tasks[dragId].title}</div>
            </article>
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}
