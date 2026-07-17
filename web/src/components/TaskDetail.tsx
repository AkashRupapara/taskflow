import { useEffect, useRef, useState } from "react";
import { STATUS_LABEL } from "../constants";
import type { Sync } from "../hooks/useProjectSync";
import type { Task } from "../types";

interface Props {
  task: Task;
  sync: Sync;
  onClose: () => void;
}

// Slide-over panel showing a task's details and its realtime comment thread.
export function TaskDetail({ task, sync, onClose }: Props) {
  const [text, setText] = useState("");
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

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose}>
          ✕
        </button>
        <h2>{task.title}</h2>
        <p className="muted">Status: {STATUS_LABEL[task.status]}</p>

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
      </div>
    </div>
  );
}
