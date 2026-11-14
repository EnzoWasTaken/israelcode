# Review rubric

Use this twice on visual or interactive work. First while writing the spec:
copy the targets and the known-bad looks that apply into each piece's Target,
because a bad look prevented in the spec costs one sentence and a bad look
fixed afterwards costs a round. Then at the single review: compare what you
see against the checks and the catalogue, name the defect, and paste the
matching target into the fix list.

Contents: 1. Review procedure · 2. Functional acceptance · 3. Numeric criteria ·
4. Visual quality checks · 5. Known-bad looks catalogue

---

## 1. Review procedure

1. Look at the integrator's saved screenshots together, in one step. For
   time-based work ask the integrator for a contact sheet (small cells, one
   frame per 0.5–2 s) instead of separate frames.
2. Open a full-size frame only to answer a specific question (is the text
   legible? is the subject cropped?).
3. Pick the defects with the most impact on the viewer, five at most. A
   worker handed fifteen notes fixes the easy ones.
4. For each defect: where (time/location), what's wrong, what correct looks
   like (use the "Target" column below).
5. If the same defect shows up in two or more pieces, it lives upstream: fix
   the shared library or the spec instead.

---

## 2. Functional acceptance (every project)

- Runs from a clean load to the end with no console errors or 404s.
- Every control in the UI contract works, including keyboard shortcuts.
- End state is reachable and restart/replay works.
- Media (audio, fonts, images) actually load — check network responses, not
  just that the code exists.
- Small screens: no horizontal overflow at 390 px; overlays fit inside their
  container; touch targets ≥ 44 px.
- Interruptions: pause/resume, seek, reload mid-way, mute.

---

## 3. Numeric criteria (adapt to the project)

| Check | Typical target |
|---|---|
| Frame time | avg ≤ 12 ms, max ≤ 30 ms per frame (measure with nothing else running) |
| Subject size, intimate/close beat | subject ≈ 30–50% of frame height |
| Subject size, establishing shot | small is fine — but it must be legible as what it is |
| Text legibility | contrast ≥ 4.5:1 against what's actually behind it |
| "Silence" in a soundtrack | ≤ −38 dBFS RMS |
| Narration over music | voice peaks ≈ −6 dBFS; music ducked ~6 dB under it |
| Static frames | nothing fully still for > 0.5 s unless it's an intentional freeze |
| Scene transitions | no frame where both scenes are blank; no hard pop unless intended |

---

## 4. Visual quality checks

- **Focal point:** within half a second, a viewer knows where to look.
- **Silhouette:** key subjects read as what they are at real scale (a
  kneeling figure reads as kneeling; a sword reads as a sword).
- **Story beat:** each beat in the direction is understandable without words.
- **Composition:** asymmetric balance, negative space, nothing important
  cropped by the frame edge, horizon not cutting the subject's neck.
- **Consistency:** the art rules hold everywhere (palette, accent colour only
  where allowed, line quality matches across pieces).
- **Motion:** anticipation before actions, fast strikes, impact, held
  follow-through; ambient motion (wind, drift, camera) so frames breathe.
- **Continuity:** shared props, places and characters match between pieces.

---

## 5. Known-bad looks catalogue

| Symptom | Why it happens | Target to put in the brief |
|---|---|---|
| Stick-figure / puppet characters | Limbs drawn as strokes with no mass or costume volume | Define proportions in units of height (shoulder width, waist, garment hem width); filled shapes for torso and clothing; head smaller than you'd guess |
| See-through overlapping shapes, muddy grey where they cross | Translucent fills stacked | Opaque underpaint in the background colour first, then the tone on top |
| Boxy rectangles for organic forms | Axis-aligned rects as a shortcut | Build from curves with jittered edges; describe the silhouette (barrel chest, bell-shaped skirt) with numbers |
| Concentric "bullseye" rings | Several copies of the same shape at growing radii | Offset, irregular, differently seeded layers growing at different rates |
| Cut-paper hard edges on soft media (ink, smoke, watercolour) | Solid polygon fill | Feathered bleed just beyond the edge, darker pooled rim, irregular edge noise |
| Flat horizontal bands / visible gradient steps | Stacked solid bands instead of a gradient | Smooth eased gradient (cached sprite), mostly fading out in the first 40% of depth |
| Uniform wallpaper repetition (a row of identical trees, stalks, tiles) | Even spacing, one variant | Clustered rhythm with irregular gaps, 2–3 depth layers with different tones, varied sizes |
| Lens-flare starbursts or hard geometric rays | Wedge shapes for "light" | Light as negative space: large soft blooms eating into the dark |
| Hard circular spotlight | Radial clip | Irregular organic shapes closing in, lopsided soft-edged pocket |
| Glowing ball instead of a feature (eyes, lamps) | Glow radius too large | Small sharp feature with a tight halo (radius ≈ 2–3% of subject size, alpha ≤ 0.35) |
| Effects frozen in mid-air | Particle drawn at its final position forever | Physical life: fly out, fade the airborne part, fall with gravity, leave a mark |
| Key subject cropped by the frame | Camera or scale chosen without checking extremes | Check the subject's highest/lowest point at the pose's extreme; zoom out or lower it |
| Subject too small for an emotional beat | Wide framing held too long | Push in so the subject is 30–50% of frame height during the beat |
| Reveal spoiled | Thing is visible before its reveal moment | Keep it inside/behind cover until the reveal time; tie its visibility to the cover |
| Busy background fighting the subject | Same tone and density behind the subject | Lighter, sparser area behind the subject's silhouette; mist or depth fade |
| Placeholder labels or debug text left in | Stub never replaced | Error sweep plus contact sheet over the full range |
| Captions overlapping or late | Padded windows overlap the next cue | Choose the latest cue that has started; cross-fade the previous one out |
| A "silent" moment that isn't | Beds, tails and reverb keep playing | Hush the music/effects buses for the window; measure the RMS |
