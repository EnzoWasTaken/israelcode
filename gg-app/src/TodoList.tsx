import { useId, useState } from "react";
import { ShimmerText } from "./ShimmerText";
import { todoProgress, type TodoItem } from "./todos";

const MARK: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

const STATUS_LABEL: Record<TodoItem["status"], string> = {
  pending: "to do",
  in_progress: "in progress",
  completed: "done",
};

/**
 * The agent's live checklist for one turn. While the run is going every step
 * shows; once it ends (`settled`) the list folds to its "3/7 done" summary.
 */
export function TodoList({
  todos,
  settled = false,
}: {
  todos: readonly TodoItem[];
  settled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { done, total } = todoProgress(todos);
  const expanded = !settled || open;
  return (
    <section className="todo-list" data-settled={settled || undefined} aria-label="Task list">
      <button
        type="button"
        className="todo-list-head"
        aria-expanded={expanded}
        aria-controls={listId}
        disabled={!settled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="todo-list-title">Tasks</span>
        <span className="todo-list-count">{total === 0 ? "cleared" : `${done}/${total} done`}</span>
      </button>
      {expanded && total > 0 && (
        <ol id={listId} className="todo-list-items">
          {todos.map((todo, i) => (
            <li key={`${i}-${todo.content}`} className="todo-row" data-status={todo.status}>
              <span className="todo-mark" aria-hidden="true">
                {MARK[todo.status]}
              </span>
              <span className="todo-text">
                {todo.status === "in_progress" && !settled ? (
                  <ShimmerText base="var(--text)">{todo.activeForm}</ShimmerText>
                ) : (
                  todo.content
                )}
              </span>
              <span className="sr-only">{`, ${STATUS_LABEL[todo.status]}`}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The current step and progress, pinned above the deck while a run is live. */
export function TodoPill({ todos }: { todos: readonly TodoItem[] }): React.ReactElement | null {
  const { done, total } = todoProgress(todos);
  const current = todos.find((t) => t.status === "in_progress");
  if (total === 0 || (!current && done === total)) return null;
  return (
    <div className="todo-pill" role="status" aria-label={`Tasks: ${done} of ${total} done`}>
      <span className="todo-mark" aria-hidden="true">
        {MARK.in_progress}
      </span>
      <span className="todo-pill-text">{current ? current.activeForm : "Next step"}</span>
      <span className="todo-list-count">{`${done}/${total}`}</span>
    </div>
  );
}
