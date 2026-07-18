import { useState } from "react";
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL } from "../constants";
import type { Sync } from "../hooks/useProjectSync";
import { STATUSES, type Status } from "../types";

// Jira-style "Create task" modal: title, description, priority, and initial
// status. Dependencies are linked afterwards from the task detail drawer.
export function TaskModal({ sync, onClose }: { sync: Sync; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [status, setStatus] = useState<Status>("todo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await sync.createTask({
        title: title.trim(),
        status,
        configuration: { priority, description: description.trim(), tags: [], customFields: {} },
        dependencies: [],
        assignedTo: [],
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Create task</h2>
          <button className="close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field-label">Title</label>
        <input
          autoFocus
          className="field-input"
          value={title}
          placeholder="What needs to be done?"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <label className="field-label">Description</label>
        <textarea
          className="field-input"
          rows={3}
          value={description}
          placeholder="Add more detail…"
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="field-row">
          <div>
            <label className="field-label">Status</label>
            <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Priority</label>
            <select className="field-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" onClick={submit} disabled={saving}>
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
