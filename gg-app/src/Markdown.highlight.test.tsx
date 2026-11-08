// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type * as RehypeHighlight from "rehype-highlight";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  sendPrompt: vi.fn(),
}));

// Count every highlight pass (one per block rendered with the plugin).
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock("rehype-highlight", async (importOriginal) => {
  const actual = await importOriginal<typeof RehypeHighlight>();
  return {
    default: (...args: Parameters<typeof actual.default>) => {
      const transform = actual.default(...args);
      return (...run: Parameters<typeof transform>) => {
        calls.count += 1;
        return transform(...run);
      };
    },
  };
});

import { Markdown } from "./Markdown";

describe("Markdown streaming highlight cost", () => {
  it("doesn't re-highlight a finished code block when a new delta arrives", () => {
    const head = "```js\nconst a = 1;\n```\n\nHello";
    const { container, rerender } = render(<Markdown animate>{head}</Markdown>);
    expect(container.querySelector("code.hljs, code .hljs-keyword")).not.toBeNull();
    const before = calls.count;
    rerender(<Markdown animate>{`${head} world`}</Markdown>);
    rerender(<Markdown animate>{`${head} world again`}</Markdown>);
    // Only the growing paragraph re-renders; the code block stays memoized.
    expect(calls.count - before).toBe(2);
  });

  it("shows a still-open fence as plain code and highlights it once it closes", () => {
    const { container, rerender } = render(<Markdown animate>{"```js\nconst a"}</Markdown>);
    expect(container.querySelector("code")?.textContent).toContain("const a");
    expect(calls.count).toBeGreaterThanOrEqual(0);
    const before = calls.count;
    rerender(<Markdown animate>{"```js\nconst a = 1;"}</Markdown>);
    expect(calls.count).toBe(before);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    rerender(<Markdown animate>{"```js\nconst a = 1;\n```"}</Markdown>);
    expect(calls.count).toBe(before + 1);
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });
});
