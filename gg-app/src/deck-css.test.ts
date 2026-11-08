import { describe, expect, it } from "vitest";
import deckEntry from "./Deck.css?raw";

// Deck.css only `@import`s its partials (./styles/deck/*.css); inline them in order.
const PARTIALS = import.meta.glob<string>("./styles/deck/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});
const deckCss = deckEntry.replace(/^@import "([^"]+)";\n/gm, (_, path: string) => {
  const partial = PARTIALS[path];
  if (partial === undefined) throw new Error(`missing partial ${path}`);
  return partial;
});

function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1];
}

describe("Deck tool panels", () => {
  it("fit dialogs with a fixed width to the panel, so text wraps inside it", () => {
    for (const dialog of [".notes-modal", ".goal-modal"]) {
      expect(ruleBody(deckCss, `.tool-body > ${dialog}`)).toMatch(/width:\s*auto/);
    }
  });
});
