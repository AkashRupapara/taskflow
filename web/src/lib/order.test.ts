import { describe, expect, it } from "vitest";
import { byPosition, positionBetween, positionForDrop } from "./order";
import type { Task } from "../types";

const task = (id: string, position: number): Task => ({
  id,
  projectId: "p1",
  number: 1,
  title: id,
  status: "todo",
  assignedTo: [],
  configuration: { priority: "", description: "", tags: [], customFields: {} },
  dependencies: [],
  createdAt: "2026-07-17T00:00:00Z",
  rev: 0,
  position,
});

describe("positionBetween", () => {
  it("takes the midpoint between two neighbours", () => {
    expect(positionBetween(task("a", 1), task("b", 2))).toBe(1.5);
  });
  it("goes before the first item when moved to the top", () => {
    expect(positionBetween(undefined, task("a", 1))).toBe(0);
  });
  it("goes after the last item when moved to the bottom", () => {
    expect(positionBetween(task("a", 5), undefined)).toBe(6);
  });
  it("handles an empty list", () => {
    expect(positionBetween(undefined, undefined)).toBe(1);
  });
});

describe("positionForDrop", () => {
  const list = [task("a", 1), task("b", 2), task("c", 3), task("d", 4)];
  const applyMove = (id: string, position: number) =>
    [...list.map((t) => (t.id === id ? { ...t, position } : t))]
      .sort(byPosition)
      .map((t) => t.id);

  it("dragging an item down places it after the drop target", () => {
    const p = positionForDrop(list, 0, 2)!; // a dropped on c
    expect(applyMove("a", p)).toEqual(["b", "c", "a", "d"]);
  });

  it("dragging an item up places it before the drop target", () => {
    const p = positionForDrop(list, 3, 1)!; // d dropped on b
    expect(applyMove("d", p)).toEqual(["a", "d", "b", "c"]);
  });

  it("dragging to the very top works", () => {
    const p = positionForDrop(list, 2, 0)!; // c dropped on a
    expect(applyMove("c", p)).toEqual(["c", "a", "b", "d"]);
  });

  it("dragging to the very bottom works", () => {
    const p = positionForDrop(list, 0, 3)!; // a dropped on d
    expect(applyMove("a", p)).toEqual(["b", "c", "d", "a"]);
  });

  it("returns null when dropped on itself", () => {
    expect(positionForDrop(list, 1, 1)).toBeNull();
  });
});
