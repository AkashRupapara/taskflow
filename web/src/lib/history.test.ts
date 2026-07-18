import { describe, expect, it } from "vitest";
import { eventAt, reconstructTasks } from "./history";
import type { Event, Task } from "../types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: "p1",
  number: 1,
  title: id,
  status: "todo",
  assignedTo: [],
  configuration: { priority: "", description: "", tags: [], customFields: {} },
  dependencies: [],
  createdAt: "2026-07-17T00:00:00Z",
  ...over,
});

const ev = (version: number, type: Event["type"], payload: any): Event => ({
  id: version,
  projectId: "p1",
  version,
  type,
  payload,
  actor: "",
  createdAt: "2026-07-17T00:00:00Z",
});

// A -> created, A -> moved to done, B -> created, A -> deleted
const log: Event[] = [
  ev(1, "task.created", task("a", { status: "todo" })),
  ev(2, "task.updated", task("a", { status: "done" })),
  ev(3, "task.created", task("b")),
  ev(4, "task.deleted", { id: "a" }),
];

describe("reconstructTasks", () => {
  it("returns an empty board at version 0", () => {
    expect(reconstructTasks(log, 0)).toEqual({});
  });

  it("reflects a task's state mid-history", () => {
    const at2 = reconstructTasks(log, 2);
    expect(Object.keys(at2)).toEqual(["a"]);
    expect(at2.a.status).toBe("done"); // moved by v2
  });

  it("includes a task created later", () => {
    expect(Object.keys(reconstructTasks(log, 3)).sort()).toEqual(["a", "b"]);
  });

  it("reflects deletion at the latest version", () => {
    expect(Object.keys(reconstructTasks(log, 4))).toEqual(["b"]); // a deleted at v4
  });
});

describe("eventAt", () => {
  it("returns the change that produced the viewed version", () => {
    expect(eventAt(log, 2)?.type).toBe("task.updated");
  });
  it("returns undefined at version 0", () => {
    expect(eventAt(log, 0)).toBeUndefined();
  });
});
