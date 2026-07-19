import { relativeTime, type Activity } from "../lib/activity";

interface Props {
  items: Activity[];
  showTaskRef?: boolean; // project-level feeds name the task; a task's own feed doesn't
}

// "Who changed what, when", derived from the event log. Callers build the list
// (see buildActivity) so they can also use its length - e.g. for a collapsed
// section header - without walking the log twice.
export function ActivityFeed({ items, showTaskRef = false }: Props) {
  if (items.length === 0) return <p className="muted">No activity yet.</p>;

  return (
    <ul className="activity">
      {items.map((a) => (
        <li key={a.version} className="activity-item">
          <div className="activity-main">
            <strong>{a.actor}</strong>{" "}
            {showTaskRef && a.ref && (
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
