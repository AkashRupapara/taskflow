import { buildActivity, relativeTime } from "../lib/activity";
import type { Event, Project } from "../types";

interface Props {
  events: Event[];
  project: Project;
  taskId?: string; // when set, show only this task's activity
}

// "Who changed what, when", derived from the event log. Used both at project
// level (the History > Activity tab) and inside a task's detail panel.
export function ActivityFeed({ events, project, taskId }: Props) {
  const feed = buildActivity(events, project.key).filter((a) => !taskId || a.taskId === taskId);

  if (feed.length === 0) return <p className="muted">No activity yet.</p>;

  return (
    <ul className="activity">
      {feed.map((a) => (
        <li key={a.version} className="activity-item">
          <div className="activity-main">
            <strong>{a.actor}</strong>{" "}
            {!taskId && a.ref && (
              <>
                <span className="activity-ref">{a.ref}</span>{" "}
                {a.title && <span className="activity-task">{a.title}</span>}{" "}
              </>
            )}
            <span className="activity-change">{a.lines.join(" · ")}</span>
          </div>
          <div className="activity-when muted" title={new Date(a.at).toLocaleString()}>
            {relativeTime(a.at)}
          </div>
        </li>
      ))}
    </ul>
  );
}
