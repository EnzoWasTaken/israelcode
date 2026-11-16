// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLocalEndpointSettings, startOllamaServer, type LocalEndpointRow } from "./agent";
import { OllamaServerSettings } from "./OllamaServerSettings";

vi.mock("./agent", () => ({
  setLocalEndpointSettings: vi.fn(),
  startOllamaServer: vi.fn(),
  stopOllamaServer: vi.fn(),
}));

const EP: LocalEndpointRow = {
  id: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  kind: "ollama",
  custom: false,
  reachable: false,
  models: [],
  settings: { headers: { "X-A": "1" } },
  server: { managed: false, running: false, canStart: true, restartNeeded: false },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OllamaServerSettings", () => {
  it("saves set fields and keeps headers", async () => {
    vi.mocked(setLocalEndpointSettings).mockResolvedValue({ endpoints: [] });
    const onSaved = vi.fn();
    render(<OllamaServerSettings endpoint={EP} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Flash attention"), { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("KV cache quantization"), { target: { value: "q8_0" } });
    fireEvent.change(screen.getByLabelText("Default context length"), {
      target: { value: "32768" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setLocalEndpointSettings).toHaveBeenCalledWith("ollama", {
        headers: { "X-A": "1" },
        ollama: { flashAttention: true, kvCacheType: "q8_0", contextLength: 32768 },
      }),
    );
    expect(startOllamaServer).not.toHaveBeenCalled();
  });

  const withServer = (server: LocalEndpointRow["server"]): LocalEndpointRow => ({ ...EP, server });
  const NOT_INSTALLED = { managed: false, running: false, canStart: false, restartNeeded: false };

  it("not running + canStart offers Start Ollama and shows start errors", async () => {
    vi.mocked(startOllamaServer).mockRejectedValue(new Error("Could not start."));
    render(<OllamaServerSettings endpoint={EP} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Ollama" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not start");
  });

  it("managed offers Restart and Stop; restartNeeded relabels Restart", () => {
    const managed = { ...NOT_INSTALLED, managed: true, running: true };
    render(<OllamaServerSettings endpoint={withServer(managed)} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    cleanup();
    render(
      <OllamaServerSettings
        endpoint={withServer({ ...managed, restartNeeded: true })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Restart to apply" })).toBeTruthy();
  });

  it("running outside Israel Code explains and offers no start", () => {
    const ext = { ...NOT_INSTALLED, running: true };
    render(<OllamaServerSettings endpoint={withServer(ext)} onSaved={vi.fn()} />);
    expect(
      screen.getByText(/Ollama was started outside Israel Code, so these settings/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Ollama" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("not installed says so", () => {
    render(<OllamaServerSettings endpoint={withServer(NOT_INSTALLED)} onSaved={vi.fn()} />);
    expect(screen.getByText("Ollama is not installed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Ollama" })).toBeNull();
  });
});
