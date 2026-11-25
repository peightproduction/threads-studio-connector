// The owner's own notes for their posts: voice, topics, facts and words to avoid. They are CONTEXT for Claude, never limits: Claude may
// write any shape the owner asks for (one post, a long thread, a list, a story, any language, any number of posts) and may ignore
// or go beyond these notes whenever the request calls for it. The owner edits them by chatting ("tambah pillar ...") through the
// set_playbook tool, which stores additions and removals in the state; `effective()` merges them.
// This is the neutral starting point handed to followers: no business, no trade, no voice is assumed. `facts` starts empty:
// real results, client names and numbers only come from what the owner says.
import type { PlaybookEdits } from "./types.js";

export type Angle = { id: string; name: string; recipe: string; use: string };

/** A menu of starting ideas. Optional: an angle can be anything, including one that is not on this list. */
export const ANGLES: Angle[] = [
  { id: "cerita", name: "Cerita perjalanan", recipe: "One real moment (yesterday, last week): what happened, what was learned.", use: "Builds trust; mistakes, lessons." },
  { id: "pendapat", name: "Pendapat", recipe: "A stance that challenges the usual view, with one reason and one example.", use: "Starts discussion." },
  { id: "tabir", name: "Belakang tabir", recipe: "Show how something is really done: the tools, the mess, the routine.", use: "Makes the work and the person feel real." },
  { id: "tip", name: "Tip ringkas", recipe: "One tip the reader can use today.", use: "Free value; makes people follow." },
  { id: "relatable", name: "Relatable", recipe: "A situation the audience knows well, said in their own words.", use: "Makes the reader think 'that's me'." },
  { id: "soalan", name: "Soalan", recipe: "One concrete question the audience can answer quickly.", use: "Raises replies, teaches you about the audience." },
  { id: "hasil", name: "Hasil sebenar", recipe: "Before, after, one number. ONLY real facts from the owner; if there are none, ask first.", use: "Proof. Never made up." },
  { id: "tawaran", name: "Tawaran", recipe: "A clear free offer or help, with one next step.", use: "Turns readers into conversations." },
];

export const DEFAULT_PILLARS: string[] = [];

export const DEFAULT_VOICE = [
  "Write in the owner's own voice and language. If you do not know it yet, ask for two or three posts the owner wrote themselves and copy the style from those (style_examples), never from posts Claude wrote.",
  "Never invent numbers, client names or results. Use only facts in `facts`, or ask the owner.",
];

/** Empty on purpose: only words the owner adds themselves. */
export const DEFAULT_BANNED: string[] = [];

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function effective(edits: PlaybookEdits, removed: PlaybookEdits) {
  const pick = (base: string[], add?: string[], rem?: string[]) => uniq([...base, ...(add ?? [])]).filter((x) => !(rem ?? []).includes(x));
  return {
    account: "",
    business: "",
    angles: ANGLES,
    pillars: pick(DEFAULT_PILLARS, edits.pillars, removed.pillars),
    voice: pick(DEFAULT_VOICE, edits.voice, removed.voice),
    facts: pick([], edits.facts, removed.facts),
    banned: pick(DEFAULT_BANNED, edits.banned, removed.banned),
  };
}
export type Playbook = ReturnType<typeof effective>;
