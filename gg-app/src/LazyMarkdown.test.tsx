// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent", () => ({
  openProjectPath: vi.fn(),
  openUrl: vi.fn(),
  readChatImage: vi.fn(),
  sendPrompt: vi.fn(),
}));

import { Markdown, preloadMarkdown } from "./LazyMarkdown";

afterEach(cleanup);

describe("LazyMarkdown", () => {
  it(
    "shows the fallback until the renderer loads, then formatted markdown",
    { timeout: 30_000 },
    async () => {
      const view = render(
        <Suspense fallback={<p>loading</p>}>
          <Markdown>{"**bold**"}</Markdown>
        </Suspense>,
      );
      await act(async () => {
        await preloadMarkdown();
      });
      await vi.waitFor(() =>
        expect(view.container.querySelector("strong")?.textContent).toBe("bold"),
      );
    },
  );

  it("renders without suspending once loaded", { timeout: 30_000 }, async () => {
    await preloadMarkdown();
    const view = render(
      <Suspense fallback={<p>loading</p>}>
        <Markdown>{"*it*"}</Markdown>
      </Suspense>,
    );
    expect(view.container.querySelector("em")?.textContent).toBe("it");
  });
});
