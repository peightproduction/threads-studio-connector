// Pure functions: no network, no clock (callers pass `now`). Everything here is unit-tested in tests/.
// Malaysia has no daylight saving, so MYT is a fixed UTC+8 offset.
import type { Metrics, Post } from "./types.js";

const MYT_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;

export const DOW = ["Isn", "Sel", "Rab", "Kha", "Jum", "Sab", "Ahd"]; // Monday first
export const SLOT_COUNT = 8; // 3-hour windows

export const mytDate = (t: number | string | Date): string => new Date(new Date(t).getTime() + MYT_MS).toISOString().slice(0, 10);
export function mytParts(t: number | string | Date): { date: string; hour: number; dow: number } {
  const d = new Date(new Date(t).getTime() + MYT_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: (d.getUTCDay() + 6) % 7 };
}
export const addDays = (dateKey: string, n: number): string => new Date(Date.parse(dateKey + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
export const weekStart = (dateKey: string): string => addDays(dateKey, -((new Date(dateKey + "T00:00:00Z").getUTCDay() + 6) % 7));
export const slotLabel = (dow: number, slot: number) => `${DOW[dow]} ${String(slot * 3).padStart(2, "0")}:00-${String(slot * 3 + 3).padStart(2, "0")}:00`;

// ---- text features ----------------------------------------------------------------------------

export const hookOf = (text: string): string => (text.trim().split(/\n/)[0] ?? "").trim().slice(0, 140);

const MS_WORDS = new Set("yang tak dan untuk dengan ni tu aku kau korang dah nak ada je lah pun kat buat boleh lagi sangat kalau tapi saya awak kita dia mereka pada dalam itu ini kami atau juga jangan macam bila baru lepas".split(" "));
const EN_WORDS = new Set("the and to of is you your that for with are this it not but if we they have has was were will can what when how why just more most than from about one all".split(" "));

export function language(text: string): "ms" | "en" | "mix" {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let ms = 0, en = 0;
  for (const w of words) { if (MS_WORDS.has(w)) ms++; if (EN_WORDS.has(w)) en++; }
  if (ms + en < 3) return "mix";
  if (ms >= en * 2) return "ms";
  if (en >= ms * 2) return "en";
  return "mix";
}

export type HookType = "soalan" | "pendapat" | "cerita" | "tip" | "angka" | "pernyataan";
export const HOOK_TYPES: HookType[] = ["soalan", "pendapat", "cerita", "tip", "angka", "pernyataan"];

/** A rough, deterministic label for the first line. Claude does the real reading; this gives it (and the heatmap) a stable key. */
export function hookType(text: string): HookType {
  const h = hookOf(text).toLowerCase();
  if (/^\s*(rm\s?\d|\d)/.test(h) && !/\b\d+\s*(cara|tip|perkara|kesilapan|sebab|langkah|things|ways|mistakes|reasons)/.test(h)) return "angka";
  if (h.includes("?")) return "soalan";
  if (/(unpopular|tak popular|hot take|real talk|jujur|honest|sebenarnya|pendapat|ramai (tak|salah)|salah faham|myth)/.test(h)) return "pendapat";
  if (/(semalam|tadi|hari tu|minggu lepas|bulan lepas|baru je|pernah|client (aku|saya)|kisah|cerita|aku (kena|jumpa|dapat|terima|tengok)|last week|yesterday|today i)/.test(h)) return "cerita";
  if (/(cara|tip|jangan|stop|rahsia|kesilapan|\d+\s*(cara|perkara|sebab|langkah)|how to|mistake|ways to)/.test(h)) return "tip";
  if (/^\s*(rm\s?\d|\d)/.test(h)) return "angka";
  return "pernyataan";
}

const EMOJI = /\p{Extended_Pictographic}/gu;
export const emojiCount = (t: string) => (t.match(EMOJI) ?? []).length;

export type Features = {
  hook: string;
  hookType: HookType;
  chars: number;
  lines: number;
  language: "ms" | "en" | "mix";
  hasQuestion: boolean;
  hasNumber: boolean;
  hasRinggit: boolean;
  hasCta: boolean;
  emoji: number;
  media: number;
  day: string;
  slot: string;
};

export function features(post: Pick<Post, "text" | "at" | "media">): Features {
  const p = mytParts(post.at);
  const t = post.text;
  return {
    hook: hookOf(t),
    hookType: hookType(t),
    chars: t.length,
    lines: t.split(/\n/).filter((l) => l.trim()).length,
    language: language(t),
    hasQuestion: t.includes("?"),
    hasNumber: /\d/.test(t),
    hasRinggit: /\brm\s?\d|ringgit|\bduit\b/i.test(t),
    hasCta: /(wa\.me|\bdm\b|\b(whatsapp|wasap)\s+(aku|saya|kami|kitorang|me)\b|\bkomen\b|\bcomment\b|link (dalam |di )?bio|\bklik\b|\btekan\b)/i.test(t),
    emoji: emojiCount(t),
    media: post.media,
    day: DOW[p.dow],
    slot: slotLabel(p.dow, Math.floor(p.hour / 3)),
  };
}

// ---- counting ---------------------------------------------------------------------------------

export type TrackerData = {
  goal: number;
  today: number;
  todayLeft: number;
  week: number;
  weekGoal: number;
  month: number;
  total30: number;
  streak: number;
  longestStreak: number;
  todayPending: boolean; // today's goal is not met yet, so the streak shown is up to yesterday
  last30: { date: string; label: string; count: number }[];
  lastPostAt?: string;
  hoursSinceLast?: number;
  scheduled: { id: string; at: string; text: string; hook: string }[];
  drafts: number;
};

const isPublished = (p: Post) => p.status === "published";

export function countByDay(posts: Post[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of posts) if (isPublished(p)) m.set(mytDate(p.at), (m.get(mytDate(p.at)) ?? 0) + 1);
  return m;
}

export function tracker(posts: Post[], now: Date, goal: number): TrackerData {
  const g = Math.max(1, Math.round(goal));
  const days = countByDay(posts);
  const today = mytDate(now);
  const c = (d: string) => days.get(d) ?? 0;

  const todayCount = c(today);
  const todayPending = todayCount < g;
  // streak: consecutive days meeting the goal, counting back from today (or yesterday while today is still open)
  let streak = 0;
  for (let d = todayPending ? addDays(today, -1) : today; c(d) >= g; d = addDays(d, -1)) streak++;
  // longest streak in the last 90 days
  let longest = 0, run = 0;
  for (let i = 89; i >= 0; i--) { if (c(addDays(today, -i)) >= g) { run++; longest = Math.max(longest, run); } else run = 0; }

  const ws = weekStart(today);
  let week = 0;
  for (let d = ws; d <= today; d = addDays(d, 1)) week += c(d);
  const ms = today.slice(0, 8) + "01";
  let month = 0;
  for (let d = ms; d <= today; d = addDays(d, 1)) month += c(d);

  const last30 = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(today, i - 29);
    return { date, label: date.slice(8) + "/" + date.slice(5, 7), count: c(date) };
  });

  const published = posts.filter(isPublished).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const last = published[0];
  const nowMs = now.getTime();
  return {
    goal: g,
    today: todayCount,
    todayLeft: Math.max(0, g - todayCount),
    week,
    weekGoal: g * (Math.floor((Date.parse(today) - Date.parse(ws)) / DAY_MS) + 1),
    month,
    total30: last30.reduce((a, d) => a + d.count, 0),
    streak,
    longestStreak: longest,
    todayPending,
    last30,
    lastPostAt: last?.at,
    hoursSinceLast: last ? Math.round(((nowMs - Date.parse(last.at)) / 3600_000) * 10) / 10 : undefined,
    scheduled: posts
      .filter((p) => p.status === "scheduled" && Date.parse(p.at) >= nowMs - 60_000)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(0, 12)
      .map((p) => ({ id: p.id, at: p.at, text: p.text, hook: hookOf(p.text) })),
    drafts: posts.filter((p) => p.status === "draft").length,
  };
}

// ---- performance ------------------------------------------------------------------------------

export const engagement = (m: Metrics | undefined): number => (m ? (m.likes ?? 0) + 2 * (m.replies ?? 0) + 3 * (m.reposts ?? 0) + 3 * (m.quotes ?? 0) + 2 * (m.shares ?? 0) : 0);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const withMetrics = (posts: Post[]) => posts.filter((p) => p.status === "published" && p.metricsKnown && p.metrics?.views !== undefined);

export type Baseline = { medianViews: number; medianEngRate: number; n: number };
export function baseline(posts: Post[]): Baseline {
  const ps = withMetrics(posts);
  return {
    n: ps.length,
    medianViews: median(ps.map((p) => p.metrics!.views!)),
    medianEngRate: median(ps.filter((p) => p.metrics!.views! > 0).map((p) => engagement(p.metrics) / p.metrics!.views!)),
  };
}

export type Winner = {
  post: Post;
  score: number;
  labels: string[];
  vsViews: number; // multiples of the account median, 1 = typical
  vsEng: number;
  engRate: number;
  ageDays: number;
  features: Features;
};

const mult = (x: number, base: number) => (base > 0 ? Math.round((x / base) * 10) / 10 : 0);

/** Ranks posts by how much they beat the account's own median. Leads that the owner logged by hand count most. */
export function rankWinners(posts: Post[], now: Date, limit = 8): Winner[] {
  const ps = withMetrics(posts);
  const base = baseline(posts);
  const rows = ps.map((post) => {
    const views = post.metrics!.views!;
    const eng = engagement(post.metrics);
    const engRate = views > 0 ? eng / views : 0;
    const ageDays = Math.max(0, (now.getTime() - Date.parse(post.at)) / DAY_MS);
    const vsViews = mult(views, base.medianViews);
    const vsEng = mult(engRate, base.medianEngRate);
    const leads = post.leads ?? 0;
    const score = 3 * Math.log2(1 + vsEng) + 2 * Math.log2(1 + vsViews) + 6 * leads + (ageDays <= 7 ? 1 : 0);
    return { post, score: Math.round(score * 100) / 100, labels: [] as string[], vsViews, vsEng, engRate, ageDays, features: features(post) };
  });
  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, limit);
  const topLeads = Math.max(0, ...rows.map((r) => r.post.leads ?? 0));
  for (const r of top) {
    if (r.vsViews >= 1.5 && r.ageDays <= 14) r.labels.push("Tontonan tinggi");
    if (r.vsEng >= 1.5) r.labels.push("Paling engage");
    if (topLeads > 0 && (r.post.leads ?? 0) === topLeads) r.labels.push("Paling convert");
    if (r.ageDays > 14 && r.vsViews >= 1.5) r.labels.push("Lama tapi masih kuat");
  }
  return top;
}

// ---- heatmap and hook performance -------------------------------------------------------------

export type Cell = { n: number; views: number; avgViews: number };
export function heatmap(posts: Post[]): Cell[][] {
  const grid: Cell[][] = Array.from({ length: 7 }, () => Array.from({ length: SLOT_COUNT }, () => ({ n: 0, views: 0, avgViews: 0 })));
  for (const p of posts) {
    if (!isPublished(p)) continue;
    const t = mytParts(p.at);
    const c = grid[t.dow][Math.floor(t.hour / 3)];
    c.n++;
    if (p.metricsKnown && p.metrics?.views !== undefined) c.views += p.metrics.views;
  }
  for (const row of grid) for (const c of row) c.avgViews = c.n ? Math.round(c.views / c.n) : 0;
  return grid;
}

export function bestWindows(grid: Cell[][], k = 3): { dow: number; slot: number; label: string; n: number; avgViews: number }[] {
  const all = grid.flatMap((row, dow) => row.map((c, slot) => ({ dow, slot, label: slotLabel(dow, slot), n: c.n, avgViews: c.avgViews })));
  const enough = all.filter((c) => c.n >= 2 && c.avgViews > 0);
  const pool = enough.length >= k ? enough : all.filter((c) => c.n >= 1 && c.avgViews > 0);
  return pool.sort((a, b) => b.avgViews - a.avgViews || b.n - a.n).slice(0, k);
}

export type HookStat = { type: HookType; n: number; avgViews: number; avgEngRate: number; daysSinceLast?: number };
export function hookStats(posts: Post[], now: Date): HookStat[] {
  const out: HookStat[] = [];
  for (const type of HOOK_TYPES) {
    const ps = posts.filter((p) => isPublished(p) && hookType(p.text) === type);
    const m = ps.filter((p) => p.metricsKnown && p.metrics?.views !== undefined);
    const last = ps.map((p) => Date.parse(p.at)).sort((a, b) => b - a)[0];
    out.push({
      type,
      n: ps.length,
      avgViews: m.length ? Math.round(m.reduce((a, p) => a + p.metrics!.views!, 0) / m.length) : 0,
      avgEngRate: m.length ? Math.round((m.reduce((a, p) => a + (p.metrics!.views! > 0 ? engagement(p.metrics) / p.metrics!.views! : 0), 0) / m.length) * 1000) / 1000 : 0,
      daysSinceLast: last ? Math.floor((now.getTime() - last) / DAY_MS) : undefined,
    });
  }
  return out;
}

// ---- schedule suggestions ---------------------------------------------------------------------

export type Slot = { at: string; label: string; why: string };

/** Up to `k` upcoming times: the best windows first, at least 20 min ahead and 90 min away from anything already scheduled. */
export function suggestSlots(grid: Cell[][], scheduled: string[], now: Date, k = 3): Slot[] {
  const best = bestWindows(grid, 6);
  const taken = scheduled.map((s) => Date.parse(s));
  const out: Slot[] = [];
  const nowMs = now.getTime();
  const consider = (ms: number, why: string) => {
    if (ms < nowMs + 20 * 60_000) return;
    if (taken.some((t) => Math.abs(t - ms) < 90 * 60_000)) return;
    if (out.some((o) => Math.abs(Date.parse(o.at) - ms) < 90 * 60_000)) return;
    const p = mytParts(ms);
    out.push({ at: new Date(ms).toISOString(), label: `${DOW[p.dow]} ${p.date.slice(8)}/${p.date.slice(5, 7)} ${String(p.hour).padStart(2, "0")}:${String(new Date(ms + MYT_MS).getUTCMinutes()).padStart(2, "0")}`, why });
  };
  const today = mytDate(now);
  for (let d = 0; d < 8 && out.length < k; d++) {
    const date = addDays(today, d);
    const dow = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
    for (const b of best) {
      if (b.dow !== dow) continue;
      // window start + 1:30
      consider(Date.parse(date + "T00:00:00Z") - MYT_MS + (b.slot * 3 + 1.5) * 3600_000, `${b.label}, purata ${b.avgViews} tontonan`);
      if (out.length >= k) break;
    }
  }
  // not enough history: sensible Malaysian evening / lunch / morning defaults
  const defaults = [[12, 30], [19, 30], [21, 0], [8, 30]];
  for (let d = 0; d < 3 && out.length < k; d++) {
    for (const [h, m] of defaults) {
      if (out.length >= k) break;
      const date = addDays(today, d);
      consider(Date.parse(date + "T00:00:00Z") - MYT_MS + (h * 60 + m) * 60_000, "waktu aktif biasa (belum cukup data)");
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, k);
}
