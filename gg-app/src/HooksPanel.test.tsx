// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getHooks, setHooks, type HooksConfig, type HooksPayload } from "./agent";
import { HooksPanel } from "./HooksPanel";

vi.mock("./agent", () => ({ getHooks: vi.fn(), setHooks: vi.fn() }));

function config(): HooksConfig {
  return {
    version: 1,
    presets: {
      formatOnEdit: { enabled: false },
      lintOnEdit: { enabled: false },
      protectPaths: { enabled: false, globs: [] },
      blockDangerous: { enabled: false },
      notifyOnFinish: { enabled: false },
    },
    custom: [],
  };
}

function payload(over: Partial<HooksPayload> = {}): HooksPayload {
  return {
    enabled: false,
    config: config(),
    detected: { format: 'pnpm exec prettier --write "src/index.ts"' },
    recent: [],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(getHooks).mockResolvedValue(payload());
  vi.mocked(setHooks).mockImplementation(async (change) => {
    const cur = payload();
    return {
      ...cur,
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.config ? { config: change.config } : {}),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPanel(): Promise<void> {
  render(<HooksPanel />);
  await screen.findByRole("switch", { name: "Format after edit" });
}

describe("HooksPanel", () => {
  it("shows the five presets, the detected formatter and the master switch, and saves the switch", async () => {
    await renderPanel();
    for (const name of [
      "Format after edit",
      "Lint after edit",
      "Protect paths",
      "Block dangerous commands",
      "Notify when done",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }
    expect(screen.getByText('pnpm exec prettier --write "src/index.ts"')).toBeTruthy();
    expect(screen.getByText("nothing for this project")).toBeTruthy();
    const master = screen.getAllByRole("switch")[0]!;
    fireEvent.click(master);
    await waitFor(() => expect(setHooks).toHaveBeenCalledWith({ enabled: true }));
  });

  it("saves a preset toggle with the whole config", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Block dangerous commands" }));
    await waitFor(() => expect(setHooks).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(setHooks).mock.calls[0]![0].config!;
    expect(sent.presets.blockDangerous).toEqual({ enabled: true });
    expect(sent.presets.formatOnEdit).toEqual({ enabled: false });
    expect(screen.getByRole("switch", { name: "Block dangerous commands" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("saves protected globs after a pause, one per line, and offers the suggestions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderPanel();
      fireEvent.click(screen.getByRole("button", { name: "Use suggestions" }));
      const area = screen.getByRole("textbox", { name: "Protected path patterns" });
      expect((area as HTMLTextAreaElement).value).toBe(".env\n*.pem\n.github/workflows/**");
      fireEvent.change(area, { target: { value: ".env\n\n  *.pem  \n" } });
      expect(setHooks).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(700);
      const sent = vi.mocked(setHooks).mock.lastCall![0].config!;
      expect(sent.presets.protectPaths.globs).toEqual([".env", "*.pem"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds and removes a custom hook and lists recent activity", async () => {
    vi.mocked(getHooks).mockResolvedValue(
      payload({
        recent: [
          {
            hookId: "lintOnEdit",
            label: "lint",
            tool: "edit",
            phase: "post",
            outcome: "failed",
            detail: "2 errors",
          },
          {
            hookId: "formatOnEdit",
            label: "format",
            tool: "edit",
            phase: "post",
            outcome: "ran",
            durationMs: 120,
          },
        ],
      }),
    );
    await renderPanel();
    const activity = screen.getByRole("list", { name: "Recent hook activity" });
    expect(activity.textContent).toContain("format · edit · 120 ms");
    expect(activity.textContent).toContain("2 errors");

    fireEvent.change(screen.getByRole("combobox", { name: "Hook event" }), {
      target: { value: "preToolUse" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Hook tool" }), {
      target: { value: "bash" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Hook command" }), {
      target: { value: "./guard.sh" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Hook timeout in seconds" }), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(setHooks).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setHooks).mock.calls[0]![0].config!.custom).toEqual([
      { id: "bash", event: "preToolUse", tool: "bash", command: "./guard.sh", timeoutMs: 5000 },
    ]);
    await screen.findByRole("button", { name: "Remove hook bash" });
    fireEvent.click(screen.getByRole("button", { name: "Remove hook bash" }));
    await waitFor(() => expect(setHooks).toHaveBeenCalledTimes(2));
    expect(vi.mocked(setHooks).mock.calls[1]![0].config!.custom).toEqual([]);
  });
});
