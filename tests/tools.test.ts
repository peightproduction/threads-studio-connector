// End-to-end through the real MCP protocol (in-memory) with a fake Meta Threads API behind a stubbed fetch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeThreads, metaTs } from "./fake-threads.js";

process.env.ALLOW_MEMORY_STATE = "1"; // tests treat the in-memory state as durable
process.env.VERCEL = "1"; // memory state, and server.ts does not listen
process.env.THREADS_APP_ID = "app123";
process.env.THREADS_APP_SECRET = "secret456";
process.env.PUBLIC_URL = "https://studio.test";

const NOW = "2026-11-24T10:00:00Z"; // Tue 18:00 MYT
const fake = createFakeThreads();
let client: Client;
let store: typeof import("../src/store.js");
let posts: typeof import("../src/posts.js");
let scheduler: typeof import("../src/scheduler.js");
let threads: typeof import("../src/threads.js");

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: (r.content?.[0]?.text as string) ?? "", err: Boolean(r.isError), sc: r.structuredContent as any };
};
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const publishCalls = () => fake.calls("POST", "/me/threads_publish");

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", fake.fetch);
  store = await import("../src/store.js");
  posts = await import("../src/posts.js");
  scheduler = await import("../src/scheduler.js");
  threads = await import("../src/threads.js");
  const { buildServer } = await import("../src/tools.js");
  const server = buildServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const connectedState = () => ({
  ...store.emptyState(),
  threads: { token: "tok", expiresAt: "2027-01-30T00:00:00.000Z", refreshedAt: "2026-11-23T00:00:00.000Z", userId: "u1", username: "demo_user" },
});

beforeEach(async () => {
  at(NOW);
  fake.reset();
  fake.addPost("t_z1", "Post terbaru semalam", "2026-11-23T04:00:00Z", { views: 100, likes: 3 });
  fake.addPost("t_e1", "Semalam client aku tanya harga 5 kali", "2026-11-22T04:00:00Z", { views: 1400, likes: 80, replies: 12, shares: 5 });
  fake.addPost("t_o1", "Biasa satu", "2026-11-10T04:00:00Z", { views: 90, likes: 2 });
  fake.addPost("t_o2", "Biasa dua", "2026-11-11T04:00:00Z", { views: 110, likes: 3 });
  fake.addPost("t_o3", "Biasa tiga", "2026-11-12T04:00:00Z", { views: 120, likes: 3 });
  await store.save(connectedState());
  posts.invalidate();
  fake.state.calls = [];
});

describe("tool list", () => {
  it("exposes the tools and marks the UI ones", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["studio_brief", "lint_post", "post_tracker", "show_recommendations", "winning_threads", "show_post_analysis", "page_analytics", "create_post", "list_scheduled", "find_posts", "get_replies", "reschedule_post", "remove_post", "connect_threads", "mark_result", "save_insight", "set_goal", "set_playbook"]) expect(names).toContain(n);
    expect((tools.find((x) => x.name === "post_tracker") as any)._meta?.ui?.resourceUri).toBe("ui://studio/threads-v9.html");
    const res = await client.readResource({ uri: "ui://studio/threads-v9.html" });
    expect((res.contents[0] as any).text.length).toBeGreaterThan(100);
  });
  it("serves the same new card at every older address, and shows its version on the card and in connect_threads", async () => {
    const fresh = (await client.readResource({ uri: "ui://studio/threads-v9.html" })).contents[0] as any;
    for (const uri of ["ui://studio/threads.html", "ui://studio/threads-v4.html", "ui://studio/threads-v5.html", "ui://studio/threads-v6.html", "ui://studio/threads-v7.html", "ui://studio/threads-v8.html"]) expect(((await client.readResource({ uri })).contents[0] as any).text).toBe(fresh.text);
    expect(fresh.text).toContain("Versi kad 9");
    expect(JSON.parse((await call("connect_threads")).text).card_version).toBe("9");
    for (const t of [">Upload gambar<", "Gambar untuk post ni", "Letak gambar kat sini", "data-paste", "Tampal gambar"]) expect(fresh.text).toContain(t);
    // cream and brown (light), beige on espresso-brown (dark): no orange, no teal or green tints, no charcoal-black accent
    for (const c of ["#f8f3e8", "#efe6d3", "#6f4e37", "#24201c", "#322c26", "#d4b895"]) expect(fresh.text, c).toContain(c);
    for (const c of ["#b5532f", "#d97757", "#9c431f", "#e9967a", "#3b372d", "#ebe6d3", "#faf9f5", "#262624", "#194b46", "#5fd0bf", "#f2f7f3", "#182623", "#101a18", "#c9d9d1"]) expect(fresh.text, c).not.toContain(c);
  });
  it("steers Claude to the in-chat upload card, never to the web link first", async () => {
    const { tools } = await client.listTools();
    const desc = (n: string) => tools.find((t) => t.name === n)!.description ?? "";
    const rules = client.getInstructions() ?? "";
    expect(rules).toMatch(/call list_photos IMMEDIATELY/);
    expect(rules).toMatch(/NEVER lead with photo_upload_link/);
    expect(desc("photo_upload_link")).toMatch(/^LAST RESORT ONLY/);
    expect(desc("photo_upload_link")).toMatch(/Do NOT use it when the owner wants to upload/);
    expect(desc("list_photos")).toMatch(/THE way the owner uploads pictures/);
    expect(desc("show_recommendations")).toMatch(/Upload gambar/);
  });
});

describe("reading from Threads", () => {
  it("counts every live post, including ones typed in the Threads app", async () => {
    const r = await call("post_tracker");
    expect(r.sc.kind).toBe("tracker");
    expect(r.sc.data.total30).toBe(5);
    expect(r.sc.data.week).toBe(1); // only Mon 23rd is in this week
    expect(r.sc.data.month).toBe(5);
    expect(r.sc.data.streak).toBe(2); // Sun 22nd + Mon 23rd; today still open
  });
  it("follows paging cursors", async () => {
    fake.state.pageSize = 2;
    const r = await call("post_tracker");
    expect(r.sc.data.total30).toBe(5);
    expect(fake.calls("GET", "/me/threads").length).toBeGreaterThanOrEqual(3);
  });
  it("only keeps posts inside the window, and works even if Meta rejects the `since` filter", async () => {
    fake.addPost("t_ancient", "Post lama sangat", "2026-05-01T04:00:00Z", { views: 5 });
    expect((await call("post_tracker")).sc.data.total30).toBe(5); // the ancient one is outside 60 days
    fake.state.rejectSince = true;
    posts.invalidate();
    const r = await call("post_tracker");
    expect(r.err).toBe(false);
    expect(r.sc.data.total30).toBe(5);
    expect(fake.calls("GET", "/me/threads").some((c) => !c.params.since)).toBe(true);
  });
  it("leaves reposts of other people out", async () => {
    fake.state.live.push({ id: "rp", text: "", timestamp: metaTs("2026-11-23T05:00:00Z"), permalink: "x", media_type: "REPOST_FACADE" });
    expect((await call("post_tracker")).sc.data.total30).toBe(5);
  });
  it("reads numbers from insights and caches them", async () => {
    const w = await call("winning_threads");
    expect(w.sc.winners[0].post.id).toBe("t_e1");
    expect(w.sc.winners[0].post.metrics).toMatchObject({ views: 1400, likes: 80, replies: 12, shares: 5 });
    const first = fake.calls("GET", /\/insights$/).length;
    expect(first).toBe(5);
    posts.invalidate();
    await call("winning_threads");
    expect(fake.calls("GET", /\/insights$/).length).toBe(first); // fresh enough: not fetched again
    at("2026-11-24T10:20:00Z"); // 20 min later: the newest posts are stale (10 min), old ones are not
    posts.invalidate();
    await call("winning_threads");
    expect(fake.calls("GET", /\/insights$/).length).toBeGreaterThan(first);
    expect(fake.calls("GET", /\/insights$/).length).toBeLessThan(first + 5);
  });
  it("treats posts whose insights fail as unknown, never zero", async () => {
    fake.state.insightFail.add("t_o1");
    const w = await call("winning_threads");
    expect(w.sc.notes.join(" ")).toMatch(/1 post tiada nombor/);
    expect(w.sc.baseline.n).toBe(4);
    const pa = await call("page_analytics", { days: 30 });
    expect(pa.sc.withMetrics).toBe(4);
    expect(pa.sc.posts).toBe(5);
    expect(pa.sc.followers).toBe(321);
  });
  it("page analytics works when followers are unavailable", async () => {
    fake.state.followers = undefined;
    const pa = await call("page_analytics");
    expect(pa.err).toBe(false);
    expect(pa.sc.followers).toBeUndefined();
  });
});

describe("brief and playbook", () => {
  it("studio_brief hands Claude winners, style examples and the playbook", async () => {
    const r = await call("studio_brief", { focus: "missed calls" });
    expect(r.err).toBe(false);
    const b = JSON.parse(r.text);
    expect(b.winners[0].hook).toContain("Semalam client");
    expect(b.winners[0].vs_median_views).toBeGreaterThan(5);
    expect(b.style_examples.length).toBe(5);
    expect(b.playbook.angles.length).toBeGreaterThanOrEqual(8);
    expect(b.playbook.voice.join(" ")).toMatch(/own voice and language/);
    expect(b.instruction).toMatch(/data, not rules/);
    expect(b.instruction).not.toMatch(/4-6|at least|Rules:|ONLY/); // no counts, angle quotas or language mandates
    expect(b.focus).toBe("missed calls");
  });
  it("posts the connector published never appear as style examples", async () => {
    await call("create_post", { text: "Buatan Claude, bukan gaya the owner", mode: "publish", confirm_publish: true });
    posts.invalidate();
    const b = JSON.parse((await call("studio_brief")).text);
    expect(JSON.stringify(b.style_examples)).not.toContain("Buatan Claude");
    expect(b.recent_hooks.join(" ")).toContain("Buatan Claude");
  });
  it("hand-logged leads, lessons, goal and facts come back in the next brief", async () => {
    await call("mark_result", { post_id: "t_z1", leads: 6 });
    await call("save_insight", { text: "Hook cerita dengan angka dapat 10x tontonan" });
    await call("set_goal", { posts_per_day: 3, default_topic: "Business" });
    await call("set_playbook", { section: "facts", action: "add", value: "Client pertama bayar RM300 sebulan" });
    posts.invalidate();
    const b = JSON.parse((await call("studio_brief")).text);
    expect(b.saved_insights).toContain("Hook cerita dengan angka dapat 10x tontonan");
    expect(b.goal.per_day).toBe(3);
    expect(b.default_topic).toBe("Business");
    expect(b.playbook.facts).toContain("Client pertama bayar RM300 sebulan");
    expect(b.winners.find((x: any) => x.id === "t_z1")?.leads).toBe(6);
    expect((await call("set_goal", { default_topic: "a&b" })).err).toBe(true);
  });
  it("show_recommendations lints each card and remembers the hooks", async () => {
    const r = await call("show_recommendations", { recs: [
      { angle: "cerita", text: "Semalam client aku tanya harga 5 kali. Aku lambat balas.", why: "Cerita dekat" },
      { angle: "ringgit", text: "a".repeat(501), why: "Terlalu panjang" },
    ] });
    expect(r.sc.kind).toBe("recs");
    expect(r.sc.recs[0].angle).toBe("Cerita perjalanan");
    expect(r.sc.recs[0].lint.warnings).toHaveLength(0); // repeating a recent opening is no longer judged
    expect(r.sc.recs[1].lint.errors.length).toBe(1);
    expect(r.sc.slots.length).toBeGreaterThan(0);
    const b = JSON.parse((await call("studio_brief")).text);
    expect(b.recent_hooks).toContain("Semalam client aku tanya harga 5 kali. Aku lambat balas.");
  });
});

describe("create_post: drafts, schedule, publish", () => {
  it("a draft is kept by the connector and never touches Threads", async () => {
    const r = await call("create_post", { text: "Halo dunia", topic: "Business", mode: "draft", angle: "cerita" });
    expect(r.err).toBe(false);
    expect(r.sc.kind).toBe("result");
    expect(fake.calls("POST", "/me/threads")).toHaveLength(0);
    const list = JSON.parse((await call("list_scheduled")).text);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "draft", hook: "Halo dunia" });
    expect(list[0].id).toMatch(/^q_/);
    expect((await call("post_tracker")).sc.data.drafts).toBe(1);
  });
  it("rejects 501 characters, a bad topic and an empty post before anything is sent", async () => {
    expect((await call("create_post", { text: "a".repeat(501), mode: "draft" })).err).toBe(true);
    expect((await call("create_post", { text: "ok", topic: "a.b", mode: "draft" })).err).toBe(true);
    expect((await call("create_post", { text: "   ", mode: "draft" })).err).toBe(true);
    expect(JSON.parse((await call("list_scheduled")).text)).toHaveLength(0);
  });
  it("refuses to publish without confirm_publish", async () => {
    const r = await call("create_post", { text: "Live sekarang", mode: "publish" });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/confirm_publish/);
    expect(fake.calls("POST", "/me/threads")).toHaveLength(0);
  });
  it("publishes when confirmed: container, then publish, with the topic", async () => {
    const r = await call("create_post", { text: "Live sekarang", topic: "Business", mode: "publish", confirm_publish: true });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/Dah post/);
    expect(r.text).toContain("threads.net");
    const c = fake.calls("POST", "/me/threads")[0];
    expect(c.params).toMatchObject({ media_type: "TEXT", text: "Live sekarang", topic_tag: "Business" });
    expect(publishCalls()).toHaveLength(1);
    posts.invalidate();
    const t = await call("post_tracker");
    expect(t.sc.data.total30).toBe(6); // the new post is live and counted
    expect(t.sc.data.today).toBe(1);
  });
  it("waits for the container to finish processing", async () => {
    vi.useRealTimers(); // the poll uses a real 2 s sleep
    fake.state.containerDelays = 1;
    try {
      const r = await call("create_post", { text: "Perlahan sikit", mode: "publish", confirm_publish: true });
      expect(r.err).toBe(false);
      expect(fake.calls("GET", /^\/c\d+$/).length).toBe(2);
    } finally { vi.useFakeTimers({ toFake: ["Date"] }); at(NOW); }
  }, 15_000);
  it("sends thread parts as replies chained to the first post", async () => {
    const r = await call("create_post", { text: "Satu", parts: ["Dua", "Tiga"], mode: "publish", confirm_publish: true });
    expect(r.err).toBe(false);
    const cs = fake.calls("POST", "/me/threads");
    expect(cs).toHaveLength(3);
    const first = fake.state.live.find((p) => p.text === "Satu")!;
    const second = fake.state.live.find((p) => p.text === "Dua")!;
    expect(second.reply_to).toBe(first.id);
    expect(fake.state.live.find((p) => p.text === "Tiga")!.reply_to).toBe(second.id);
  });
  it("keeps the first post and warns when a thread part fails", async () => {
    let n = 0;
    const real = fake.fetch;
    vi.stubGlobal("fetch", async (i: any, init: any) => { if (String(i).includes("threads_publish") && ++n === 2) return new Response(JSON.stringify({ error: { message: "boom", code: 2 } }), { status: 500 }); return real(i, init); });
    try {
      const r = await call("create_post", { text: "Satu", parts: ["Dua"], mode: "publish", confirm_publish: true });
      expect(r.err).toBe(false);
      expect(r.text).toMatch(/sambungan 2 gagal/);
    } finally { vi.stubGlobal("fetch", fake.fetch); }
  });
  it("blocks the same text twice (no double post), also against posts typed in Threads", async () => {
    expect((await call("create_post", { text: "Sekali sahaja", mode: "publish", confirm_publish: true })).err).toBe(false);
    posts.invalidate();
    const again = await call("create_post", { text: "Sekali sahaja", mode: "publish", confirm_publish: true });
    expect(again.err).toBe(true);
    expect(again.text).toMatch(/sama/);
    expect(publishCalls()).toHaveLength(1);
    at("2026-11-24T10:00:00Z");
    fake.addPost("t_native", "Taip dalam app Threads", "2026-11-24T08:00:00Z");
    posts.invalidate();
    expect((await call("create_post", { text: "taip dalam app threads!", mode: "draft" })).err).toBe(true);
  });
  it("a failed publish is reported, recorded as failed, and not retried by itself", async () => {
    fake.state.publishFailures = 1;
    const r = await call("create_post", { text: "Akan gagal", mode: "publish", confirm_publish: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Gagal post/);
    const list = JSON.parse((await call("list_scheduled")).text);
    expect(list[0]).toMatchObject({ status: "failed" });
    expect(list[0].error).toMatch(/unexpected/i);
    expect(publishCalls()).toHaveLength(1);
  });
  it("has no 10-a-day limit: 20 posts in a day go through, only Threads' own 250 brake applies", async () => {
    for (let i = 0; i < 20; i++) expect((await call("create_post", { text: `Post nombor ${i} berbeza`, mode: "publish", confirm_publish: true })).err, `post ${i}`).toBe(false);
    expect(publishCalls()).toHaveLength(20);
    await store.update((s) => { s.publishLog["2026-11-24"] = 250; });
    const r = await call("create_post", { text: "Yang ke dua ratus lima puluh satu", mode: "publish", confirm_publish: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Had 250/);
  });
});

describe("without Redis on Vercel the connector must not pretend to keep things", () => {
  it("refuses drafts and schedules, but still lets a confirmed post go out", async () => {
    process.env.ALLOW_MEMORY_STATE = "0";
    try {
      const d = await call("create_post", { text: "Draf hilang", mode: "draft" });
      expect(d.err).toBe(true);
      expect(d.text).toMatch(/Redis/);
      expect((await call("create_post", { text: "Jadual hilang", mode: "schedule", scheduled_for: "2026-11-24T21:00" })).err).toBe(true);
      expect((await call("create_post", { text: "Terus jalan", mode: "publish", confirm_publish: true })).err).toBe(false);
    } finally { process.env.ALLOW_MEMORY_STATE = "1"; }
  });
});

describe("scheduling (Threads has none, so the connector's own tick does it)", () => {
  const sched = (text = "Jadual malam", when = "2026-11-24T19:30") => call("create_post", { text, mode: "schedule", scheduled_for: when });

  it("validates schedule times (Malaysia time, 10 min ahead, 60 days max)", async () => {
    expect((await call("create_post", { text: "a", mode: "schedule" })).err).toBe(true);
    expect((await call("create_post", { text: "a", mode: "schedule", scheduled_for: "besok" })).err).toBe(true);
    expect((await call("create_post", { text: "a", mode: "schedule", scheduled_for: "2026-11-24T18:05" })).err).toBe(true);
    expect((await call("create_post", { text: "a", mode: "schedule", scheduled_for: "2027-06-01T10:00" })).err).toBe(true);
    const ok = await sched();
    expect(ok.err).toBe(false);
    const item = Object.values((await store.load()).queue)[0];
    expect(item.scheduledFor).toBe("2026-11-24T11:30:00.000Z"); // 19:30 MYT
    expect(fake.calls("POST", "/me/threads")).toHaveLength(0);
  });
  it("warns when no pinger has run, and stays quiet once one has", async () => {
    expect((await sched()).text).toMatch(/penjadual \(\/tick\) belum berjalan/);
    await store.update((s) => { s.lastPingAt = new Date().toISOString(); });
    expect((await sched("Satu lagi malam", "2026-11-24T20:30")).text).not.toMatch(/belum berjalan/);
  });
  it("publishes at the time, exactly once", async () => {
    await sched();
    expect(await scheduler.tick()).toMatchObject({ due: 0, published: 0 });
    at("2026-11-24T11:31:00Z");
    expect(await scheduler.tick()).toMatchObject({ due: 1, published: 1 });
    expect(publishCalls()).toHaveLength(1);
    expect(await scheduler.tick()).toMatchObject({ due: 0, published: 0 });
    expect(publishCalls()).toHaveLength(1);
    const q = Object.values((await store.load()).queue)[0];
    expect(q).toMatchObject({ status: "published" });
    expect(q.threadsId).toBeTruthy();
    expect(fake.calls("POST", "/me/threads")[0].params.text).toBe("Jadual malam");
  });
  it("two overlapping ticks never publish the same post twice", async () => {
    await sched();
    at("2026-11-24T11:31:00Z");
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    expect(publishCalls()).toHaveLength(1);
  });
  it("opportunistically publishes when a read tool runs after the time", async () => {
    await sched();
    at("2026-11-24T11:45:00Z");
    const t = await call("post_tracker");
    expect(publishCalls()).toHaveLength(1);
    expect(t.sc.data.today).toBe(1);
  });
  it("does not publish a post that is more than 3 hours late", async () => {
    await sched();
    at("2026-11-24T15:00:00Z"); // 3.5 h after 11:30Z
    const r = await scheduler.tick();
    expect(r).toMatchObject({ published: 0, failed: 1 });
    expect(publishCalls()).toHaveLength(0);
    const list = JSON.parse((await call("list_scheduled")).text);
    expect(list[0]).toMatchObject({ status: "failed" });
    expect(list[0].error).toMatch(/Terlepas masa jadual/);
  });
  it("retries a failed attempt after 30 minutes, and gives up after 3", async () => {
    await sched();
    fake.state.publishFailures = 1;
    at("2026-11-24T11:31:00Z");
    expect(await scheduler.tick()).toMatchObject({ retrying: 1, published: 0 });
    let q = Object.values((await store.load()).queue)[0];
    expect(q).toMatchObject({ status: "scheduled", attempts: 1 });
    at("2026-11-24T11:45:00Z");
    expect(await scheduler.tick()).toMatchObject({ due: 0 }); // too early for the retry
    at("2026-11-24T12:05:00Z");
    expect(await scheduler.tick()).toMatchObject({ published: 1 });

    await sched("Yang degil", "2026-11-24T21:00");
    fake.state.publishFailures = 3;
    for (const t of ["2026-11-24T13:01:00Z", "2026-11-24T13:35:00Z", "2026-11-24T14:10:00Z"]) { at(t); await scheduler.tick(); }
    q = Object.values((await store.load()).queue).find((x) => x.hook === "Yang degil")!;
    expect(q).toMatchObject({ status: "failed", attempts: 3 });
  });
  it("never auto-retries a post stuck in 'publishing' (it may already be live)", async () => {
    await store.update((s) => { s.queue.q_stuck = { id: "q_stuck", status: "publishing", parts: ["Tersangkut"], hook: "Tersangkut", createdAt: NOW, scheduledFor: NOW, lockedAt: NOW, attempts: 0 }; });
    at("2026-11-24T10:20:00Z");
    await scheduler.tick();
    expect((await store.load()).queue.q_stuck).toMatchObject({ status: "failed" });
    expect((await store.load()).queue.q_stuck.error).toMatch(/Semak dalam app Threads/);
    expect(publishCalls()).toHaveLength(0);
  });
  it("reschedule moves a draft or failed post to a new slot; remove deletes it", async () => {
    await call("create_post", { text: "Untuk dijadual", mode: "draft" });
    const id = JSON.parse((await call("list_scheduled")).text)[0].id;
    expect((await call("reschedule_post", { post_id: id, scheduled_for: "2026-11-24T18:05" })).err).toBe(true); // too soon
    expect((await call("reschedule_post", { post_id: id, scheduled_for: "2026-11-26T20:00" })).err).toBe(false);
    expect((await store.load()).queue[id]).toMatchObject({ status: "scheduled", scheduledFor: "2026-11-26T12:00:00.000Z" });
    expect((await call("remove_post", { post_id: id })).err).toBe(false);
    expect(JSON.parse((await call("list_scheduled")).text)).toHaveLength(0);
  });
});

describe("removing live posts", () => {
  it("needs confirm_delete, then deletes through the API and from the queue", async () => {
    await call("create_post", { text: "Untuk dipadam", mode: "publish", confirm_publish: true });
    const live = fake.state.live.find((p) => p.text === "Untuk dipadam")!;
    posts.invalidate();
    const no = await call("remove_post", { post_id: live.id });
    expect(no.err).toBe(true);
    expect(no.text).toMatch(/confirm_delete/);
    expect(fake.calls("DELETE", `/${live.id}`)).toHaveLength(0);
    expect((await call("remove_post", { post_id: live.id, confirm_delete: true })).err).toBe(false);
    expect(fake.calls("DELETE", `/${live.id}`)).toHaveLength(1);
    expect(Object.values((await store.load()).queue)).toHaveLength(0);
  });
  it("refuses to delete a published queue item by its queue id", async () => {
    await call("create_post", { text: "Sudah live", mode: "publish", confirm_publish: true });
    const qid = Object.keys((await store.load()).queue)[0];
    const r = await call("remove_post", { post_id: qid });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/sudah live/);
  });
});

describe("finding and removing a live post by its link", () => {
  const LINK = (code: string) => `https://www.threads.com/@demo_user/post/${code}`;
  beforeEach(() => {
    fake.addPost("17900000000000001", "Versi 1: quote lambat = customer lari", "2026-11-24T09:41:00Z", { views: 40, likes: 2, replies: 0 }, "DgHfKpkleHF");
    fake.addPost("17900000000000002", "Versi 2: balas dalam 5 minit menang job", "2026-11-24T09:42:00Z", { views: 35, likes: 1, replies: 3 }, "DgHfMIOlT-s");
    fake.addPost("17900000000000003", "Versi 3: RM300 hilang setiap minggu", "2026-11-24T09:43:00Z", { views: 30, likes: 1, replies: 0 }, "DgHfNqnld1S");
    posts.invalidate();
  });

  it("find_posts takes links and short codes, reports replies, and lists what it could not find", async () => {
    const r = await call("find_posts", { refs: [LINK("DgHfKpkleHF"), "DgHfMIOlT-s", "17900000000000003", LINK("NopeNopeNop")] });
    expect(r.err).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.posts.map((p: any) => [p.id, p.replies, p.has_replies])).toEqual([["17900000000000001", 0, false], ["17900000000000002", 3, true], ["17900000000000003", 0, false]]);
    expect(j.posts[0]).toMatchObject({ link: LINK("DgHfKpkleHF"), hook: "Versi 1: quote lambat = customer lari" });
    expect(j.not_found).toEqual([LINK("NopeNopeNop")]);
    expect(j.notes.join(" ")).toMatch(/Jangan teka id/);
  });
  it("reads reply counts fresh from Threads, not from the cache", async () => {
    await call("find_posts", { refs: ["DgHfKpkleHF"] });
    fake.state.metrics["17900000000000001"] = { views: 60, likes: 4, replies: 5 }; // someone just commented
    const j = JSON.parse((await call("find_posts", { refs: ["DgHfKpkleHF"] })).text);
    expect(j.posts[0]).toMatchObject({ replies: 5, has_replies: true, views: 60 });
  });
  it("can search by words, or list the latest posts", async () => {
    expect(JSON.parse((await call("find_posts", { contains: "RM300" })).text).posts.map((p: any) => p.id)).toEqual(["17900000000000003"]);
    const latest = JSON.parse((await call("find_posts", { limit: 2 })).text).posts;
    expect(latest.map((p: any) => p.id)).toEqual(["17900000000000003", "17900000000000002"]);
  });
  it("marks a post with unreadable numbers as unknown, never as no replies", async () => {
    fake.state.insightFail.add("17900000000000001");
    const j = JSON.parse((await call("find_posts", { refs: ["DgHfKpkleHF"] })).text);
    expect(j.posts[0].has_replies).not.toBe(false);
    expect(j.notes.join(" ")).toMatch(/tak diketahui/);
  });

  it("remove_post accepts the link, tells what will go (with the comments), and waits for confirm_delete", async () => {
    const no = await call("remove_post", { post_id: LINK("DgHfMIOlT-s") });
    expect(no.err).toBe(true);
    expect(no.text).toMatch(/Versi 2/);
    expect(no.text).toMatch(/3 komen/);
    expect(no.text).toMatch(/17900000000000002/);
    expect(no.text).toMatch(/confirm_delete/);
    expect(fake.calls("DELETE", /./)).toHaveLength(0);
    const yes = await call("remove_post", { post_id: LINK("DgHfMIOlT-s"), confirm_delete: true });
    expect(yes.err).toBe(false);
    expect(fake.calls("DELETE", "/17900000000000002")).toHaveLength(1);
    expect(fake.state.live.some((p) => p.id === "17900000000000002")).toBe(false);
    expect(fake.state.live.some((p) => p.id === "17900000000000001")).toBe(true); // only that one
  });
  it("remove_post with an unknown link deletes nothing and points to find_posts", async () => {
    const r = await call("remove_post", { post_id: LINK("NopeNopeNop"), confirm_delete: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/find_posts/);
    expect(fake.calls("DELETE", /./)).toHaveLength(0);
  });
  it("get_replies shows who commented and what they said, by link", async () => {
    fake.state.replies["17900000000000002"] = [
      { id: "r1", text: "Nak tau cara buat!", username: "ahmad.biz", timestamp: "2026-11-24T09:50:00+0000", permalink: "https://www.threads.com/@ahmad.biz/post/RRRRRRRRRR1", has_replies: false },
      { id: "r2", text: "Boleh, DM je.", username: "demo_user", timestamp: "2026-11-24T09:55:00+0000", has_replies: false, hide_status: "HIDDEN" },
    ];
    const r = await call("get_replies", { post: LINK("DgHfMIOlT-s") });
    expect(r.err).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.reply_count).toBe(2);
    expect(j.post).toMatchObject({ id: "17900000000000002", link: LINK("DgHfMIOlT-s") });
    expect(j.replies[0]).toMatchObject({ from: "@ahmad.biz", by_owner: false, text: "Nak tau cara buat!" });
    expect(j.replies[1]).toMatchObject({ from: "@demo_user", by_owner: true, hidden: true });
    expect(fake.calls("GET", "/17900000000000002/replies")[0].params.fields).toContain("text");
  });
  it("get_replies says so when there are none, never guesses an unknown post, and explains a missing permission", async () => {
    expect(JSON.parse((await call("get_replies", { post: "DgHfNqnld1S" })).text)).toMatchObject({ reply_count: 0, note: expect.stringMatching(/Tiada komen/) });
    const bad = await call("get_replies", { post: LINK("NopeNopeNop") });
    expect(bad.err).toBe(true);
    expect(bad.text).toMatch(/find_posts/);
    fake.state.repliesDenied = true;
    const denied = await call("get_replies", { post: "DgHfNqnld1S" });
    expect(denied.err).toBe(true);
    expect(denied.text).toMatch(/threads_read_replies/);
    expect(denied.text).toMatch(/reconnect=true/);
  });
  it("explains what to do when Meta refuses the delete for lack of permission", async () => {
    fake.state.deleteDenied = true;
    const r = await call("remove_post", { post_id: "DgHfKpkleHF", confirm_delete: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/threads_delete/);
    expect(r.text).toMatch(/reconnect=true/);
  });
});

describe("analysis cards", () => {
  it("builds an analysis with computed facts and rejects unknown ids", async () => {
    const w = await call("winning_threads");
    const a = await call("show_post_analysis", { post_id: w.sc.winners[0].post.id, why: ["Hook cerita konkrit"], reuse: ["Mula dengan detik sebenar"], avoid: [] });
    expect(a.sc.kind).toBe("analysis");
    expect(a.sc.features.hookType).toBe("cerita");
    expect(a.sc.vsViews).toBeGreaterThan(5);
    expect((await call("show_post_analysis", { post_id: "nope", why: ["x"], reuse: [] })).err).toBe(true);
  });
});

describe("connection and token", () => {
  it("not connected: tools say so and connect_threads gives a one-time link", async () => {
    await store.save(store.emptyState());
    posts.invalidate();
    const r = await call("post_tracker");
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/connect_threads/);
    const c = await call("connect_threads");
    const info = JSON.parse(c.text);
    expect(info.connected).toBe(false);
    expect(info.connect_link).toMatch(/^https:\/\/studio\.test\/connect\/[0-9a-f]{36}$/);
    const nonce = info.connect_link.split("/").pop();
    expect((await store.load()).nonces[nonce]).toBeTruthy();
    expect(threads.authorizeUrl(nonce)).toContain("scope=threads_basic%2Cthreads_content_publish%2Cthreads_manage_insights%2Cthreads_delete%2Cthreads_read_replies%2Cthreads_manage_replies");
    expect(threads.authorizeUrl(nonce)).toContain(encodeURIComponent("https://studio.test/oauth/callback"));
  });
  it("connected: reports who, how many posts, numbers, followers and the pinger", async () => {
    const info = JSON.parse((await call("connect_threads")).text);
    expect(info).toMatchObject({ connected: true, username: "demo_user", posts_read: 5, posts_with_numbers: 5, followers: 321, storage: "memory" });
    expect(info.connect_link).toBeUndefined();
    expect(info.scheduler_last_ping).toMatch(/belum pernah/);
    expect(JSON.parse((await call("connect_threads", { reconnect: true })).text).connect_link).toBeTruthy();
  });
  it("says plainly when scheduled posts are waiting but the timer is not running", async () => {
    await call("create_post", { text: "Untuk jadual malam ni", mode: "schedule", scheduled_for: "2026-11-24T21:00" });
    let info = JSON.parse((await call("connect_threads")).text);
    expect(info).toMatchObject({ scheduler_running: false, scheduler_minutes_since_ping: null });
    expect(info.scheduler_warning).toMatch(/TAK akan keluar/);
    await store.update((s) => { s.lastPingAt = new Date(Date.now() - 60_000).toISOString(); }); // the timer visited a minute ago
    info = JSON.parse((await call("connect_threads")).text);
    expect(info).toMatchObject({ scheduler_running: true, scheduler_minutes_since_ping: 1 });
    expect(info.scheduler_warning).toBeUndefined();
    await store.update((s) => { s.lastPingAt = new Date(Date.now() - 30 * 60_000).toISOString(); }); // it stopped half an hour ago
    expect(JSON.parse((await call("connect_threads")).text)).toMatchObject({ scheduler_running: false, scheduler_minutes_since_ping: 30 });
  });
  it("renews a token that is a week old, and keeps using the new one", async () => {
    await store.update((s) => { s.threads!.refreshedAt = "2026-11-10T00:00:00.000Z"; });
    await call("post_tracker");
    expect(fake.state.refreshes).toBe(1);
    expect((await store.load()).threads!.token).toBe("refreshed-token");
    expect(fake.calls("GET", "/me/threads")[0].params.access_token).toBe("refreshed-token");
    posts.invalidate();
    await call("post_tracker");
    expect(fake.state.refreshes).toBe(1); // not again
  });
  it("an expired token or a rejected one points back to connect_threads", async () => {
    await store.update((s) => { s.threads!.expiresAt = "2026-11-01T00:00:00.000Z"; });
    expect((await call("post_tracker")).text).toMatch(/connect_threads/);
    await store.save(connectedState());
    fake.state.rejectToken = "tok";
    posts.invalidate();
    const r = await call("post_tracker");
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/connect_threads/);
  });
  it("boots from THREADS_ACCESS_TOKEN when nothing is stored yet", async () => {
    await store.save(store.emptyState());
    process.env.THREADS_ACCESS_TOKEN = "env-token";
    try {
      posts.invalidate();
      expect((await call("post_tracker")).err).toBe(false);
      expect((await store.load()).threads?.token).toBe("env-token");
    } finally { delete process.env.THREADS_ACCESS_TOKEN; }
  });
  it("exchanges a code for a long-lived token and stores it", async () => {
    const ex = await threads.exchangeCode("abc#_");
    expect(ex).toEqual({ token: "long-token", expiresIn: 5184000 });
    const first = fake.calls("POST", "/oauth/access_token")[0];
    expect(first.params).toMatchObject({ client_id: "app123", client_secret: "secret456", grant_type: "authorization_code", code: "abc", redirect_uri: "https://studio.test/oauth/callback" });
    await threads.saveConnection(ex.token, ex.expiresIn);
    expect((await store.load()).threads).toMatchObject({ token: "long-token", username: "demo_user" });
    await expect(threads.exchangeCode("bad")).rejects.toThrow(/Invalid code/);
  });
  it("verifies Meta's signed requests", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(JSON.stringify({ user_id: "u1", algorithm: "HMAC-SHA256" })).toString("base64url");
    const sig = createHmac("sha256", "secret456").update(payload).digest("base64url");
    expect(threads.parseSignedRequest(`${sig}.${payload}`)).toMatchObject({ user_id: "u1" });
    expect(threads.parseSignedRequest(`${sig}x.${payload}`)).toBeUndefined();
    expect(threads.parseSignedRequest("garbage")).toBeUndefined();
  });
});

describe("limitless: any number of posts, any shape (create_posts, show_recommendations)", () => {
  const nth = (i: number) => ({ text: `Post bulk nombor ${i}: cerita unik ${i * 7}` });
  const day = (i: number) => `2026-12-${String(1 + Math.floor(i / 3)).padStart(2, "0")}T${["08:00", "13:00", "21:00"][i % 3]}`;
  const parse = (text: string) => JSON.parse(text.slice(text.indexOf("[{")));

  it("saves 20 drafts in one call, and none of them is published", async () => {
    const r = await call("create_posts", { mode: "draft", posts: Array.from({ length: 20 }, (_, i) => nth(i)) });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/^20 daripada 20 disimpan sebagai draf/);
    expect(r.sc).toMatchObject({ kind: "result", ok: true });
    expect(Object.values((await store.load()).queue).filter((q) => q.status === "draft")).toHaveLength(20);
    expect(JSON.parse((await call("list_scheduled")).text)).toHaveLength(20);
    expect(publishCalls()).toHaveLength(0);
  });
  it("schedules 20 posts over several days, each at its own time, in one call", async () => {
    const r = await call("create_posts", { mode: "schedule", posts: Array.from({ length: 20 }, (_, i) => ({ ...nth(i), scheduled_for: day(i) })) });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/^20 daripada 20 dijadualkan/);
    const q = Object.values((await store.load()).queue);
    expect(q).toHaveLength(20);
    expect(new Set(q.map((x) => x.scheduledFor)).size).toBe(20);
    expect(q.every((x) => x.status === "scheduled")).toBe(true);
    expect(parse(r.text)[3]).toMatchObject({ n: 4, ok: true, when: day(3) });
    expect(publishCalls()).toHaveLength(0);
  });
  it("reports each problem by number and still saves the rest", async () => {
    const r = await call("create_posts", { mode: "schedule", posts: [
      { ...nth(1), scheduled_for: "2026-12-01T08:00" },
      { text: "a".repeat(501), scheduled_for: "2026-12-01T09:00" },        // too long
      { ...nth(1), scheduled_for: "2026-12-01T10:00" },                    // same text as #1, inside the same batch
      { ...nth(4), scheduled_for: "2026-11-24T18:05" },                    // too soon
      { ...nth(5) },                                                       // no time
      { ...nth(6), scheduled_for: "2026-12-01T11:00", photo_ids: ["ph_nope"] }, // unknown picture
      { ...nth(7), scheduled_for: "2026-12-01T12:00", topic: "a.b" },     // bad topic
      { ...nth(8), scheduled_for: "2026-12-01T13:00" },
    ] });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/^2 daripada 8 dijadualkan, 6 gagal/);
    expect(r.sc.ok).toBe(false);
    const rows = parse(r.text);
    expect(rows.filter((x: any) => x.ok).map((x: any) => x.n)).toEqual([1, 8]);
    const why = (n: number) => rows.find((x: any) => x.n === n).error as string;
    expect(why(2)).toMatch(/terlalu panjang/);
    expect(why(3)).toMatch(/Teks yang sama/);
    expect(why(4)).toMatch(/10 minit/);
    expect(why(5)).toMatch(/scheduled_for/);
    expect(why(6)).toMatch(/tak ada dalam bank/);
    expect(why(7)).toMatch(/Topik/);
    expect(Object.keys((await store.load()).queue)).toHaveLength(2);
  });
  it("a retried bulk call does not create duplicates", async () => {
    const args = { mode: "draft", posts: [nth(1), nth(2)] };
    await call("create_posts", args);
    const again = await call("create_posts", args);
    expect(again.text).toMatch(/^0 daripada 2 disimpan sebagai draf, 2 gagal/);
    expect(Object.keys((await store.load()).queue)).toHaveLength(2);
  });
  it("accepts up to 50 in one call and refuses 51; carousels up to 20 pictures", async () => {
    const r = await call("create_posts", { mode: "draft", posts: Array.from({ length: 50 }, (_, i) => nth(i + 100)) });
    expect(r.text).toMatch(/^50 daripada 50/);
    expect((await call("create_posts", { mode: "draft", posts: Array.from({ length: 51 }, (_, i) => nth(i + 200)) })).err).toBe(true);
    await store.update((s) => { for (let i = 0; i < 20; i++) s.photos[`ph_${i}`] = { id: `ph_${i}`, url: `https://abc123.public.blob.vercel-storage.com/p${i}.jpg`, name: `p${i}.jpg`, mime: "image/jpeg", size: 1000, uploadedAt: "2026-11-24T00:00:00.000Z" }; });
    const ids = Array.from({ length: 20 }, (_, i) => `ph_${i}`);
    expect((await call("create_post", { text: "Carousel dua puluh", mode: "draft", photo_ids: ids })).err).toBe(false);
    expect(Object.values((await store.load()).queue).find((q) => q.parts[0] === "Carousel dua puluh")!.mediaUrls).toHaveLength(20);
  });
  it("still keeps the 250-a-day brake inside a bulk call", async () => {
    await store.update((s) => { s.publishLog["2026-12-01"] = 249; });
    const r = await call("create_posts", { mode: "schedule", posts: [0, 1, 2].map((i) => ({ ...nth(i + 300), scheduled_for: `2026-12-01T0${8 + i}:00` })) });
    expect(r.text).toMatch(/^1 daripada 3 dijadualkan, 2 gagal/);
    expect(parse(r.text)[1].error).toMatch(/Had 250/);
  });
  it("show_recommendations shows 20 or 50 cards, in any shape, with no angle and no 'why'", async () => {
    const shapes = [
      { text: "Satu baris sahaja" },
      { text: "Thread bermula", parts: ["Bahagian dua", "Bahagian tiga"] },
      { text: "- satu\n- dua\n- tiga" },
      { text: "English only post", angle: "anything I like" },
    ];
    const recs = Array.from({ length: 20 }, (_, i) => ({ ...shapes[i % 4], text: `${shapes[i % 4].text} ${i}` }));
    const r = await call("show_recommendations", { recs });
    expect(r.err).toBe(false);
    expect(r.sc.recs).toHaveLength(20);
    expect(r.sc.recs[0]).toMatchObject({ angle: "", why: "" });
    expect(r.sc.recs[1].parts).toEqual(["Bahagian dua", "Bahagian tiga"]);
    expect(r.sc.recs[3].angle).toBe("anything I like");
    expect(r.text).toMatch(/^20 post dipaparkan/);
    expect((await call("show_recommendations", { recs: Array.from({ length: 50 }, (_, i) => ({ text: `Post ${i}` })) })).err).toBe(false);
    expect((await call("show_recommendations", { recs: Array.from({ length: 51 }, (_, i) => ({ text: `Post ${i}` })) })).err).toBe(true);
  });
  it("the standing rules tell Claude it is not limited, and no longer dictate counts, angles or tone", async () => {
    const rules = client.getInstructions() ?? "";
    expect(rules).toMatch(/nothing here limits you/);
    expect(rules).toMatch(/20 or 50 if the owner says so/);
    expect(rules).toContain("create_posts");
    expect(rules).not.toMatch(/4-6|English only when the owner asks|Default language is casual Malay/);
    const { tools } = await client.listTools();
    const d = (n: string) => tools.find((t) => t.name === n)!.description ?? "";
    expect(d("create_posts")).toMatch(/up to 50/);
    expect(d("show_recommendations")).not.toMatch(/4-6|different angles/);
    expect(d("studio_brief")).toMatch(/never rules/);
  });
  it("the playbook is only the owner's own notes: general business service, nothing about one trade, no banned words by default", async () => {
    const pb = JSON.parse((await call("studio_brief")).text).playbook;
    const all = JSON.stringify(pb).toLowerCase();
    for (const w of ["paip", "plumb", "tukang", "roofing", "servis rumah", "bumbung"]) expect(all).not.toContain(w);
    expect(pb.banned_words).toEqual([]);
    expect(pb.voice.join(" ")).not.toMatch(/Maksimum|Hook di baris|Satu post, satu angle|Lima cadangan/);
  });
});

describe("remove_posts: delete many drafts or scheduled posts in one call", () => {
  const ids = async () => JSON.parse((await call("list_scheduled")).text).map((r: any) => r.id as string);

  it("deletes 20 drafts at once, and reports what it did", async () => {
    await call("create_posts", { mode: "draft", posts: Array.from({ length: 20 }, (_, i) => ({ text: `Draf padam ${i} unik ${i * 3}` })) });
    const all = await ids();
    expect(all).toHaveLength(20);
    const r = await call("remove_posts", { post_ids: all });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/^20 daripada 20 dibuang\./);
    expect(await ids()).toHaveLength(0);
  });
  it("only removes what it was given, and skips unknown, duplicate, publishing and live ones", async () => {
    await call("create_posts", { mode: "draft", posts: [{ text: "Kekal satu" }, { text: "Buang dua" }, { text: "Sedang dipost tiga" }] });
    const rows = JSON.parse((await call("list_scheduled")).text) as { id: string; hook: string }[];
    const id = (h: string) => rows.find((r) => r.hook === h)!.id;
    await store.update((s) => { s.queue[id("Sedang dipost tiga")].status = "publishing"; });
    await store.update((s) => { s.queue.q_live = { id: "q_live", status: "published", parts: ["Dah live"], hook: "Dah live", createdAt: "2026-11-24T00:00:00.000Z", attempts: 0, threadsId: "t_77" }; });
    const r = await call("remove_posts", { post_ids: [id("Buang dua"), id("Buang dua"), "q_nope", id("Sedang dipost tiga"), "q_live"] });
    expect(r.text).toMatch(/^1 daripada 4 dibuang, 3 dilangkau/);
    const out = JSON.parse(r.text.slice(r.text.indexOf("[{")));
    expect(out.map((x: any) => x.ok)).toEqual([true, false, false, false]);
    expect(out[1].error).toMatch(/tak dijumpai/);
    expect(out[2].error).toMatch(/sedang dipost/);
    expect(out[3].error).toMatch(/sudah live/);
    const q = (await store.load()).queue;
    expect(Object.keys(q).sort()).toEqual([id("Kekal satu"), id("Sedang dipost tiga"), "q_live"].sort());
    expect(fake.calls("DELETE", /./)).toHaveLength(0); // nothing was deleted on Threads
  });
  it("accepts 100 ids and refuses 101 or none", async () => {
    expect((await call("remove_posts", { post_ids: Array.from({ length: 100 }, (_, i) => `q_x${i}`) })).text).toMatch(/^0 daripada 100 dibuang, 100 dilangkau/);
    expect((await call("remove_posts", { post_ids: Array.from({ length: 101 }, (_, i) => `q_x${i}`) })).err).toBe(true);
    expect((await call("remove_posts", { post_ids: [] })).err).toBe(true);
  });
  it("is a delete tool: marked destructive, and the rules say to get one clear yes first", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "remove_posts")!;
    expect((t.annotations as any).destructiveHint).toBe(true);
    expect(t.description).toMatch(/clear yes/);
    expect(client.getInstructions()).toMatch(/remove_posts after one clear yes/);
  });
});
