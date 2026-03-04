import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTodosTool, getTodosState } from "./todos-tool.js";

type TodosDetails = {
  items: Array<{
    id: number;
    text: string;
    status: "pending" | "in_progress" | "completed" | "blocked";
    reason?: string;
  }>;
  stats: {
    pending: number;
    in_progress: number;
    blocked: number;
    completed: number;
    total: number;
  };
  binding?: {
    kb?: { path: string; title: string; section?: string };
  };
  allDone: boolean;
  kbFinalizeSuggested: boolean;
};

async function runTodos(params: { sessionId: string; args: Record<string, unknown> }) {
  const tool = createTodosTool({ sessionId: params.sessionId });
  const result = await tool.execute("t1", params.args);
  return result as { content: Array<{ type: string; text?: string }>; details: TodosDetails };
}

describe("todos tool", () => {
  it("set creates items with pending state and correct stats", async () => {
    const sessionId = crypto.randomUUID();

    const result = await runTodos({
      sessionId,
      args: { action: "set", title: "My Task", items: ["one", "two"] },
    });

    expect(result.details.items).toEqual([
      expect.objectContaining({ id: 1, text: "one", status: "pending" }),
      expect.objectContaining({ id: 2, text: "two", status: "pending" }),
    ]);
    expect(result.details.stats).toEqual({
      pending: 2,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      total: 2,
    });
    expect(result.content[0]?.text ?? "").toContain("**Title:** My Task");
  });

  it("add appends to an existing list", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    const result = await runTodos({ sessionId, args: { action: "add", text: "b" } });

    expect(result.details.items.map((item) => item.text)).toEqual(["a", "b"]);
    expect(result.details.items.map((item) => item.id)).toEqual([1, 2]);
    expect(result.details.stats.total).toBe(2);
  });

  it("remove deletes by id", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a", "b"] } });
    const result = await runTodos({ sessionId, args: { action: "remove", id: 1 } });

    expect(result.details.items.map((item) => item.id)).toEqual([2]);
    expect(result.details.items.map((item) => item.text)).toEqual(["b"]);
    expect(result.details.stats.total).toBe(1);
  });

  it("start sets in_progress and demotes prior in_progress to pending", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a", "b"] } });
    await runTodos({ sessionId, args: { action: "start", id: 1 } });
    const result = await runTodos({ sessionId, args: { action: "start", id: 2 } });

    const item1 = result.details.items.find((item) => item.id === 1);
    const item2 = result.details.items.find((item) => item.id === 2);
    expect(item1?.status).toBe("pending");
    expect(item2?.status).toBe("in_progress");
    expect(result.details.stats.in_progress).toBe(1);
  });

  it("complete marks items as completed and sets allDone when everything is completed", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a", "b"] } });
    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const result = await runTodos({ sessionId, args: { action: "complete", id: 2 } });

    expect(result.details.stats.completed).toBe(2);
    expect(result.details.allDone).toBe(true);
    expect(result.details.kbFinalizeSuggested).toBe(false);
  });

  it("block and unblock transition status and reason", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    const blocked = await runTodos({
      sessionId,
      args: { action: "block", id: 1, reason: "waiting" },
    });
    expect(blocked.details.items[0]?.status).toBe("blocked");
    expect(blocked.details.items[0]?.reason).toBe("waiting");

    const unblocked = await runTodos({ sessionId, args: { action: "unblock", id: 1 } });
    expect(unblocked.details.items[0]?.status).toBe("pending");
    expect(unblocked.details.items[0]?.reason).toBeUndefined();
  });

  it("bind stores KB metadata and enables kbFinalizeSuggested when allDone", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    const bound = await runTodos({
      sessionId,
      args: { action: "bind", path: "memory/kb/tasks/TASKS.md", kbTitle: "Task", section: "X" },
    });
    expect(bound.details.binding?.kb).toEqual({
      path: "memory/kb/tasks/TASKS.md",
      title: "Task",
      section: "X",
    });
    expect(bound.content[0]?.text ?? "").toContain("**KB:** Task");

    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const listed = await runTodos({ sessionId, args: { action: "list" } });
    expect(listed.details.allDone).toBe(true);
    expect(listed.details.kbFinalizeSuggested).toBe(true);
  });

  it("clear resets items and binding", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({
      sessionId,
      args: { action: "bind", path: "memory/kb/tasks/TASKS.md", kbTitle: "Task" },
    });
    await runTodos({ sessionId, args: { action: "clear" } });

    const result = await runTodos({ sessionId, args: { action: "list" } });
    expect(result.details.items).toEqual([]);
    expect(result.details.stats.total).toBe(0);
    expect(result.details.binding).toBeUndefined();
  });

  it("list returns correct stats", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a", "b", "c"] } });
    await runTodos({ sessionId, args: { action: "start", id: 2 } });
    await runTodos({ sessionId, args: { action: "block", id: 3 } });
    await runTodos({ sessionId, args: { action: "complete", id: 1 } });

    const result = await runTodos({ sessionId, args: { action: "list" } });
    expect(result.details.stats).toEqual({
      pending: 0,
      in_progress: 1,
      blocked: 1,
      completed: 1,
      total: 3,
    });
  });

  it("isolates todos across session ids", async () => {
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();

    await runTodos({ sessionId: sessionA, args: { action: "set", items: ["a"] } });
    const result = await runTodos({ sessionId: sessionB, args: { action: "list" } });

    expect(result.details.items).toEqual([]);
    expect(result.details.stats.total).toBe(0);
  });

  it("errors on unknown id", async () => {
    const sessionId = crypto.randomUUID();
    const tool = createTodosTool({ sessionId });

    await tool.execute("t1", { action: "set", items: ["a"] });
    await expect(tool.execute("t1", { action: "remove", id: 999 })).rejects.toThrow(
      "Unknown todo id: 999",
    );
  });

  it("start on completed item throws", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const tool = createTodosTool({ sessionId });
    await expect(tool.execute("t1", { action: "start", id: 1 })).rejects.toThrow(
      "already completed",
    );
  });

  it("start on blocked item throws", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "block", id: 1 } });
    const tool = createTodosTool({ sessionId });
    await expect(tool.execute("t1", { action: "start", id: 1 })).rejects.toThrow("blocked");
  });

  it("block on completed item throws", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const tool = createTodosTool({ sessionId });
    await expect(tool.execute("t1", { action: "block", id: 1 })).rejects.toThrow(
      "already completed",
    );
  });

  it("unblock on non-blocked item throws", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    const tool = createTodosTool({ sessionId });
    await expect(tool.execute("t1", { action: "unblock", id: 1 })).rejects.toThrow("not blocked");
  });

  it("complete is idempotent on already-completed items", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const result = await runTodos({ sessionId, args: { action: "complete", id: 1 } });

    expect(result.details.items[0]?.status).toBe("completed");
    expect(result.details.allDone).toBe(true);
  });

  it("set overwrites previous list and resets nextId", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a", "b", "c"] } });
    await runTodos({ sessionId, args: { action: "add", text: "d" } });
    // Now nextId should be 5. After set, it should reset.
    const result = await runTodos({ sessionId, args: { action: "set", items: ["x"] } });

    expect(result.details.items).toEqual([expect.objectContaining({ id: 1, text: "x" })]);
    // Add another — should get id 2, not 5
    const added = await runTodos({ sessionId, args: { action: "add", text: "y" } });
    expect(added.details.items[1]?.id).toBe(2);
  });

  it("set with empty items produces allDone=false", async () => {
    const sessionId = crypto.randomUUID();

    const result = await runTodos({ sessionId, args: { action: "set", items: [] } });
    expect(result.details.items).toEqual([]);
    expect(result.details.allDone).toBe(false);
  });

  it("set clears stale binding", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({
      sessionId,
      args: { action: "bind", path: "memory/kb/tasks/TASKS.md", kbTitle: "Old Task" },
    });
    const result = await runTodos({ sessionId, args: { action: "set", items: ["b"] } });

    expect(result.details.binding).toBeUndefined();
  });

  it("finish sets finished=true and stores finishReason", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "finish", reason: "blocked" } });

    const state = getTodosState(sessionId);
    expect(state?.finished).toBe(true);
    expect(state?.finishReason).toBe("blocked");
  });

  it("set resets finished to false", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    await runTodos({ sessionId, args: { action: "finish", reason: "blocked" } });
    await runTodos({ sessionId, args: { action: "set", items: ["b"] } });

    const state = getTodosState(sessionId);
    expect(state?.finished).toBe(false);
  });

  it("complete sets lastCompletedAt", async () => {
    const sessionId = crypto.randomUUID();

    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    expect(getTodosState(sessionId)?.lastCompletedAt).toBeUndefined();

    await runTodos({ sessionId, args: { action: "complete", id: 1 } });
    const lastCompletedAt = getTodosState(sessionId)?.lastCompletedAt;
    expect(lastCompletedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(lastCompletedAt!))).toBe(false);
  });

  it("getTodosState returns state or undefined", async () => {
    const sessionId = crypto.randomUUID();

    expect(getTodosState(sessionId)).toBeUndefined();
    await runTodos({ sessionId, args: { action: "set", items: ["a"] } });
    expect(getTodosState(sessionId)?.sessionId).toBe(sessionId);
  });
});
