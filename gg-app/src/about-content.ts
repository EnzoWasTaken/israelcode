import type { KenFace } from "./goal-ken-talk";
import { formatMonthYear, type ShipLog } from "./about-ship-log";

export const SOURCE_URL = "https://github.com/EnzoWasTaken/israelcode";
/** The upstream project Israel Code is a modified version of (AGPL-3.0). */
export const UPSTREAM_URL = "https://github.com/KenKaiii/gg-framework";

/**
 * When GG Coder, the upstream project, began: the repo's first commit, as the command-line tool. The
 * desktop app came later; its first release is the changelog's oldest entry.
 */
export const GG_CODER_STARTED = "2026-03-04";

/** One thing Israel says in his box, with the face he says it with. */
export interface KenSay {
  readonly face: KenFace;
  readonly text: string;
}

/**
 * What Israel says on the About page: a few plain sentences, each short enough to
 * fit his box's three lines.
 */
export function aboutLines(log: ShipLog): readonly KenSay[] {
  return [
    {
      face: "happy",
      text: "Hey, I'm Israel. This is Israel Code, the coding agent you're using right now.",
    },
    {
      face: "neutral",
      text: `It started as a command-line tool in ${formatMonthYear(GG_CODER_STARTED)}. This desktop app came along in ${formatMonthYear(log.firstDate)}.`,
    },
    {
      face: "thinking",
      text: "It grew out of GG Coder by Ken Kai, and it stays open source under the AGPL.",
    },
    {
      face: "happy",
      text: "Curious how it works? The full source code is on GitHub. Have a look around.",
    },
  ];
}

/** The parody note under the credits: Israel's pixel portrait is a caricature of a real person. */
export const PORTRAIT_NOTE =
  "Israel's pixel portrait is a stylized caricature of Benjamin Netanyahu, drawn as parody and tribute. It isn't affiliated with or endorsed by him or any government.";
