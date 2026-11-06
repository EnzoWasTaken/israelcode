import { describe, expect, it } from "vitest";
import { createTodoWriteTool, MAX_TODOS, parseTodos, summarizeTodos } from "./todo-write.js";

const item = (content: string, status: "pending" | "in_progress" | "completed") => ({
  content,
  activeForm: `${content}ing`,
  status,
});

describe("todo_write", () => {
  it("accepts a list and reports progress", async () => {
    const tool = createTodoWriteTool();
    const out = await tool.execute(
      { todos: [item("Read", "completed"), item("Fix", "in_progress"), item("Test", "pending")] },
      {} as never,
    );
    expect(out).toBe("Todo list updated: 1/3 done. In progress: Fix.");
  });

  it("rejects two in-progress steps", () => {
    expect(parseTodos([item("A", "in_progress"), item("B", "in_progress")])).toEqual({
      error: "Only one todo can be in_progress at a time.",
    });
  });

  it("rejects empty content, unknown status and oversized lists", () => {
    expect(parseTodos([item("  ", "pending")])).toEqual({ error: "Todo 1 needs content." });
    expect(parseTodos([{ content: "A", activeForm: "A", status: "doing" }])).toEqual({
      error: "Todo 1 has an unknown status.",
    });
    const many = Array.from({ length: MAX_TODOS + 1 }, (_, i) => item(`S${i}`, "pending"));
    expect("error" in parseTodos(many)).toBe(true);
    expect(parseTodos("nope")).toEqual({ error: "todos must be an array." });
  });

  it("falls back to content when activeForm is missing and trims long text", () => {
    const parsed = parseTodos([{ content: "x".repeat(300), status: "pending" }]);
    expect("todos" in parsed && parsed.todos[0]).toEqual({
      content: "x".repeat(200),
      activeForm: "x".repeat(200),
      status: "pending",
    });
  });

  it("summarizes an empty list as cleared", () => {
    expect(summarizeTodos([])).toBe("Todo list cleared.");
  });
});
