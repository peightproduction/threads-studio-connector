// Loads their posts and merges two sources into one list:
//   1. Meta's Threads API: everything that is live on their account, including posts typed in the Threads app
//   2. the connector's own queue: drafts, scheduled posts, failed ones (the Threads API has none of these)
// Numbers (views, likes, ...) come from Threads' insights, cached in the state so one chat does not cost 60 API calls.
import { sameText } from "./lint.js";
import { load, update } from "./store.js";
import * as threads from "./threads.js";
import { StudioError, type Metrics, type Post, type QueueItem, type State } from "./types.js";

const TTL_MS = 60_000;
let cache: { at: number; days: number; value: Loaded } | undefined;

export type Loaded = { posts: Post[]; notes: string[]; username?: string };

export function invalidate() { cache = undefined; }

const DAY = 86_400_000;
/** How long cached numbers stay fresh: new posts move fast, old ones barely change. */
const ttlFor = (postAgeMs: number) => (postAgeMs < 2 * DAY ? 10 * 60_000 : postAgeMs < 14 * DAY ? 3 * 3600_000 : 24 * 3600_000);
const FETCH_CAP = 40; // insights calls per load
const CONCURRENCY = 6;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export function fromQueue(q: QueueItem): Post {
  const status = q.status === "draft" ? "draft" : q.status === "failed" ? "failed" : q.status === "published" ? "published" : "scheduled";
  const at = q.status === "published" ? q.publishedAt ?? q.createdAt : q.status === "draft" ? q.createdAt : q.scheduledFor ?? q.createdAt;
  return {
    id: q.status === "published" && q.threadsId ? q.threadsId : q.id,
    platformId: q.threadsId,
    text: q.parts[0] ?? "",
    status, at, url: q.url, topic: q.topic, media: q.mediaUrls?.length ?? 0,
    source: "studio", angle: q.angle, metricsKnown: false, error: q.error,
  };
}

/** Pure: Meta posts + queue items + cached numbers + hand-logged leads -> one list, newest first. */
export function build(meta: Post[], state: Pick<State, "queue" | "metricsCache" | "results">): Post[] {
  const byThreads = new Map<string, QueueItem>();
  for (const q of Object.values(state.queue)) if (q.threadsId) byThreads.set(q.threadsId, q);
  const live = new Set(meta.map((p) => p.id));

  const out: Post[] = meta.map((p) => {
    const q = byThreads.get(p.id);
    const c = state.metricsCache[p.id];
    return {
      ...p,
      source: q ? "studio" : "native",
      angle: q?.angle, topic: q?.topic,
      metrics: c?.m, metricsKnown: Boolean(c),
      leads: state.results[p.id]?.leads,
    };
  });
  for (const q of Object.values(state.queue)) {
    if (q.status === "published" && q.threadsId && live.has(q.threadsId)) continue; // already listed from Threads
    const p = fromQueue(q);
    if (q.status === "published") { const c = q.threadsId ? state.metricsCache[q.threadsId] : undefined; p.metrics = c?.m; p.metricsKnown = Boolean(c); p.leads = q.threadsId ? state.results[q.threadsId]?.leads : undefined; }
    out.push(p);
  }
  return out.filter((p) => p.text.length > 0 || p.status !== "other").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function loadPosts(opts: { force?: boolean; days?: number } = {}): Promise<Loaded> {
  const days = Math.max(opts.days ?? 60, 30);
  if (!opts.force && cache && cache.days >= days && Date.now() - cache.at < TTL_MS) return cache.value;
  if (!(await threads.connected())) throw new StudioError("Threads belum disambung. Panggil tool connect_threads dan buka pautan yang diberi (buka halaman /setup pada alamat connector awak untuk semak).");

  const token = await threads.accessToken();
  const notes: string[] = [];
  const meta = await threads.listPosts(token, days);
  const username = (await load()).threads?.username;

  // refresh the cached numbers that are missing or stale, newest posts first
  const state = await load();
  const nowMs = Date.now();
  const need = meta
    .filter((p) => nowMs - Date.parse(p.at) < 90 * DAY)
    .filter((p) => { const c = state.metricsCache[p.id]; return !c || nowMs - Date.parse(c.at) > ttlFor(nowMs - Date.parse(p.at)); })
    .slice(0, FETCH_CAP);
  const fresh: Record<string, { at: string; m: Metrics }> = {};
  let failed = 0, firstError: string | undefined;
  await pool(need, CONCURRENCY, async (p) => {
    try { fresh[p.id] = { at: new Date().toISOString(), m: await threads.insights(token, p.id) }; }
    catch (e) { failed++; firstError ??= (e as Error).message; }
  });
  if (Object.keys(fresh).length) await update((s) => { Object.assign(s.metricsCache, fresh); });
  if (failed) notes.push(`${failed} post tiada nombor daripada Threads (${firstError}). Dianggap tak diketahui, bukan sifar.`);
  if (need.length === FETCH_CAP) notes.push("Nombor sebahagian post lama akan dikemas kini pada panggilan seterusnya.");

  const fin = await load();
  const posts = build(meta, fin);
  const value: Loaded = { posts, notes, username };
  cache = { at: Date.now(), days, value };
  return value;
}

/** The short code inside a Threads address (…/post/DgHfKpkleHF), or a bare short code. Numeric ids and plain words give undefined. */
export function shortcodeOf(ref: string): string | undefined {
  const t = ref.trim();
  const inUrl = t.match(/\/post\/([A-Za-z0-9_-]{5,40})/);
  if (inUrl) return inUrl[1];
  return /^[A-Za-z0-9_-]{8,40}$/.test(t) && !/^\d+$/.test(t) ? t : undefined;
}

/** One LIVE post by Threads id, Threads link (threads.com or threads.net) or short code. */
export function findByRef(posts: Post[], ref: string): Post | undefined {
  const t = ref.trim();
  if (!t) return undefined;
  const live = posts.filter((p) => p.status === "published");
  const exact = live.find((p) => p.id === t || p.platformId === t);
  if (exact) return exact;
  const code = shortcodeOf(t);
  return code ? live.find((p) => p.url?.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1] === code) : undefined;
}

/** Re-reads the numbers (views, likes, replies...) of these posts from Threads right now, ignoring the cache. */
export async function freshen(list: Post[]): Promise<{ posts: Post[]; failed: number; firstError?: string }> {
  const targets = list.filter((p) => p.status === "published" && p.platformId);
  if (!targets.length) return { posts: list, failed: 0 };
  const token = await threads.accessToken();
  const fresh: Record<string, { at: string; m: Metrics }> = {};
  let failed = 0, firstError: string | undefined;
  await pool(targets, CONCURRENCY, async (p) => {
    try { fresh[p.id] = { at: new Date().toISOString(), m: await threads.insights(token, p.platformId!) }; }
    catch (e) { failed++; firstError ??= (e as Error).message; }
  });
  if (Object.keys(fresh).length) await update((s) => { Object.assign(s.metricsCache, fresh); });
  return { posts: list.map((p) => (fresh[p.id] ? { ...p, metrics: fresh[p.id].m, metricsKnown: true } : p)), failed, firstError };
}

/** True if the same text is already a draft/scheduled/published post from the last 24 h or the future. */
export function duplicateOf(posts: Post[], text: string, mode: "draft" | "schedule" | "publish", now: Date): Post | undefined {
  const since = now.getTime() - 24 * 3600_000;
  return posts.find((p) => {
    if (Date.parse(p.at) < since) return false;
    if (p.status === "failed" || p.status === "other") return false;
    if (mode !== "draft" && p.status === "draft") return false; // finishing a draft is allowed
    return sameText(p.text, text);
  });
}
