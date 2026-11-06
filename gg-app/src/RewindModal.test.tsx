// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RewindPoint } from "./agent";

const listRewindPoints = vi.hoisted(() => vi.fn<() => Promise<RewindPoint[]>>());
const rewindTo = vi.hoisted(() => vi.fn());
vi.mock("./agent", () => ({ listRewindPoints, rewindTo }));

const { RewindModal } = await import("./RewindModal");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const point = (n: number, prompt: string, files: string[] = []): RewindPoint => ({
  id: `cp-000${n}`,
  turnIndex: n,
  timestamp: Date.UTC(2026, 10, 6, 10, n),
  changedFileCount: files.length,
  summary: files.join(", "),
  files,
  prompt,
});

describe("RewindModal", () => {
  it("lists points newest first and preselects the message it was opened on", async () => {
    listRewindPoints.mockResolvedValue([point(1, "add login"), point(2, "fix tests", ["a.ts"])]);
    render(<RewindModal initialPrompt="add login" onClose={vi.fn()} onRewound={vi.fn()} />);
    const radios = await screen.findAllByRole("radio", { name: /add login|fix tests/ });
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      expect.stringContaining("fix tests"),
      expect.stringContaining("add login"),
    ]);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/1 file: a\.ts/)).toBeDefined();
  });

  it("rewinds with the chosen mode and hands back the prompt", async () => {
    listRewindPoints.mockResolvedValue([point(1, "add login")]);
    rewindTo.mockResolvedValue({ filesRestored: 2, prompt: "add login", newSession: false });
    const onRewound = vi.fn();
    render(<RewindModal onClose={vi.fn()} onRewound={onRewound} />);
    await screen.findByText("add login");
    fireEvent.click(screen.getByRole("radio", { name: "Code only" }));
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    await waitFor(() =>
      expect(onRewound).toHaveBeenCalledWith({
        mode: "code",
        prompt: "add login",
        filesRestored: 2,
      }),
    );
    expect(rewindTo).toHaveBeenCalledWith("cp-0001", "code");
  });

  it("shows why a rewind was refused and stays open", async () => {
    listRewindPoints.mockResolvedValue([point(1, "add login")]);
    rewindTo.mockRejectedValue(new Error("The conversation was compacted after this point."));
    const onRewound = vi.fn();
    render(<RewindModal onClose={vi.fn()} onRewound={onRewound} />);
    await screen.findByText("add login");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    expect((await screen.findByRole("alert")).textContent).toContain("compacted");
    expect(onRewound).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rewind" }).disabled).toBe(false);
  });

  it("explains an empty session", async () => {
    listRewindPoints.mockResolvedValue([]);
    render(<RewindModal onClose={vi.fn()} onRewound={vi.fn()} />);
    expect(await screen.findByText(/Nothing to rewind yet/)).toBeDefined();
  });
});
