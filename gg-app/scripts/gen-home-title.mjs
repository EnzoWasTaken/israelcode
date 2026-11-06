// Node port of gen-home-title.py for machines without Python/Pillow: paints the
// pixel titles in headless Chromium/Edge with the same recipe (Alagard 48px,
// thresholded, lit along the top of each stroke, outlined in ink).
//
//   node scripts/gen-home-title.mjs   (run from gg-app/; needs Playwright + Chrome or Edge)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TITLES = [
  ["Israel Code", join(ROOT, "src/assets/home/gg-coder-title.png")],
  ["Plan Mode", join(ROOT, "src/assets/home/plan-mode-title.png")],
];
const FONT = readFileSync(join(ROOT, "src/assets/fonts/alagard/alagard.ttf")).toString("base64");
const only = process.argv.slice(2);

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "msedge" });
const page = await browser.newPage();
for (const [text, out] of TITLES) {
  if (only.length && !only.includes(text)) continue;
  const dataUrl = await page.evaluate(
    async ({ text, font }) => {
      const SIZE = 48,
        TRACK = 0,
        PAD = 3;
      const FILL = [0xf0, 0xc0, 0x60],
        LIGHT = [0xff, 0xf2, 0xc0],
        OUTLINE = [0x2a, 0x14, 0x06];
      const face = new FontFace("Alagard", `url(data:font/ttf;base64,${font})`);
      await face.load();
      document.fonts.add(face);
      const big = document.createElement("canvas");
      big.width = SIZE * text.length * 2;
      big.height = SIZE * 3;
      const g = big.getContext("2d", { willReadFrequently: true });
      g.font = `${SIZE}px Alagard`;
      g.fillStyle = "#fff";
      g.textBaseline = "alphabetic";
      let x = SIZE;
      for (const ch of text) {
        g.fillText(ch, x, SIZE * 2);
        x += g.measureText(ch).width + TRACK;
      }
      const src = g.getImageData(0, 0, big.width, big.height);
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -1,
        y1 = -1;
      const lit = (px, py) => src.data[(py * big.width + px) * 4 + 3] > 110;
      for (let py = 0; py < big.height; py++)
        for (let px = 0; px < big.width; px++)
          if (lit(px, py)) {
            x0 = Math.min(x0, px);
            y0 = Math.min(y0, py);
            x1 = Math.max(x1, px);
            y1 = Math.max(y1, py);
          }
      const w = x1 - x0 + 1 + PAD * 2,
        h = y1 - y0 + 1 + PAD * 2;
      const on = (cx, cy) => {
        const px = cx - PAD + x0,
          py = cy - PAD + y0;
        return cx >= PAD && cy >= PAD && cx < w - PAD && cy < h - PAD && lit(px, py);
      };
      const outC = document.createElement("canvas");
      outC.width = w;
      outC.height = h;
      const o = outC.getContext("2d");
      const img = o.createImageData(w, h);
      const put = (cx, cy, [r, gg, b]) => {
        const i = (cy * w + cx) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      };
      for (let cy = 0; cy < h; cy++)
        for (let cx = 0; cx < w; cx++) {
          if (on(cx, cy)) put(cx, cy, cy > 0 && on(cx, cy - 1) ? FILL : LIGHT);
          else if (
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ].some(([dx, dy]) => on(cx + dx, cy + dy))
          )
            put(cx, cy, OUTLINE);
        }
      o.putImageData(img, 0, 0);
      return outC.toDataURL("image/png");
    },
    { text, font: FONT },
  );
  writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`wrote ${relative(ROOT, out)}`);
}
await browser.close();
