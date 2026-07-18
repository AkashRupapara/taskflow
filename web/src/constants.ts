import type { Status } from "./types";

// Human-readable column/status labels (UI concern, kept out of the domain types).
export const STATUS_LABEL: Record<Status, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

// Task priority options (empty string = none). Styled via .prio.<value> in CSS.
export const PRIORITIES = ["", "low", "medium", "high"] as const;
export const PRIORITY_LABEL: Record<string, string> = {
  "": "None",
  low: "Low",
  medium: "Medium",
  high: "High",
};
