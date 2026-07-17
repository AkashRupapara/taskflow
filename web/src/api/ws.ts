// WebSocket URL for a project's realtime stream, resuming after version `since`.
export function wsURL(projectId: string, since: number): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws?projectId=${projectId}&since=${since}`;
}
