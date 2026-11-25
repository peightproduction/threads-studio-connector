// Two requests changing the saved state at the same moment must never lose each other's change (this really happened: a draft
// deletion was undone by a new scheduled post written at the same time). Runs against a fake Redis that interleaves like the
// real one (every call waits a random few milliseconds), through TWO separate store instances = two Vercel servers.
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisData = vi.hoisted(() => new Map<string, string>()); // key -> JSON text, like Redis
const redisCalls = vi.hoisted(() => ({ n: 0, rejectCas: false }));
vi.mock("@upstash/redis", () => {
  const wait = () => new Promise((r) => setTimeout(r, Math.random() * 4));
  const read = (k: string) => { const v = redisData.get(k); return v === undefined ? null : JSON.parse(v); };
  return {
    Redis: class {
      async get<T>(k: string): Promise<T | null> { redisCalls.n++; await wait(); return read(k) as T | null; }
      async mget(...keys: string[]) { redisCalls.n++; await wait(); return keys.map(read); }
      async set(k: string, v: unknown) { redisCalls.n++; await wait(); redisData.set(k, JSON.stringify(v)); return "OK"; }
      async incr(k: string) { await wait(); const n = Number(read(k) ?? 0) + 1; redisData.set(k, JSON.stringify(n)); return n; }
      // the compare-and-set script: write the state only if the version is still the one the caller read, then bump the version
      async eval(_script: string, keys: string[], args: string[]) {
        redisCalls.n++; await wait();
        if (redisCalls.rejectCas) return 0;
        if (String(read(keys[1]) ?? 0) !== args[0]) return 0;
        redisData.set(keys[0], args[1]);
        redisData.set(keys[1], JSON.stringify(Number(read(keys[1]) ?? 0) + 1));
        return 1;
      }
    },
  };
});

process.env.KV_REST_API_URL = "https://fake.upstash.test";
process.env.KV_REST_API_TOKEN = "fake";
delete process.env.VERCEL;

type Store = typeof import("../src/store.js");
const instance = async (): Promise<Store> => { vi.resetModules(); return import("../src/store.js"); }; // a fresh copy = another server
const q = (id: string) => ({ id, status: "draft" as const, parts: [id], hook: id, createdAt: "2026-11-24T10:00:00.000Z", attempts: 0 });

beforeEach(() => { redisData.clear(); redisCalls.n = 0; redisCalls.rejectCas = false; });

describe("saved state under concurrent changes", () => {
  it("control: a plain read-then-write really does lose changes here (so the tests below mean something)", async () => {
    const s = await instance();
    expect(s.backend()).toBe("redis");
    await Promise.all(Array.from({ length: 30 }, async (_, i) => { const st = await s.load(); st.insights.push({ id: `i${i}`, at: "x", text: `t${i}` }); await s.save(st); }));
    expect((await s.load()).insights.length).toBeLessThan(30);
  });

  it("keeps every change when 40 updates run at once on two servers", async () => {
    const a = await instance();
    const b = await instance();
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).update((st) => { st.insights.push({ id: `i${i}`, at: "x", text: `t${i}` }); })));
    const st = await a.load();
    expect(st.insights.map((x) => x.id).sort()).toEqual(Array.from({ length: 40 }, (_, i) => `i${i}`).sort());
  });

  it("a deletion, a new post and a timer ping made at the same moment all stick (the real bug)", async () => {
    const a = await instance();
    const b = await instance();
    await a.update((s) => { for (let i = 0; i < 5; i++) s.queue[`d${i}`] = q(`d${i}`); });
    for (let round = 0; round < 15; round++) {
      await Promise.all([
        a.update((s) => { delete s.queue[`d${round % 5}`]; }),               // Claude deletes a draft
        b.update((s) => { s.queue[`new${round}`] = q(`new${round}`); }),      // another request adds a scheduled post
        b.update((s) => { s.lastPingAt = `ping${round}`; }),                  // the timer pings
        a.update((s) => { s.queue[`d${round % 5}`] = q(`d${round % 5}`); }),  // the draft is re-added so the next round can delete it again
      ]);
    }
    const s = await a.load();
    for (let round = 0; round < 15; round++) expect(s.queue[`new${round}`], `new${round}`).toBeTruthy();
    expect(s.lastPingAt).toBe("ping14");
  });

  it("many simultaneous deletions all take effect, even with writers racing them", async () => {
    const a = await instance();
    const b = await instance();
    await a.update((s) => { for (let i = 0; i < 30; i++) s.queue[`x${i}`] = q(`x${i}`); });
    await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).update((s) => { delete s.queue[`x${i}`]; })),
      ...Array.from({ length: 5 }, (_, i) => b.update((s) => { s.queue[`keep${i}`] = q(`keep${i}`); })),
    ]);
    expect(Object.keys((await a.load()).queue).sort()).toEqual(["keep0", "keep1", "keep2", "keep3", "keep4"]);
  });

  it("an update costs two round trips when nobody else is writing (read both, then one atomic write)", async () => {
    const a = await instance();
    await a.update((s) => { s.settings.goalPerDay = 2; });
    redisCalls.n = 0;
    await a.update((s) => { s.settings.goalPerDay = 3; });
    expect(redisCalls.n).toBe(2);
  });

  it("redoes the change on the fresh state after a conflict, instead of overwriting", async () => {
    const a = await instance();
    const b = await instance();
    await a.update((s) => { s.queue.one = q("one"); });
    let runs = 0;
    const slow = a.update((s) => { runs++; s.queue.two = q("two"); });
    await b.update((s) => { s.queue.three = q("three"); }); // lands between a's read and write often enough; either way both must exist
    await slow;
    const keys = Object.keys((await a.load()).queue).sort();
    expect(keys).toEqual(["one", "three", "two"]);
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it("returns what the update function returns, and runs updates in the order they were asked for on one server", async () => {
    const a = await instance();
    const order: number[] = [];
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => a.update((st) => { order.push(n); st.settings.goalPerDay = n; return n * 10; })));
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect((await a.load()).settings.goalPerDay).toBe(5);
  });

  it("a failing update changes nothing and does not block the next one", async () => {
    const a = await instance();
    await a.update((st) => { st.settings.goalPerDay = 4; });
    await expect(a.update(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await a.update((st) => { st.settings.goalPerDay = 7; });
    expect((await a.load()).settings.goalPerDay).toBe(7);
  });

  it("gives up with a clear message if the state keeps changing under it, and writes nothing", async () => {
    const a = await instance();
    await a.update((s) => { s.settings.goalPerDay = 2; });
    redisCalls.rejectCas = true; // every write loses the race
    await expect(a.update((s) => { s.settings.goalPerDay = 99; })).rejects.toThrow(/sibuk menyimpan/);
    redisCalls.rejectCas = false;
    expect((await a.load()).settings.goalPerDay).toBe(2);
  }, 60_000);

  it("seeding with save() bumps the version, so an update that read before it cannot overwrite it", async () => {
    const a = await instance();
    const st = await a.load();
    st.settings.goalPerDay = 5;
    await a.save(st);
    expect(JSON.parse(redisData.get("threads-studio:rev")!)).toBeGreaterThanOrEqual(1);
    expect((await a.load()).settings.goalPerDay).toBe(5);
  });
});
