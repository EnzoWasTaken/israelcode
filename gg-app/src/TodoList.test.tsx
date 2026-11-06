// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodoList, TodoPill } from "./TodoList";
import { parseTodos, type TodoItem } from "./todos";

afterEach(cleanup);

const todos: TodoItem[] = [
  { content: "Read the code", activeForm: "Reading the code", status: "completed" },
  { content: "Fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
  { content: "Run the tests", activeForm: "Running the tests", status: "pending" },
];

describe("TodoList", () => {
  it("shows every step live, with the running one in its active wording", () => {
    render(<TodoList todos={todos} />);
    expect(screen.getByText("1/3 done")).not.toBeNull();
    expect(screen.getByText("Fixing the bug")).not.toBeNull();
    expect(screen.getByText("Run the tests")).not.toBeNull();
    expect(screen.getAllByRole("listitem")[0]?.textContent).toContain(", done");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Tasks/ }).disabled).toBe(true);
  });

  it("folds to its summary once settled and unfolds on click", () => {
    render(<TodoList todos={todos} settled />);
    const head = screen.getByRole("button", { name: /Tasks/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fix the bug")).not.toBeNull();
  });
});

describe("TodoPill", () => {
  it("names the current step and progress", () => {
    render(<TodoPill todos={todos} />);
    expect(screen.getByRole("status", { name: "Tasks: 1 of 3 done" }).textContent).toContain(
      "Fixing the bug",
    );
  });

  it("hides once every step is done", () => {
    const { container } = render(
      <TodoPill todos={todos.map((t) => ({ ...t, status: "completed" as const }))} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("parseTodos", () => {
  it("rejects what the tool rejects", () => {
    expect(parseTodos("x")).toBeNull();
    expect(parseTodos([{ content: "", activeForm: "", status: "pending" }])).toBeNull();
    expect(
      parseTodos([
        { content: "a", activeForm: "a", status: "in_progress" },
        { content: "b", activeForm: "b", status: "in_progress" },
      ]),
    ).toBeNull();
    expect(parseTodos([{ content: "a", status: "pending" }])).toEqual([
      { content: "a", activeForm: "a", status: "pending" },
    ]);
  });
});
