// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("./agent", () => ({
  getRoutingConfig: vi.fn(),
  setRoutingConfig: vi.fn(),
  setRoutingCredential: vi.fn(),
  clearRoutingCredential: vi.fn(),
  testRouting: vi.fn(),
  getRoutingDiagnostics: vi.fn(),
  listBackgroundSessions: vi.fn(() => Promise.resolve([])),
  onBackgroundSessions: vi.fn(() => () => {}),
  stopBackgroundSession: vi.fn(),
  dismissBackgroundSession: vi.fn(),
  deleteBackgroundSession: vi.fn(),
  getKeepAwake: vi.fn(() => Promise.resolve(true)),
  setKeepAwake: vi.fn(),
  restoreTarget: vi.fn(() => Promise.resolve(null)),
}));

import * as agent from "./agent";
import type { RoutingConfigResponse, RouteDiagnostic } from "./agent";
import { SettingsAutoRouting } from "./SettingsAutoRouting";
import { SettingsDiagnostics } from "./SettingsDiagnostics";
import { SettingsSessions } from "./SettingsSessions";
import { SettingsCost } from "./SettingsCost";
import { SettingsExecutionModes } from "./SettingsExecutionModes";

const STORED = "sk-or-v1-supersecretvalue1234";

function response(over: Partial<RoutingConfigResponse> = {}): RoutingConfigResponse {
  return {
    config: {
      enabled: false,
      decider: null,
      confidenceThreshold: 0.6,
      allowUltracode: true,
      allowOrchestrate: true,
      allowPaidModels: false,
      maxEffort: null,
      maxCostTier: "high",
      candidateModels: null,
      escalation: { enabled: true, maxAttempts: 1 },
      timeoutMs: 4000,
      cacheTtlMs: 600000,
    },
    problems: [],
    credentials: {
      openrouter: { set: true, masked: "••••1234" },
      typesafe: { set: true, masked: "••••abcd" },
    },
    deciderOptions: [
      {
        id: "m1",
        label: "Haiku",
        kind: "model",
        provider: "anthropic",
        model: "haiku",
        available: true,
      },
      {
        id: "d1",
        label: "Jev via TypeSafe",
        kind: "decisions-api",
        service: "typesafe",
        model: "jev-latest",
        available: false,
        note: "Add a TypeSafe key",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(agent.getRoutingConfig).mockResolvedValue(response());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadAuto() {
  render(<SettingsAutoRouting />);
  await screen.findByLabelText("Decision model");
}

describe("Auto routing page", () => {
  it("loads the config, never shows a stored key, and disables unavailable deciders", async () => {
    await loadAuto();
    expect(document.body.innerHTML).not.toContain(STORED);
    expect(screen.getByText("••••1234")).toBeTruthy();
    expect(screen.getByText(/Uses your OpenRouter provider login/)).toBeTruthy();
    const option = screen.getByRole("option", { name: /Jev via TypeSafe/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("Add a TypeSafe key");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the edited config", async () => {
    vi.mocked(agent.setRoutingConfig).mockResolvedValue(response());
    await loadAuto();
    fireEvent.click(screen.getByLabelText("Use Auto for new windows"));
    fireEvent.change(screen.getByLabelText("Decision model"), { target: { value: "m1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(agent.setRoutingConfig).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(agent.setRoutingConfig).mock.calls[0]![0];
    expect(sent.enabled).toBe(true);
    expect(sent.decider).toEqual({ kind: "model", provider: "anthropic", model: "haiku" });
    expect((await screen.findAllByText("Saved")).length).toBeGreaterThan(0);
  });

  it("blocks save while a value is invalid", async () => {
    await loadAuto();
    fireEvent.click(screen.getByLabelText("Use Auto for new windows"));
    fireEvent.change(screen.getByLabelText("Confidence threshold"), { target: { value: "1.5" } });
    expect(screen.getByText("Enter a number from 0 to 1.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Maximum escalation attempts"), {
      target: { value: "3" },
    });
    expect(screen.getByText("Enter 0, 1 or 2.")).toBeTruthy();
  });

  it("lists problems from the API and save errors", async () => {
    vi.mocked(agent.getRoutingConfig).mockResolvedValue(
      response({ problems: ["Add your TypeSafe key to use jev-latest."] }),
    );
    vi.mocked(agent.setRoutingConfig).mockRejectedValue(
      new Error("The decision model choice is invalid."),
    );
    await loadAuto();
    expect(screen.getByText("Add your TypeSafe key to use jev-latest.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Use Auto for new windows"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/The decision model choice is invalid\./)).toBeTruthy();
  });

  it("shows test-connection success and failure", async () => {
    vi.mocked(agent.getRoutingConfig).mockResolvedValue(
      response({
        config: {
          ...response().config,
          decider: { kind: "model", provider: "anthropic", model: "haiku" },
        },
      }),
    );
    vi.mocked(agent.testRouting).mockResolvedValueOnce({
      ok: true,
      latencyMs: 321,
      decider: "Haiku",
      sample: { model: "sonnet", effort: "low", executionMode: "standard", confidence: 0.9 },
    });
    await loadAuto();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/321 ms, picked sonnet \(low\)/)).toBeTruthy();

    vi.mocked(agent.testRouting).mockResolvedValueOnce({
      ok: false,
      latencyMs: 0,
      decider: "Haiku",
      error: { reason: "timeout", message: "The decision model took too long to answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The decision model took too long to answer")).toBeTruthy();
  });

  it("asks before removing the TypeSafe key", async () => {
    vi.mocked(agent.clearRoutingCredential).mockResolvedValue({ ok: true });
    await loadAuto();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(agent.clearRoutingCredential).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(agent.clearRoutingCredential).toHaveBeenCalledWith("typesafe"));
  });

  it("sets a key through a password input and clears it afterwards", async () => {
    vi.mocked(agent.getRoutingConfig).mockResolvedValue(
      response({
        credentials: {
          openrouter: { set: true, masked: "••••1234" },
          typesafe: { set: false, masked: null },
        },
      }),
    );
    vi.mocked(agent.setRoutingCredential).mockResolvedValue({
      ok: true,
      service: "typesafe",
      set: true,
      masked: "••••9999",
    });
    await loadAuto();
    const input = screen.getByLabelText("TypeSafe key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "ts-key-123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(agent.setRoutingCredential).toHaveBeenCalledWith(
        "typesafe",
        "ts-key-123456789",
        false,
      ),
    );
    expect(await screen.findByText("Key saved.")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("ts-key-123456789");
  });
});

describe("Sessions page", () => {
  it("lists background rows with stop but no Open", async () => {
    vi.mocked(agent.listBackgroundSessions).mockResolvedValue([
      {
        id: "b1",
        sessionPath: "/s/1.jsonl",
        cwd: "/work/proj",
        mode: "code",
        status: "running",
        title: "Refactor auth",
        updatedAt: Date.now(),
        attached: false,
      } as never,
    ]);
    render(<SettingsSessions />);
    expect(await screen.findByText("Refactor auth")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop task/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    expect(screen.getByText(/closing the last window quits the app/)).toBeTruthy();
  });
});

describe("Diagnostics page", () => {
  it("renders rows and refreshes", async () => {
    const row = {
      timestamp: Date.now(),
      sessionHash: "h",
      provider: "anthropic",
      model: "sonnet",
      effort: "low",
      executionMode: "standard",
      source: "router",
      reason: "simple edit",
      taskKind: "edit",
      difficulty: "easy",
      confidence: 0.82,
      latencyMs: 412,
      workspace: "w",
      attachmentKinds: [],
      textLength: 10,
      textHash: "t",
    } as RouteDiagnostic;
    vi.mocked(agent.getRoutingDiagnostics).mockResolvedValue([row]);
    render(<SettingsDiagnostics />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("sonnet")).toBeTruthy();
    expect(within(table).getByText("82%")).toBeTruthy();
    expect(within(table).getByText("412 ms")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(agent.getRoutingDiagnostics).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/gg-app-sidecar\.log/)).toBeTruthy();
  });
});

describe("Cost and Execution pages", () => {
  it("summarise Auto's limits and link to Auto routing", async () => {
    const open = vi.fn();
    render(<SettingsCost onOpenAutoRouting={open} />);
    expect(await screen.findByText("High (no limit)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit in Auto routing" }));
    expect(open).toHaveBeenCalled();
  });

  it("explains the modes", () => {
    const open = vi.fn();
    render(<SettingsExecutionModes onOpenAutoRouting={open} />);
    expect(screen.getByText("Orchestrate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Let Auto choose/ }));
    expect(open).toHaveBeenCalled();
  });
});
