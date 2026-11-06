import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

export const MAX_TODOS = 30;
const MAX_TEXT = 200;

const TodoItemSchema = z.object({
  content: z.string().describe('The step, imperative ("Run the tests").'),
  activeForm: z.string().describe('The same step while it runs ("Running the tests").'),
  status: z.enum(TODO_STATUSES),
});

const TodoWriteParams = z.object({
  todos: z.array(TodoItemSchema).describe("The whole list; replaces the previous one."),
});

/**
 * Validate a todo list from model args or a persisted tool call. Returns the
 * cleaned list, or an error naming the first problem.
 */
export function parseTodos(value: unknown): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "todos must be an array." };
  if (value.length > MAX_TODOS) return { error: `At most ${MAX_TODOS} todos.` };
  const todos: TodoItem[] = [];
  for (const [i, raw] of value.entries()) {
    const item = raw as Partial<Record<keyof TodoItem, unknown>> | null;
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    const activeForm = typeof item?.activeForm === "string" ? item.activeForm.trim() : "";
    const status = item?.status;
    if (!content) return { error: `Todo ${i + 1} needs content.` };
    if (!TODO_STATUSES.includes(status as TodoStatus))
      return { error: `Todo ${i + 1} has an unknown status.` };
    todos.push({
      content: content.slice(0, MAX_TEXT),
      activeForm: (activeForm || content).slice(0, MAX_TEXT),
      status: status as TodoStatus,
    });
  }
  if (todos.filter((t) => t.status === "in_progress").length > 1)
    return { error: "Only one todo can be in_progress at a time." };
  return { todos };
}

export function summarizeTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    `Todo list updated: ${done}/${todos.length} done.` +
    (current ? ` In progress: ${current.content}.` : "")
  );
}

export function createTodoWriteTool(): AgentTool<typeof TodoWriteParams> {
  return {
    name: "todo_write",
    description:
      "Show the user a live checklist for work with 3+ distinct steps. Send the whole list each " +
      "time; keep exactly one step in_progress while working and mark each completed as soon as " +
      "it is done. Skip it for single-step or trivial requests.",
    parameters: TodoWriteParams,
    executionMode: "sequential",
    execute({ todos }) {
      const parsed = parseTodos(todos);
      if ("error" in parsed) return `Error: ${parsed.error}`;
      return summarizeTodos(parsed.todos);
    },
  };
}
