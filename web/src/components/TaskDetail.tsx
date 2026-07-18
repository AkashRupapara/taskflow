import { useEffect, useRef, useState } from "react";
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL } from "../constants";
import type { Sync } from "../hooks/useProjectSync";
import { STATUSES, type Status, type Task } from "../types";

interface Props {
  task: Task;
  sync: Sync;
  onClose: () => void;
}

// Right-hand side panel (like Jira's issue view). It is NOT a modal: there is no
// backdrop, so the board stays fully interactive while a task is open. Title and
// description are uncontrolled and keyed by task id, so an incoming realtime
// update won't overwrite what you're typing.
export function TaskDetail({ task, sync, onClose }: Props) {
  const [text, setText] = useState("");
  const [addingDep, setAddingDep] = useState(false);
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

  // Resolve dependency ids to their live task objects (may be missing if deleted).
  const blockers = task.dependencies.map((id) => sync.tasks[id]).filter(Boolean) as Task[];
  const openBlockers = blockers.filter((b) => b.status !== "done");

  // Candidate tasks to link as a new blocker: everything except self + current deps.
  const candidates = Object.values(sync.tasks)
    .filter((t) => t.id !== task.id && !task.dependencies.includes(t.id))
    .slice(0, 200);

  const linkDep = (id: string) => {
    if (!id) return;
    sync.editTask(task.id, { dependencies: [...task.dependencies, id] });
    setAddingDep(false);
  };
  const unlinkDep = (id: string) =>
    sync.editTask(task.id, { dependencies: task.dependencies.filter((d) => d !== id) });

  return (
    <aside className="detail-panel">
      <div className="detail-top">
        {sync.project && (
          <span className="detail-id">
            {sync.project.key}-{task.number}
          </span>
        )}
        <button className="close" onClick={onClose}>
          ✕
        </button>
      </div>

      <input
        key={task.id + "-title"}
        className="field-input title"
        defaultValue={task.title}
        onBlur={(e) => sync.editTask(task.id, { title: e.target.value.trim() || task.title })}
      />

      <div className="field-row">
        <div>
          <label className="field-label">Status</label>
          <select
            className="field-input"
            value={task.status}
            onChange={(e) => sync.moveTask(task.id, e.target.value as Status)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label">Priority</label>
          <select
            className="field-input"
            value={task.configuration.priority || ""}
            onChange={(e) => sync.editTask(task.id, { priority: e.target.value })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {openBlockers.length > 0 && (
        <div className="blocked-note">
          Blocked by {openBlockers.length} open task{openBlockers.length > 1 ? "s" : ""} - can't be
          marked Done until they're closed.
        </div>
      )}

      <label className="field-label">Description</label>
      <textarea
        key={task.id + "-desc"}
        className="field-input"
        rows={4}
        placeholder="Add a description…"
        defaultValue={task.configuration.description}
        onBlur={(e) => sync.editTask(task.id, { description: e.target.value })}
      />

      <label className="field-label">Blocked by</label>
      <div className="deps">
        {blockers.length === 0 && <p className="muted">No dependencies.</p>}
        {blockers.map((b) => (
          <div key={b.id} className="dep">
            <span className={"dep-status " + b.status}>{STATUS_LABEL[b.status]}</span>
            <span className="dep-title">
              {sync.project?.key}-{b.number} {b.title}
            </span>
            <button className="del-inline" onClick={() => unlinkDep(b.id)}>
              ✕
            </button>
          </div>
        ))}
        {addingDep && candidates.length > 0 ? (
          <select
            autoFocus
            className="field-input"
            defaultValue=""
            onChange={(e) => linkDep(e.target.value)}
            onBlur={() => setAddingDep(false)}
          >
            <option value="">Select a blocking task…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {sync.project?.key}-{t.number} {t.title}
              </option>
            ))}
          </select>
        ) : (
          candidates.length > 0 && (
            <button className="ghost-btn small" onClick={() => setAddingDep(true)}>
              + Add dependency
            </button>
          )
        )}
      </div>

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
    </aside>
  );
}
