import { useState } from "react";
import { api } from "../api/client";
import type { Project } from "../types";

interface Props {
  onCreated: (p: Project) => void;
  onClose: () => void;
}

// Modal for creating a project (name + description), mirroring the task modal.
export function ProjectModal({ onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const p = await api.createProject(name.trim());
      // If a description was given, save it right after creation.
      const finalProject = description.trim()
        ? await api.updateProject(p.id, { name: p.name, description: description.trim(), metadata: {} })
        : p;
      onCreated(finalProject);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Create project</h2>
          <button className="close" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="field-label">Name</label>
        <input
          autoFocus
          className="field-input"
          value={name}
          placeholder="e.g. Website Redesign"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <label className="field-label">Description</label>
        <textarea
          className="field-input"
          rows={3}
          value={description}
          placeholder="What is this project about?"
          onChange={(e) => setDescription(e.target.value)}
        />

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
