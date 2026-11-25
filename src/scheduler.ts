// Drafts and scheduled posts live in the connector's own queue (Threads' API has neither). `tick()` publishes what is due.
// It is called by GET/POST /tick/<TICK_TOKEN> (a free pinger every minute) and opportunistically whenever a tool reads posts.
//
// Safety rules, because a wrong post is public:
//  - a post is marked "publishing" BEFORE the API call, so overlapping ticks cannot double-post it
//  - a post stuck in "publishing" is never retried automatically (it may already be live): it becomes "failed" for a human to check
//  - a post more than 3 hours past its time is NOT published late: it becomes "failed" with a clear reason
//  - a failed attempt is retried after 30 minutes, at most 3 attempts
import { hookOf } from "./metrics.js";
import { lock, load, unlock, update } from "./store.js";
import * as threads from "./threads.js";
import type { QueueItem } from "./types.js";

export const OVERDUE_MS = 3 * 3600_000;
export const RETRY_MS = 30 * 60_000;
export const STUCK_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const PER_TICK = 5;

export type TickResult = { skipped?: boolean; due: number; published: number; failed: number; retrying: number };

const isDue = (q: QueueItem, nowMs: number) =>
  q.status === "scheduled" && !!q.scheduledFor && Date.parse(q.scheduledFor) <= nowMs && (!q.nextAttemptAt || Date.parse(q.nextAttemptAt) <= nowMs);

export async function hasDue(now = new Date()): Promise<boolean> {
  const s = await load();
  return Object.values(s.queue).some((q) => isDue(q, now.getTime()) || (q.status === "publishing" && now.getTime() - Date.parse(q.lockedAt ?? q.createdAt) > STUCK_MS));
}

/** Publishes one queue item that is already marked "publishing". Never throws: the outcome is written to the queue. */
export async function runItem(id: string, now: Date): Promise<QueueItem> {
  const s0 = await load();
  const item = s0.queue[id];
  if (!item) throw new Error("queue item missing");
  try {
    const token = await threads.accessToken(now);
    const res = await threads.publish(token, item.parts, { mediaUrls: item.mediaUrls, topic: item.topic });
    return await update((s) => {
      const q = s.queue[id];
      q.status = "published"; q.threadsId = res.id; q.url = res.url; q.publishedAt = now.toISOString();
      q.error = res.warning; q.lockedAt = undefined; q.nextAttemptAt = undefined;
      return { ...q };
    });
  } catch (e) {
    const ambiguous = e instanceof threads.ThreadsError && e.ambiguous;
    return await update((s) => {
      const q = s.queue[id];
      q.attempts += 1; q.lockedAt = undefined;
      q.error = (e as Error).message;
      if (ambiguous || q.attempts >= MAX_ATTEMPTS || !q.scheduledFor) {
        q.status = "failed";
        if (ambiguous) q.error += " Semak dalam app Threads sama ada ia dah live sebelum cuba lagi.";
      } else {
        q.status = "scheduled"; q.nextAttemptAt = new Date(now.getTime() + RETRY_MS).toISOString();
      }
      return { ...q };
    });
  }
}

export async function tick(now = new Date()): Promise<TickResult> {
  const res: TickResult = { due: 0, published: 0, failed: 0, retrying: 0 };
  if (!(await lock("tick", 55))) return { ...res, skipped: true };
  try {
    const nowMs = now.getTime();
    // 1. settle items that are stuck or hopelessly late, without publishing anything
    await update((s) => {
      for (const q of Object.values(s.queue)) {
        if (q.status === "publishing" && nowMs - Date.parse(q.lockedAt ?? q.createdAt) > STUCK_MS) {
          q.status = "failed"; q.error = "Tersangkut semasa dipost. Semak dalam app Threads sama ada ia dah live sebelum cuba lagi."; q.lockedAt = undefined;
        } else if (isDue(q, nowMs) && nowMs - Date.parse(q.scheduledFor!) > OVERDUE_MS) {
          q.status = "failed";
          q.error = `Terlepas masa jadual (lewat ${Math.round((nowMs - Date.parse(q.scheduledFor!)) / 3600_000)} jam), jadi tak dipost secara automatik. Guna reschedule_post atau post sekarang.`;
          res.failed++;
        }
      }
    });
    // 2. claim due items (mark publishing before the API call), then publish them one by one
    const claimed = await update((s) => {
      const due = Object.values(s.queue).filter((q) => isDue(q, nowMs)).sort((a, b) => Date.parse(a.scheduledFor!) - Date.parse(b.scheduledFor!)).slice(0, PER_TICK);
      for (const q of due) { q.status = "publishing"; q.lockedAt = now.toISOString(); }
      return due.map((q) => q.id);
    });
    res.due = claimed.length;
    for (const id of claimed) {
      const out = await runItem(id, now);
      if (out.status === "published") res.published++;
      else if (out.status === "failed") res.failed++;
      else res.retrying++;
    }
    return res;
  } finally {
    await unlock("tick");
  }
}

/** Cheap check used by read tools: only runs a tick when something is actually due. Never throws. */
export async function maybeTick(now = new Date()): Promise<void> {
  try { if (await hasDue(now)) await tick(now); } catch { /* reading must not fail because publishing did */ }
}

export const newQueueItem = (p: Partial<QueueItem> & { id: string; parts: string[]; status: QueueItem["status"] }, now: Date): QueueItem => ({
  hook: hookOf(p.parts[0]),
  createdAt: now.toISOString(),
  attempts: 0,
  ...p,
});
