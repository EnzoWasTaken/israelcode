// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// The test compares against the real barrel on purpose.
// eslint-disable-next-line no-restricted-imports
import * as phosphor from "@phosphor-icons/react";
import * as icons from "./phosphor-icons";
// @ts-expect-error untyped .mjs script
import { readIconsModule, renderIconsModule, scanIconUsage } from "../scripts/gen-icons.mjs";

const usage = scanIconUsage() as Map<string, Set<icons.IconWeight>>;
const cases = [...usage].flatMap(([name, weights]) => [...weights].map((w) => [name, w] as const));

describe("icons", () => {
  it("is up to date with the icons and weights src/ uses (regenerate: node scripts/gen-icons.mjs)", async () => {
    expect(readIconsModule()).toEqual(await renderIconsModule());
  });

  it.each(cases)("%s weight=%s renders like Phosphor", (name, weight) => {
    const props = {
      size: 16,
      weight,
      color: "red",
      className: "c",
      "aria-hidden": true,
      mirrored: true,
    };
    const mine = (icons as unknown as Record<string, icons.Icon>)[name];
    const theirs = (phosphor as unknown as Record<string, icons.Icon>)[name];
    const html = renderToStaticMarkup(createElement(mine, props));
    expect(html).toBe(renderToStaticMarkup(createElement(theirs, props)));
    expect(html).toContain("<path");
  });
});
