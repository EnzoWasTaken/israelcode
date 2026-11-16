// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLocalModelSettings, type LocalModelRow } from "./agent";
import { LocalModelSettingsForm } from "./LocalModelSettingsForm";

vi.mock("./agent", () => ({ setLocalModelSettings: vi.fn() }));

const setMock = vi.mocked(setLocalModelSettings);

const MODEL: LocalModelRow = {
  id: "local/ollama/qwen3",
  rawId: "qwen3",
  contextWindow: 4096,
  contextWindowKnown: true,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

function renderForm(
  model: LocalModelRow = MODEL,
  kind: "ollama" | "custom" = "ollama",
): { onSaved: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <LocalModelSettingsForm
      model={model}
      endpointKind={kind}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return { onSaved, onClose };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocalModelSettingsForm", () => {
  it("sends only the fields that were set", async () => {
    setMock.mockResolvedValue({ endpoints: [] });
    const { onSaved, onClose } = renderForm();

    fireEvent.change(screen.getByLabelText("Context window"), { target: { value: "32,768" } });
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("Images"), { target: { value: "on" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith("local/ollama/qwen3", {
        contextWindow: 32768,
        temperature: 0.2,
        supportsImages: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledWith({ endpoints: [] });
  });

  it("shows the detected value as placeholder and in Auto", () => {
    renderForm({ ...MODEL, contextWindow: 131072 });
    expect((screen.getByLabelText("Context window") as HTMLInputElement).placeholder).toBe(
      "131,072",
    );
    expect(screen.getByRole("option", { name: "Auto (detected: yes)" })).toBeTruthy();
    expect(screen.getAllByRole("option", { name: "Auto (detected: no)" })).toHaveLength(2);
  });

  it("Reset sends null", async () => {
    setMock.mockResolvedValue({ endpoints: [] });
    renderForm({ ...MODEL, settings: { temperature: 0.5 } });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(setMock).toHaveBeenCalledWith("local/ollama/qwen3", null));
  });

  it("blocks submit on bad JSON and on a non-object", () => {
    renderForm();
    const box = screen.getByLabelText("Extra request body");

    fireEvent.change(box, { target: { value: "{oops" } });
    expect(screen.getByRole("alert").textContent).toContain("not valid JSON");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setMock).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "[1]" } });
    expect(screen.getByRole("alert").textContent).toContain("must be a JSON object");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the Ollama load group, copy note, num_ctx hint and vision line only for Ollama", () => {
    renderForm();
    expect(screen.getByText("Ollama load settings")).toBeTruthy();
    expect(screen.getByLabelText("GPU layers").getAttribute("placeholder")).toBe("Auto");
    expect(screen.getByLabelText("Batch size").getAttribute("placeholder")).toBe("Server default");
    expect(screen.getByLabelText("CPU threads").getAttribute("placeholder")).toBe("Server default");
    expect(screen.getByText(/named qwen3-israelcode/)).toBeTruthy();
    expect(screen.getByText("Sent to Ollama as num_ctx.")).toBeTruthy();
    expect(
      screen.getByText(/Vision adapter \(mmproj\): bundled with the model by Ollama/),
    ).toBeTruthy();
    expect(screen.queryByText(/Ollama is serving/)).toBeNull();
    cleanup();
    renderForm(MODEL, "custom");
    expect(screen.queryByText("Ollama load settings")).toBeNull();
    expect(screen.queryByText("Sent to Ollama as num_ctx.")).toBeNull();
    expect(screen.queryByText(/Vision adapter/)).toBeNull();
    expect(screen.queryByText(/israelcode/)).toBeNull();
  });

  it("shows the route's error and stays open", async () => {
    setMock.mockRejectedValue(new Error("Temperature must be between 0 and 2."));
    const { onClose } = renderForm();
    fireEvent.change(screen.getByLabelText("Temperature"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Temperature must be between 0 and 2.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends Ollama runtime fields only for Ollama endpoints", async () => {
    setMock.mockResolvedValue({ endpoints: [] });
    renderForm();
    fireEvent.change(screen.getByLabelText("GPU layers"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Batch size"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("CPU threads"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith("local/ollama/qwen3", {
        gpuLayers: 20,
        batchSize: 512,
        threads: 8,
      }),
    );
    cleanup();
    renderForm(MODEL, "custom");
    expect(screen.queryByLabelText("GPU layers")).toBeNull();
  });
});
