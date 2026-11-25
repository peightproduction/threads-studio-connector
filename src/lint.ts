// Checks a draft against the limits that really exist on Threads. Nothing here judges style or shape: Claude writes whatever
// the owner asks for (one post, a long thread, a list, a story, any language, any number of posts).
// `errors` are Threads' own rules (empty post, over 500 characters in one post, bad topic label) and block posting.
// `warnings` only ever contain words the owner themselves put on their own avoid-list (set_playbook).
export const MAX_CHARS = 500;

export type Lint = { ok: boolean; errors: string[]; warnings: string[]; chars: number[] };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Threads topic: 1-50 characters, no "." and no "&". It is a topic label, not a hashtag. */
export function topicError(topic: string | undefined): string | undefined {
  if (topic === undefined || topic === "") return undefined;
  if (topic.length < 1 || topic.length > 50) return "Topik Threads mesti 1-50 aksara.";
  if (/[.&]/.test(topic)) return 'Topik Threads tak boleh ada "." atau "&".';
  return undefined;
}

export function lintPost(parts: string[], opts: { topic?: string; banned?: string[] } = {}): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const clean = parts.map((p) => p.trim());
  const chars = clean.map((p) => [...p].length);

  if (!clean.length || !clean[0]) errors.push("Post kosong.");
  clean.forEach((p, i) => {
    if (!p && i > 0) errors.push(`Bahagian ${i + 1} kosong.`);
    if (chars[i] > MAX_CHARS) errors.push(`${i === 0 ? "Post" : `Bahagian ${i + 1}`} terlalu panjang untuk Threads (${chars[i]}/${MAX_CHARS} aksara). Pecahkan jadi thread (parts) atau pendekkan ${chars[i] - MAX_CHARS} aksara.`);
  });
  const te = topicError(opts.topic);
  if (te) errors.push(te);

  const all = clean.join(" ");
  for (const w of opts.banned ?? []) {
    if (w && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(all)) warnings.push(`Perkataan "${w}" ada dalam senarai elak pemilik.`);
  }
  return { ok: errors.length === 0, errors, warnings, chars };
}

/** Same text, ignoring case, spacing and punctuation. Used for the "already posted in the last 24 h" guard. */
export const sameText = (a: string, b: string) => norm(a) === norm(b);
