// The checklist the coding agent keeps with its `todo_write` tool. Mirrors
// ggcoder's tools/todo-write.ts parseTodos, which the sidecar runs on restore.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];
const MAX_TODOS = 30;

/** A list from a `todo_write` call, or null when the tool would reject it. */
export function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_TODOS) return null;
  const todos: TodoItem[] = [];
  for (const raw of value) {
    const item = raw as Partial<Record<keyof TodoItem, unknown>> | null;
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    const activeForm = typeof item?.activeForm === "string" ? item.activeForm.trim() : "";
    if (!content || !STATUSES.includes(item?.status as string)) return null;
    todos.push({ content, activeForm: activeForm || content, status: item?.status as TodoStatus });
  }
  if (todos.filter((t) => t.status === "in_progress").length > 1) return null;
  return todos;
}

export function todoProgress(todos: readonly TodoItem[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}
