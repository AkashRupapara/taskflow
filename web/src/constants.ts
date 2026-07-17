import type { Status } from "./types";

// Human-readable column/status labels (UI concern, kept out of the domain types).
export const STATUS_LABEL: Record<Status, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};
