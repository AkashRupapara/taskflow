import { describe, expect, it } from "vitest";
import { applyTaskEvent, type TaskMap } from "./applyEvent";
import type { Event, Task } from "../types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: "p1",
  number: 1,
  title: "Task " + id,
  status: "todo",
  assignedTo: [],
  configuration: { priority: "", description: "", tags: [], customFields: {} },
  dependencies: [],
  createdAt: "2026-07-17T00:00:00Z",
  rev: 0,
  position: 1,
  ...over,
});

const event = (type: Event["type"], payload: any): Event => ({
  id: 1,
  projectId: "p1",
  version: 1,
  type,
  payload,
  actor: "",
  createdAt: "2026-07-17T00:00:00Z",
});

describe("applyTaskEvent", () => {
  it("adds a task on task.created", () => {
    const next = applyTaskEvent({}, event("task.created", task("a")));
    expect(Object.keys(next)).toEqual(["a"]);
  });

  it("upserts by id on task.updated (idempotent, no duplicates)", () => {
    const start: TaskMap = { a: task("a", { title: "Old" }) };
    const next = applyTaskEvent(start, event("task.updated", task("a", { title: "New" })));
    expect(Object.keys(next)).toEqual(["a"]);
    expect(next.a.title).toBe("New");
  });

  it("removes a task on task.deleted", () => {
    const start: TaskMap = { a: task("a"), b: task("b") };
    const next = applyTaskEvent(start, event("task.deleted", { id: "a" }));
    expect(Object.keys(next)).toEqual(["b"]);
  });

  it("does not mutate the input map", () => {
    const start: TaskMap = { a: task("a") };
    applyTaskEvent(start, event("task.created", task("b")));
    expect(Object.keys(start)).toEqual(["a"]);
  });

  it("ignores non-task events", () => {
    const start: TaskMap = { a: task("a") };
    const next = applyTaskEvent(start, event("comment.added", { id: "c1", taskId: "a" }));
    expect(next).toBe(start);
  });
});
