import { readFileSync } from "node:fs";

// App.css and Deck.css are entry files that `@import` their partials under
// src/styles/. Guards that read a sheet as raw text read it through here, so
// they see every rule in cascade order, exactly as before the split.
export function readSheet(url) {
  return readFileSync(url, "utf8").replace(/^@import "([^"]+)";\n/gm, (_, path) =>
    readSheet(new URL(path, url)),
  );
}
