import { useEffect, useState } from "react";

// Phase 0 smoke test: confirm the browser -> Vite proxy -> Go API -> Postgres
// path is wired end to end. Real UI (project list, Kanban) lands in later phases.
export function App() {
  const [status, setStatus] = useState("checking...");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setStatus(d.status))
      .catch(() => setStatus("unreachable"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>TaskFlow</h1>
      <p>
        API health: <strong>{status}</strong>
      </p>
    </main>
  );
}
