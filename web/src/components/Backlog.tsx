import { useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { STATUS_LABEL } from "../constants";
import type { Sync } from "../hooks/useProjectSync";
import { byPosition, positionForDrop } from "../lib/order";
import type { Task } from "../types";

const ROW_HEIGHT = 41; // estimated row height for the virtualizer

// Flat, ranked list of every task in the project. Unlike the board (grouped by
// status), this is the single prioritised backlog: drag a row onto another to
// reorder. Only the dragged task is written - it takes the midpoint position of
// its new neighbours - so a reorder is one row update, not a renumber.
//
// The list is virtualized, so a 10k-task backlog only mounts the visible rows.
export function Backlog({ sync, onOpen }: { sync: Sync; onOpen: (id: string) => void }) {
  const ordered = Object.values(sync.tasks).sort(byPosition);
  const [dragId, setDragId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Small threshold so a click still opens the task rather than starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const from = ordered.findIndex((t) => t.id === e.active.id);
    const to = ordered.findIndex((t) => t.id === e.over?.id);
    const position = positionForDrop(ordered, from, to);
    if (position !== null) sync.reorderTask(String(e.active.id), position);
  };

  if (ordered.length === 0) return <p className="empty">No tasks yet.</p>;

  return (
    <DndContext
      sensors={sensors}
      // A ranked list wants "nearest row to the cursor", not raw rect overlap -
      // otherwise a short drag resolves back onto the row you started from.
      collisionDetection={closestCenter}
      onDragStart={(e) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <div className="backlog" ref={scrollRef} role="list">
        {/* Spacer sized to the whole list; only visible rows are mounted. */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={ordered[row.index].id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: row.size,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <Row task={ordered[row.index]} rank={row.index + 1} sync={sync} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </div>

      <DragOverlay>
        {dragId && sync.tasks[dragId] ? (
          <div className="backlog-row dragging">
            <span className="backlog-id">
              {sync.project?.key}-{sync.tasks[dragId].number}
            </span>
            <span className="backlog-title">{sync.tasks[dragId].title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Row({
  task,
  rank,
  sync,
  onOpen,
}: {
  task: Task;
  rank: number;
  sync: Sync;
  onOpen: (id: string) => void;
}) {
  // Each row is both a drag handle and a drop target, so rows can swap places.
  const { attributes, listeners, setNodeRef: dragRef, isDragging } = useDraggable({ id: task.id });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: task.id });

  return (
    <div
      ref={dropRef}
      role="listitem"
      className={"backlog-row" + (isDragging ? " ghost" : "") + (isOver ? " over" : "")}
    >
      <span
        ref={dragRef}
        {...attributes}
        {...listeners}
        className="backlog-grip"
        title="Drag to reorder"
      >
        ⠿
      </span>
      <span className="backlog-rank">{rank}</span>

      <span className="backlog-open" onClick={() => onOpen(task.id)}>
        <span className="backlog-id">
          {sync.project?.key}-{task.number}
        </span>
        <span className="backlog-title">{task.title}</span>
      </span>

      <span className={"backlog-status " + task.status}>{STATUS_LABEL[task.status]}</span>
      {task.configuration.priority && (
        <span className={"prio " + task.configuration.priority}>{task.configuration.priority}</span>
      )}
    </div>
  );
}
