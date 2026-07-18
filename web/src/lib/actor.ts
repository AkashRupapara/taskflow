// Who the current user is, for attributing changes in the activity log.
//
// Tradeoff: this is a client-supplied display name kept in localStorage, NOT an
// authenticated identity - there is no login in this build. It is sent as the
// X-Actor header and stored on each event. When real auth is added, the server
// derives the actor from the session instead and every existing event still
// reads correctly.
const KEY = "taskflow.actor";

export function getActor(): string {
  return localStorage.getItem(KEY) || "Anonymous";
}

export function setActor(name: string): void {
  localStorage.setItem(KEY, name.trim() || "Anonymous");
}
