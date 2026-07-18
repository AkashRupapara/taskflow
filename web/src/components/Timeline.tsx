import { useEffect, useMemo, useRef, useState } from "react";
import { STATUS_LABEL } from "../constants";
import { eventAt, reconstructTasks } from "../lib/history";
import { STATUSES, type Event, type Project } from "../types";

const EVENT_VERB: Record<Event["type"], string> = {
  "task.created": "created",
  "task.updated": "updated",
  "task.deleted": "deleted",
  "comment.added": "commented on",
  "project.updated": "updated project",
};

function describeEvent(ev: Event | undefined, key: string): string {
  if (!ev) return "Empty board (before any changes)";
  const p = ev.payload;
  const ref = p && typeof p.number === "number" ? `${key}-${p.number} ${p.title ?? ""}` : "";
  return `${EVENT_VERB[ev.type]} ${ref}`.trim();
}

// Local date + hour:minute, e.g. "Jul 17, 2026, 6:46 PM".
function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Time-travel view: replays the project's event log so you can scrub the board
// back to any past version. Read-only; the parent owns "Back to live".
export function Timeline({ project, events }: { project: Project; events: Event[] }) {
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<{ v: number; x: number } | null>(null);

  const maxVersion = events.length ? events[events.length - 1].version : 0;

  // Timestamp of the state as of a version (the last event at or before it).
  const tsAt = (v: number): string | null => {
    const e = eventAt(events, v);
    return e ? fmt(e.createdAt) : null;
  };

  // Start at "now" whenever the log changes.
  useEffect(() => {
    setVersion(maxVersion);
  }, [maxVersion]);

  // Playback: step forward ~600ms until we reach the end.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setVersion((v) => {
        if (v >= maxVersion) {
          setPlaying(false);
          return v;
        }
        return v + 1;
      });
    }, 600);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, maxVersion]);

  const tasks = useMemo(
    () => Object.values(reconstructTasks(events, version)),
    [events, version]
  );
  const current = eventAt(events, version);

  return (
    <div className="history">
      <div className="history-bar">
        <button
          className="ghost-btn small"
          onClick={() => {
            if (version >= maxVersion) setVersion(0); // replay from start
            setPlaying((p) => !p);
          }}
          disabled={maxVersion === 0}
        >
          {playing ? "Pause" : "Play"}
        </button>

        <div className="history-slider-wrap">
          <input
            className="history-slider"
            type="range"
            min={0}
            max={maxVersion}
            value={version}
            onChange={(e) => {
              setPlaying(false);
              setVersion(Number(e.target.value));
            }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setHover({ v: Math.round(ratio * maxVersion), x: e.clientX - rect.left });
            }}
            onMouseLeave={() => setHover(null)}
          />
          {hover && (
            <div className="history-tip" style={{ left: hover.x }}>
              v{hover.v} · {tsAt(hover.v) ?? "start"}
            </div>
          )}
        </div>

        <span className="history-pos">
          v{version} / {maxVersion}
        </span>
      </div>

      <div className="history-caption">
        <span>
          <strong>Viewing v{version}</strong>
          {" · "}
          {tsAt(version) ?? "before any changes"}
          {current && <span className="muted"> · {describeEvent(current, project.key)}</span>}
        </span>
        {maxVersion > 0 && (
          <span className="history-latest muted">Latest v{maxVersion} · {tsAt(maxVersion)}</span>
        )}
      </div>

      <div className="board history-board">
        {STATUSES.map((status) => {
          const inCol = tasks.filter((t) => t.status === status);
          return (
            <section className="column" key={status}>
              <h3>
                {STATUS_LABEL[status]} <span className="count">{inCol.length}</span>
              </h3>
              <div className="column-scroll">
                {inCol.map((t) => (
                  <article className="card" key={t.id} style={{ cursor: "default" }}>
                    <div className="card-id">
                      {project.key}-{t.number}
                    </div>
                    <div className="card-title">{t.title}</div>
                    <div className="card-meta">
                      {t.configuration.priority && (
                        <span className={"prio " + t.configuration.priority}>
                          {t.configuration.priority}
                        </span>
                      )}
                      {(t.configuration.tags || []).map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
