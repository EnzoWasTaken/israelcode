// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  addLocalEndpoint,
  getLocalModels,
  removeLocalEndpoint,
  scanLocalModels,
  setLocalEndpointSettings,
  setLocalModelSettings,
  switchModel,
  type LocalModelsState,
} from "./agent";
import { LocalModelsModal } from "./LocalModelsModal";

vi.mock("./agent", () => ({
  addLocalEndpoint: vi.fn(),
  getLocalModels: vi.fn(),
  removeLocalEndpoint: vi.fn(),
  scanLocalModels: vi.fn(),
  setLocalEndpointSettings: vi.fn(),
  setLocalModelSettings: vi.fn(),
  switchModel: vi.fn(),
}));

vi.mock("./toast", () => ({ toast: vi.fn() }));

const getLocalModelsMock = vi.mocked(getLocalModels);
const scanLocalModelsMock = vi.mocked(scanLocalModels);
const addLocalEndpointMock = vi.mocked(addLocalEndpoint);
const removeLocalEndpointMock = vi.mocked(removeLocalEndpoint);
const switchModelMock = vi.mocked(switchModel);

const STATE: LocalModelsState = {
  endpoints: [
    {
      id: "ollama",
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      kind: "ollama",
      custom: false,
      reachable: true,
      models: [
        {
          id: "local/ollama/qwen3-coder:30b",
          rawId: "qwen3-coder:30b",
          contextWindow: 262144,
          contextWindowKnown: true,
          supportsTools: true,
          supportsImages: false,
          supportsThinking: true,
        },
        {
          id: "local/ollama/gemma3:4b",
          rawId: "gemma3:4b",
          contextWindow: 8192,
          contextWindowKnown: false,
          supportsTools: false,
          supportsImages: false,
          supportsThinking: false,
        },
        {
          id: "local/ollama/mystery-gguf",
          rawId: "mystery-gguf",
          contextWindow: 8192,
          contextWindowKnown: false,
          supportsTools: true,
          supportsImages: false,
          supportsThinking: false,
        },
      ],
    },
    {
      id: "lmstudio-custom",
      label: "LM Studio",
      baseUrl: "http://127.0.0.1:1234/v1",
      kind: "lmstudio",
      custom: true,
      reachable: false,
      reason: "Not running at http://127.0.0.1:1234/v1",
      models: [],
    },
  ],
};

beforeEach(() => {
  getLocalModelsMock.mockResolvedValue(STATE);
  scanLocalModelsMock.mockResolvedValue(STATE);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocalModelsModal", () => {
  it("says the list couldn't be read instead of 'No models yet', and retries", async () => {
    getLocalModelsMock.mockRejectedValueOnce(new Error("daemon down"));

    render(<LocalModelsModal onClose={vi.fn()} />);

    expect(await screen.findByText("Couldn't reach the agent to list models.")).toBeTruthy();
    expect(screen.queryByText(/No models yet/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Ollama")).toBeTruthy();
    expect(screen.queryByText("Couldn't reach the agent to list models.")).toBeNull();
  });

  it("shows one compact context figure per model, capabilities in the tooltip", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);

    expect(await screen.findByText("Ollama")).toBeTruthy();
    expect(screen.getByText("3 models")).toBeTruthy();
    expect(screen.getByText("262K ctx")).toBeTruthy();

    // Capabilities would overflow the row as chips, so they live in the tooltip.
    const tooltip = screen
      .getByText("qwen3-coder:30b")
      .closest(".local-model-row")!
      .getAttribute("title")!;
    expect(tooltip).toContain("Ollama");
    expect(tooltip).toContain("Context: 262,144 tokens");
    expect(tooltip).toContain("tool calling");
    expect(tooltip).toContain("thinking");
  });

  it("marks an unknown context length rather than presenting a guess as fact", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    expect(screen.getByText("8K ctx?")).toBeTruthy();
    expect(
      screen.getByText("mystery-gguf").closest(".local-model-row")!.getAttribute("title"),
    ).toContain("Context: unknown — assuming 8,192 tokens");
    // A tool-less model shows the blocking reason inline instead of a size.
    expect(screen.getByText("gemma3:4b").closest(".local-model-row")!.textContent).toContain(
      "no tool calling",
    );
  });

  it("shows a not-running endpoint's reason instead of an error", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);

    expect(await screen.findByText("LM Studio")).toBeTruthy();
    expect(screen.getByText("Not running at http://127.0.0.1:1234/v1")).toBeTruthy();
  });

  it("flags a model with no tool calling and says why", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);

    const row = (await screen.findByText("gemma3:4b")).closest(".local-model-row")!;
    // Selection lives in the footer picker; the only control is Settings.
    expect(row.tagName).toBe("DIV");
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.getAttribute("title")).toContain("no tool calling");
    expect(screen.getByText("no tool calling")).toBeTruthy();
  });

  it("never switches the model from this screen", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);

    fireEvent.click((await screen.findByText("qwen3-coder:30b")).closest(".local-model-row")!);

    expect(switchModelMock).not.toHaveBeenCalled();
  });

  it("keeps the hint short: where to pick a model, tool calling, unknown context", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    // The rows aren't clickable, so say where picking happens (users tried the rows).
    expect(screen.getByText(/Pick a model from the model menu in a session/)).toBeTruthy();
    expect(screen.getByText(/No tool calling = can’t run the agent/)).toBeTruthy();
    expect(screen.queryByText(/small context/)).toBeNull();
  });

  it("explains how to raise Ollama's context when it serves a model at 4K", async () => {
    const ollama = STATE.endpoints[0]!;
    const small = {
      ...STATE,
      endpoints: [
        {
          ...ollama,
          models: [{ ...ollama.models[0]!, contextWindow: 4096, contextWindowKnown: true }],
        },
      ],
    };
    getLocalModelsMock.mockResolvedValue(small);
    scanLocalModelsMock.mockResolvedValue(small);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    expect(screen.getByText(/Raise Context length in Ollama’s settings/)).toBeTruthy();
  });

  it("re-probes on Scan", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");
    scanLocalModelsMock.mockClear();

    fireEvent.click(screen.getByTitle("Re-check every local endpoint"));

    await waitFor(() => expect(scanLocalModelsMock).toHaveBeenCalledTimes(1));
  });

  it("shows a validation error inline when an added endpoint URL is rejected", async () => {
    addLocalEndpointMock.mockRejectedValue(new Error("Endpoint URL must use http or https."));
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    fireEvent.click(screen.getByText("Add endpoint"));
    fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:1234/v1"), {
      target: { value: "ftp://nope" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Endpoint URL must use http or https.")).toBeTruthy();
  });

  it("passes an optional context length with a new endpoint", async () => {
    addLocalEndpointMock.mockResolvedValue(STATE);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    fireEvent.click(screen.getByText("Add endpoint"));
    fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:1234/v1"), {
      target: { value: "http://192.168.1.189:8080/v1" },
    });
    fireEvent.change(screen.getByLabelText("Context length"), {
      target: { value: "262,144" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(addLocalEndpointMock).toHaveBeenCalledWith(
        "http://192.168.1.189:8080/v1",
        undefined,
        undefined,
        262144,
      ),
    );
  });

  it("rejects a non-numeric context length before saving", async () => {
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    fireEvent.click(screen.getByText("Add endpoint"));
    fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:1234/v1"), {
      target: { value: "http://192.168.1.189:8080/v1" },
    });
    fireEvent.change(screen.getByLabelText("Context length"), { target: { value: "lots" } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText(/whole number of tokens/)).toBeTruthy();
    expect(addLocalEndpointMock).not.toHaveBeenCalled();
  });

  it("only offers removal for user-added endpoints", async () => {
    removeLocalEndpointMock.mockResolvedValue({ endpoints: [] });
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    // Ollama is the one built-in endpoint: no remove button. The custom LM
    // Studio endpoint (how non-Ollama servers appear now) does get one.
    expect(screen.queryByTitle('Remove "Ollama"')).toBeNull();
    expect(screen.getByTitle('Remove "LM Studio"')).toBeTruthy();
  });

  it("keeps the footer to three actions (HF download lives in the Connect-page tile)", async () => {
    // The in-modal HF button was removed (it crowded the footer to four
    // buttons); the Connect-page tile is the entry point now.
    render(<LocalModelsModal onClose={vi.fn()} />);
    // Let the mount-time load and background scan settle so their state
    // updates land inside the test instead of after it.
    await screen.findByText("Ollama");
    await waitFor(() => expect(scanLocalModelsMock).toHaveBeenCalled());
    expect(screen.queryByText("Add from Hugging Face")).toBeNull();
    expect(screen.getByText("Add endpoint")).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
    expect(screen.getByText("Scan")).toBeTruthy();
  });

  it("marks a customised model and opens one settings form at a time", async () => {
    const ollama = STATE.endpoints[0]!;
    const custom = {
      endpoints: [
        {
          ...ollama,
          models: [
            { ...ollama.models[0]!, settings: { temperature: 0.2 } },
            { ...ollama.models[1]!, settings: {} },
          ],
        },
      ],
    };
    getLocalModelsMock.mockResolvedValue(custom);
    scanLocalModelsMock.mockResolvedValue(custom);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");

    expect(screen.getAllByText(/Custom/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Settings for qwen3-coder:30b" }));
    expect(screen.getByRole("form", { name: "Settings for qwen3-coder:30b" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings for gemma3:4b" }));
    expect(screen.queryByRole("form", { name: "Settings for qwen3-coder:30b" })).toBeNull();
    expect(screen.getByRole("form", { name: "Settings for gemma3:4b" })).toBeTruthy();
  });

  it("offers Server settings for the built-in Ollama row even when unreachable and without a server object", async () => {
    const down = {
      endpoints: [{ ...STATE.endpoints[0]!, reachable: false, models: [] }, STATE.endpoints[1]!],
    };
    getLocalModelsMock.mockResolvedValue(down);
    scanLocalModelsMock.mockResolvedValue(down);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    expect(screen.getByRole("form", { name: "Ollama server settings" })).toBeTruthy();
    expect(screen.getByText("Ollama is not installed.")).toBeTruthy();
  });

  it("does not offer Server settings for a custom endpoint", async () => {
    const custom = {
      endpoints: [{ ...STATE.endpoints[0]!, id: "ollama-custom", custom: true }],
    };
    getLocalModelsMock.mockResolvedValue(custom);
    scanLocalModelsMock.mockResolvedValue(custom);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("Ollama");
    expect(screen.queryByRole("button", { name: "Server settings" })).toBeNull();
  });

  it("saves endpoint headers one Name: value per line", async () => {
    const lm = { ...STATE.endpoints[1]!, reachable: true, reason: undefined };
    const state = { endpoints: [lm] };
    getLocalModelsMock.mockResolvedValue(state);
    scanLocalModelsMock.mockResolvedValue(state);
    vi.mocked(setLocalEndpointSettings).mockResolvedValue(state);
    render(<LocalModelsModal onClose={vi.fn()} />);
    await screen.findByText("LM Studio");

    fireEvent.change(screen.getByLabelText("Headers for LM Studio"), {
      target: { value: "X-Org: acme\nX-Team: a:b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save headers" }));

    await waitFor(() =>
      expect(setLocalEndpointSettings).toHaveBeenCalledWith("lmstudio-custom", {
        headers: { "X-Org": "acme", "X-Team": "a:b" },
      }),
    );
    void setLocalModelSettings;
  });
});
