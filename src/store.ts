// Small persistent state: goal, playbook edits, which posts the connector created, hand-logged leads, saved lessons.
// Upstash Redis when its env vars exist (Vercel Marketplace), otherwise .data/state.json locally, otherwise memory
// (Vercel without Redis: settings vanish between requests, and callers are told).
import { Redis } from "@upstash/redis";
import fs from "node:fs/promises";
import path from "node:path";
import { StudioError, type State } from "./types.js";

export const emptyState = (): State => ({
  v: 2,
  settings: { goalPerDay: 1 },
  playbookEdits: {},
  removed: {},
  nonces: {},
  photos: {},
  queue: {},
  metricsCache: {},
  results: {},
  insights: [],
  recHistory: [],
  publishLog: {},
});

const KEY = "threads-studio:state";
const redisUrl = () => process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const FILE = path.join(process.cwd(), ".data", "state.json");

let redis: Redis | undefined;
let memory: State | undefined;

/** On Vercel without Redis every request starts with empty state: tokens, drafts and schedules would vanish. */
export const durable = (): boolean => backend() !== "memory" || process.env.ALLOW_MEMORY_STATE === "1"; // the env switch is for tests
export const backend = (): "redis" | "file" | "memory" => (redisUrl() && redisToken() ? "redis" : process.env.VERCEL ? "memory" : "file");

function merge(raw: Partial<State> | null | undefined): State {
  const base = emptyState();
  if (!raw) return base;
  return { ...base, ...raw, v: 2, settings: { ...base.settings, ...(raw.settings ?? {}) } };
}

const localLocks = new Map<string, number>();
/** Best-effort mutual exclusion (Redis SET NX EX when available), so two overlapping ticks never publish the same post twice. */
export async function lock(name: string, ttlSeconds: number): Promise<boolean> {
  if (backend() === "redis") {
    redis ??= new Redis({ url: redisUrl()!, token: redisToken()! });
    return (await redis.set(`threads-studio:lock:${name}`, "1", { nx: true, ex: ttlSeconds })) === "OK";
  }
  const until = localLocks.get(name) ?? 0;
  if (until > Date.now()) return false;
  localLocks.set(name, Date.now() + ttlSeconds * 1000);
  return true;
}
export async function unlock(name: string): Promise<void> {
  if (backend() === "redis") { redis ??= new Redis({ url: redisUrl()!, token: redisToken()! }); await redis.del(`threads-studio:lock:${name}`); return; }
  localLocks.delete(name);
}

export async function load(): Promise<State> {
  const b = backend();
  if (b === "redis") {
    redis ??= new Redis({ url: redisUrl()!, token: redisToken()! });
    return merge((await redis.get<State>(KEY)) as Partial<State> | null);
  }
  if (b === "file") {
    try { return merge(JSON.parse(await fs.readFile(FILE, "utf-8"))); } catch { return emptyState(); }
  }
  return (memory ??= emptyState());
}

/** Keeps the state small: forgets old logs, finished queue items, expired connect links, stale numbers. */
function prune(s: State): void {
  s.recHistory = s.recHistory.slice(-60);
  s.insights = s.insights.slice(-100);
  const now = Date.now();
  const cutoff = new Date(now - 120 * 86_400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(s.publishLog)) if (d < cutoff) delete s.publishLog[d];
  for (const [id, q] of Object.entries(s.queue)) {
    const done = q.status === "published" || q.status === "failed";
    if (done && now - Date.parse(q.publishedAt ?? q.scheduledFor ?? q.createdAt) > 90 * 86_400_000) delete s.queue[id];
  }
  for (const [n, exp] of Object.entries(s.nonces)) if (Date.parse(exp) < now) delete s.nonces[n];
  const ids = Object.keys(s.metricsCache);
  if (ids.length > 500) for (const id of ids.sort((a, b) => Date.parse(s.metricsCache[a].at) - Date.parse(s.metricsCache[b].at)).slice(0, ids.length - 500)) delete s.metricsCache[id];
}

/** Unconditional write (seeding, tests). Normal changes go through update(), which never overwrites someone else's change. */
export async function save(s: State): Promise<void> {
  prune(s);
  const b = backend();
  if (b === "redis") { redis ??= new Redis({ url: redisUrl()!, token: redisToken()! }); await redis.set(KEY, s); await redis.incr(REV); return; }
  if (b === "file") { await fs.mkdir(path.dirname(FILE), { recursive: true }); await fs.writeFile(FILE, JSON.stringify(s, null, 2)); return; }
  memory = s;
}

// ---- safe read-modify-write ------------------------------------------------------------------------
// The whole state is ONE saved object, so two overlapping updates (the every-minute timer, two tool calls Claude runs in
// parallel, a widget button) would overwrite each other and silently lose a change (a new scheduled post, a deletion).
// So every update is optimistic: read the state together with its version number, apply the change, and write it back ONLY if
// the version is still the same (one atomic step inside Redis). If someone else changed it in between, read again and redo the
// change on the fresh state. Inside one server instance updates also run one after another.
const REV = "threads-studio:rev";
const CAS = `local cur = redis.call('get', KEYS[2])
if cur == false then cur = '0' end
if cur ~= ARGV[1] then return 0 end
redis.call('set', KEYS[1], ARGV[2])
redis.call('incr', KEYS[2])
return 1`;
const MAX_TRIES = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let queueTail: Promise<unknown> = Promise.resolve();

/** Read-modify-write that never loses another request's change. `fn` must be synchronous and may run more than once. */
export function update<T>(fn: (s: State) => T): Promise<T> {
  const run = async (): Promise<T> => {
    if (backend() !== "redis") { const s = await load(); const out = fn(s); await save(s); return out; }
    redis ??= new Redis({ url: redisUrl()!, token: redisToken()! });
    for (let attempt = 0; ; attempt++) {
      const [raw, rev] = await redis.mget<[State | null, string | number | null]>(KEY, REV);
      const s = merge(raw);
      const out = fn(s);
      prune(s);
      if ((await redis.eval(CAS, [KEY, REV], [String(rev ?? 0), JSON.stringify(s)])) === 1) return out;
      if (attempt + 1 >= MAX_TRIES) throw new StudioError("Connector sibuk menyimpan data. Cuba lagi sebentar.");
      await sleep(Math.random() * Math.min(400, 15 * 2 ** Math.min(attempt, 5))); // someone else changed it first: pause a little, then redo on the fresh state
    }
  };
  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {}); // one failed update must not block the next
  return result;
}

/** How long one Redis round trip takes from this server, in ms (undefined when Redis is not used). Shown by connect_threads. */
export async function storageLatencyMs(): Promise<number | undefined> {
  if (backend() !== "redis") return undefined;
  redis ??= new Redis({ url: redisUrl()!, token: redisToken()! });
  const t0 = Date.now();
  await redis.get(REV);
  return Date.now() - t0;
}
