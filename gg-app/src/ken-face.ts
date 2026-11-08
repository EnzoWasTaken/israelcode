// Ken's face: a head-only pixel portrait in the critter sprite format (see
// critter-sprites.ts). It stands in for the teal dot on Ken's chat replies and
// headlines the "Ken is on." / "Ken is off." banner. A cartoon caricature of
// Benjamin Netanyahu, drawn as parody (the About page says so): swept-back
// silver hair with a side part, a high forehead, strong dark brows, a broad
// face with a heavy jaw, a confident half-smile, and a navy suit, white collar
// and blue tie. Each expression is the base grid with a few rows swapped, so
// the frames line up pixel for pixel when stacked and cross-faded in CSS
// (KenFace.tsx). Colours are art, not theme roles.

import { renderColorGrid, shadeGrid, type Material } from "./critter-shade";
import { CRITTER_CELLS } from "./critter-sprites";

export type KenFaceFrame = "base" | "blink" | "talk" | "happy" | "sleepy";

export const KEN_FACE_PALETTE: Readonly<Record<string, string>> = {
  O: "#1c120e", // outline
  H: "#c3c7cf", // silver hair
  h: "#8e939c", // the side part and the swept-back strands
  F: "#f2d2b6", // skin
  D: "#dcb08f", // skin shade (nose, jowls, neck)
  A: "#e6b896", // ears
  B: "#3e3f46", // strong dark-grey brows
  E: "#1d1418", // eyes
  L: "#8a5a44", // closed lids
  M: "#a8504a", // half-smile
  K: "#4a1a1e", // open mouth
  T: "#e86a5e", // tongue
  G: "#1f2b4a", // navy suit
  W: "#f4f4f2", // white shirt collar
  N: "#2f6fd0", // blue tie
};

// Silver hair swept back from a side part over a high forehead, strong brows a
// row clear of the eyes, ears at eye level, a shaded nose, a broad face whose
// jowls take the shade, a half-smile turned up on one side, and the suit
// shoulders, collar and tie. Lit like the critters (critter-shade.ts).
const BASE: readonly string[] = [
  "..................",
  ".....OOOOOOOO.....",
  "...OOHhHHHHHhHOO..",
  "..OHHhHHHHHHHhHHO.",
  "..OHhFFFFFFFFhHO..",
  ".OHhFFFFFFFFFFhHO.",
  ".OhFBBBBFFBBBBFhO.",
  "OAAFFFFFFFFFFFFAAO",
  "OAAFFEEFFFFEEFFAAO",
  "OAAFFFFFDDFFFFFAAO",
  ".OFFFFFFDDFFFFFFO.",
  ".ODFFFFFFFFFMFFDO.",
  ".ODFFFFMMMMMFFFDO.",
  "..ODDFFFFFFFFDDO..",
  "...OODFFFFFFDOO...",
  ".OGGGGWWDDWWGGGGO.",
  "OGGGGGGWNNWGGGGGGO",
  "..................",
];

const LIDS = "OAAFFLLFFFFLLFFAAO";
const OPEN_MOUTH = {
  11: ".ODFFFFKKKKFFFFDO.",
  12: ".ODFFFFKTTKFFFFDO.",
};

/** Rows each expression swaps into the base grid. */
const CHANGES: Readonly<Record<KenFaceFrame, Readonly<Record<number, string>>>> = {
  base: {},
  blink: { 8: LIDS },
  talk: OPEN_MOUTH,
  // ^^ eyes (the brows stay a row above) and a wide grin.
  happy: {
    9: "OAAFEFFEDDEFFEFAAO",
    11: ".ODFFMKKKKKKMFFDO.",
    12: ".ODFFFMMMMMMFFFDO.",
  },
  // Lids shut and a small, settled mouth.
  sleepy: {
    8: LIDS,
    11: ".ODFFFFFFFFFFFFDO.",
    12: ".ODFFFFMMMMFFFFDO.",
  },
};

/** How each part of the face takes the light (critter-shade.ts). */
const KEN_FACE_MATERIALS: Readonly<Record<string, Material>> = {
  F: "skin",
  A: "skin",
  D: "skin",
  H: "fur",
  h: "fur",
  G: "cloth",
  W: "cloth",
  N: "cloth",
  B: "flat",
  E: "flat",
  L: "flat",
  M: "flat",
  K: "flat",
  T: "flat",
};

/** The grid for one expression. */
export function kenFaceRows(frame: KenFaceFrame): readonly string[] {
  const changes = CHANGES[frame];
  return BASE.map((row, i) => changes[i] ?? row);
}

/** One expression, lit, as an SVG data URL (one unit per cell, scale it up pixelated). */
export function renderKenFace(frame: KenFaceFrame): string {
  return renderColorGrid(
    shadeGrid({
      rows: kenFaceRows(frame),
      palette: KEN_FACE_PALETTE,
      materials: KEN_FACE_MATERIALS,
      seed: 11,
    }),
    { width: CRITTER_CELLS, height: CRITTER_CELLS },
  );
}
