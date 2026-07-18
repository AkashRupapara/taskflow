import { useEffect, useState } from "react";
import { api } from "../api/client";
import { ActivityFeed } from "./ActivityFeed";
import { Timeline } from "./Timeline";
import type { Event, Project } from "../types";

// Two views over the same event log:
//   Activity      - who changed what, when (the practical audit trail)
//   Board at time - replay the board's exact state at any version (time-travel)
// The log is fetched once here and shared by both tabs.
export function History({ project, onClose }: { project: Project; onClose: () => void }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [tab, setTab] = useState<"activity" | "board">("activity");

  useEffect(() => {
    api.listAllEvents(project.id).then(setEvents);
  }, [project.id]);

  return (
    <div className="history">
      <div className="history-tabs">
        <button
          className={"tab" + (tab === "activity" ? " active" : "")}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          className={"tab" + (tab === "board" ? " active" : "")}
          onClick={() => setTab("board")}
        >
          Board at time
        </button>
        <button className="ghost-btn small history-exit" onClick={onClose}>
          ← Back to live
        </button>
      </div>

      {!events ? (
        <p className="empty">Loading history…</p>
      ) : tab === "activity" ? (
        <ActivityFeed events={events} project={project} />
      ) : (
        <Timeline project={project} events={events} />
      )}
    </div>
  );
}
