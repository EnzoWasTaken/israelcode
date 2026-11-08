import source from "../settings-sections.tsx?raw";
import { describe, expect, it, vi } from "vitest";
import {
  buildCommands,
  formatShortcut,
  matchesShortcut,
  SETTINGS_PAGES,
  SHORTCUTS,
  type CommandHandlers,
} from "./command-registry";
import { filterCommands, fuzzyMatch } from "./fuzzy";

const base: CommandHandlers = {
  openShortcuts: vi.fn(),
  toggleTheme: vi.fn(),
  openWhatsNew: vi.fn(),
  openSettings: vi.fn(),
  newWindow: vi.fn(),
  nextWindow: vi.fn(),
  prevWindow: vi.fn(),
  arrangeWindows: vi.fn(),
};

describe("fuzzyMatch", () => {
  it("prefers a contiguous word-start match and reports its indices", () => {
    expect(fuzzyMatch("new", "New session")?.indices).toEqual([0, 1, 2]);
    const start = fuzzyMatch("ses", "New session")!;
    const mid = fuzzyMatch("ess", "New session")!;
    expect(start.score).toBeGreaterThan(mid.score);
  });
  it("matches an in-order subsequence and rejects out-of-order letters", () => {
    expect(fuzzyMatch("nss", "New session")?.indices).toEqual([0, 4, 6]);
    expect(fuzzyMatch("zz", "New session")).toBeNull();
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("buildCommands", () => {
  it("offers only what the screen supports", () => {
    const entry = buildCommands(base).map((c) => c.id);
    expect(entry).toContain("toggle-theme");
    expect(entry).toContain("settings-about");
    expect(entry).not.toContain("new-session");
    const workspace = buildCommands({ ...base, newSession: vi.fn(), togglePlan: vi.fn() });
    expect(workspace.map((c) => c.id)).toContain("new-session");
    expect(workspace.find((c) => c.id === "toggle-plan")?.title).toBe("Turn plan mode on");
  });
  it("takes each command's key from the shortcut registry", () => {
    const sheet = buildCommands(base).find((c) => c.id === "shortcuts")!;
    expect(SHORTCUTS[sheet.shortcut!].label).toBe("Keyboard shortcuts");
  });
});

describe("filterCommands", () => {
  it("groups by section and narrows to the requested sections", () => {
    const commands = [
      ...buildCommands(base),
      { id: "p", title: "gg-app", section: "Projects" as const, run: vi.fn() },
    ];
    const all = filterCommands(commands, "");
    expect(all[0]!.command.section).toBe("Actions");
    expect(all[all.length - 1]!.command.section).toBe("Settings");
    expect(filterCommands(commands, "", ["Projects"]).map((m) => m.command.id)).toEqual(["p"]);
    expect(filterCommands(commands, "theme")[0]!.command.id).toBe("toggle-theme");
    // Keywords find a command without highlighting.
    expect(filterCommands(commands, "changelog")[0]).toMatchObject({ indices: [] });
  });
  it("matches a project's path only as a contiguous substring", () => {
    const projects = [
      {
        id: "l",
        title: "landing-page",
        section: "Projects" as const,
        keywords: "/Users/demo/projects/landing-page",
        run: vi.fn(),
      },
      {
        id: "m",
        title: "api",
        section: "Projects" as const,
        keywords: "/Users/demo/modules/api",
        run: vi.fn(),
      },
    ];
    expect(filterCommands(projects, "mod").map((m) => m.command.id)).toEqual(["m"]);
    expect(filterCommands(projects, "lndpg").map((m) => m.command.id)).toEqual(["l"]);
    expect(filterCommands(projects, "demo/proj").map((m) => m.command.id)).toEqual(["l"]);
  });
});

describe("shortcut labels", () => {
  it("uses ⌘ on macOS and Ctrl elsewhere", () => {
    expect(formatShortcut("palette", true)).toBe("⌘K");
    expect(formatShortcut("switchModel", false)).toBe("Ctrl+Shift+M");
    expect(formatShortcut("rewind", false)).toBe("Esc Esc");
    expect(formatShortcut("dictation", true)).toBe("⌃⇧Space");
  });
  it("matches key events", () => {
    const ev = (init: KeyboardEventInit) =>
      ({
        key: "",
        code: "",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      }) as KeyboardEvent;
    expect(matchesShortcut(ev({ key: "k", ctrlKey: true }), "palette")).toBe(true);
    expect(matchesShortcut(ev({ key: "k", metaKey: true }), "palette")).toBe(true);
    expect(matchesShortcut(ev({ key: "K", ctrlKey: true, shiftKey: true }), "palette")).toBe(false);
    expect(
      matchesShortcut(ev({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }), "switchModel"),
    ).toBe(true);
    expect(matchesShortcut(ev({ key: "/", code: "Slash", ctrlKey: true }), "shortcuts")).toBe(true);
  });
});

describe("SETTINGS_PAGES", () => {
  it("matches the Settings screen's sections", () => {
    const block = source.slice(source.indexOf("export const SETTINGS_SECTIONS"));
    const pages = [...block.matchAll(/\n {4}id: "([^"]+)",\r?\n {4}label: "([^"]+)"/g)].map(
      ([, id, label]) => ({ id, label }),
    );
    expect(pages).toEqual(SETTINGS_PAGES);
  });
});
