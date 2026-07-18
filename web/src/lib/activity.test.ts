import { describe, expect, it } from "vitest";
import { buildActivity, relativeTime } from "./activity";
import { diffTasks } from "./diff";
import type { Event, Task } from "../types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: "p1",
  number: 3,
  title: "Build homepage",
  status: "todo",
  assignedTo: [],
  configuration: { priority: "", description: "", tags: [], customFields: {} },
  dependencies: [],
  createdAt: "2026-07-17T00:00:00Z",
  rev: 0,
  position: 1,
  ...over,
});

const ev = (version: number, type: Event["type"], payload: any, actor = "Akash"): Event => ({
  id: version,
  projectId: "p1",
  version,
  type,
  payload,
  actor,
  createdAt: "2026-07-17T00:00:00Z",
});

describe("diffTasks", () => {
  it("describes a status change", () => {
    const lines = diffTasks(task("a"), task("a", { status: "in_progress" }));
    expect(lines).toEqual(["status To Do → In Progress"]);
  });

  it("describes priority, description and tag changes together", () => {
    const before = task("a");
    const after = task("a", {
      configuration: { priority: "high", description: "hi", tags: ["ui"], customFields: {} },
    });
    expect(diffTasks(before, after)).toEqual([
      "priority none → high",
      "edited the description",
      "added tag ui",
    ]);
  });

  it("returns nothing when nothing changed", () => {
    expect(diffTasks(task("a"), task("a"))).toEqual([]);
  });
});

describe("buildActivity", () => {
  const log: Event[] = [
    ev(1, "task.created", task("a")),
    ev(2, "task.updated", task("a", { status: "done" }), "Dhruvi"),
    ev(3, "comment.added", { id: "c1", taskId: "a", content: "nice", author: "Sam" }),
  ];

  it("returns newest-first with actor attribution", () => {
    const feed = buildActivity(log, "WR");
    expect(feed.map((a) => a.version)).toEqual([3, 2, 1]);
    expect(feed[1].actor).toBe("Dhruvi");
  });

  it("derives the field-level change for an update", () => {
    const feed = buildActivity(log, "WR");
    expect(feed[1].lines).toEqual(["status To Do → Done"]);
    expect(feed[1].ref).toBe("WR-3");
  });

  it("labels creation and comments", () => {
    const feed = buildActivity(log, "WR");
    expect(feed[2].lines).toEqual(["created this task"]);
    expect(feed[0].kind).toBe("comment");
    // The event actor (who performed the action) wins over the comment's author.
    expect(feed[0].actor).toBe("Akash");
  });

  it("falls back to the comment author when the event has no actor", () => {
    const anon = ev(1, "comment.added", { id: "c1", taskId: "a", content: "hi", author: "Sam" }, "");
    expect(buildActivity([anon], "WR")[0].actor).toBe("Sam");
  });

  it("falls back to 'someone' when the actor is unknown", () => {
    const feed = buildActivity([ev(1, "task.created", task("a"), "")], "WR");
    expect(feed[0].actor).toBe("someone");
  });
});

describe("relativeTime", () => {
  const base = new Date("2026-07-17T12:00:00Z").getTime();
  it("formats recent and older times", () => {
    expect(relativeTime("2026-07-17T11:59:50Z", base)).toBe("just now");
    expect(relativeTime("2026-07-17T11:30:00Z", base)).toBe("30m ago");
    expect(relativeTime("2026-07-17T09:00:00Z", base)).toBe("3h ago");
    expect(relativeTime("2026-07-15T12:00:00Z", base)).toBe("2d ago");
  });
});
