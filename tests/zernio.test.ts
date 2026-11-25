// End to end through the real MCP protocol (in memory) with a fake Zernio behind a stubbed fetch. Meta is NOT configured here:
// everything must work from ZERNIO_API_KEY alone.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeZernio, KEY } from "./fake-zernio.js";

process.env.ALLOW_MEMORY_STATE = "1";
process.env.VERCEL = "1";
process.env.PUBLIC_URL = "https://studio.test";
delete process.env.THREADS_APP_ID;
delete process.env.THREADS_APP_SECRET;

const NOW = "2026-11-24T10:00:00Z"; // Tue 18:00 MYT
const fake = createFakeZernio();
let client: Client;
let store: typeof import("../src/store.js");
let posts: typeof import("../src/posts.js");
let scheduler: typeof import("../src/scheduler.js");
let threads: typeof import("../src/threads.js");
let base = "";
let closeApp = () => {};

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: (r.content?.[0]?.text as string) ?? "", err: Boolean(r.isError), sc: r.structuredContent as any };
};
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const connectedState = () => ({
  ...store.emptyState(),
  threads: { token: "zernio", expiresAt: "2036-11-24T00:00:00.000Z", refreshedAt: NOW, userId: "acc_1", username: "demo_user" },
});

beforeAll(async () => {
  process.env.ZERNIO_API_KEY = KEY;
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
  const app = (await import("../server.js")).default;
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  closeApp = () => srv.close();
});
afterAll(() => { closeApp(); vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.ZERNIO_API_KEY; });

beforeEach(async () => {
  at(NOW);
  fake.reset();
  fake.addPost("zp_a", "Post terbaru semalam", "2026-11-23T04:00:00Z", { views: 100, likes: 3, comments: 1 });
  fake.addPost("zp_b", "Post kedua", "2026-11-12T04:00:00Z", { views: 90, likes: 2 });
  fake.state.seq = 10;
  await store.save(connectedState());
  posts.invalidate();
  fake.state.calls = [];
});

describe("connecting through Zernio", () => {
  it("links the only Threads account in Zernio, without any Meta link", async () => {
    await store.save(store.emptyState());
    const r = await call("connect_threads");
    expect(r.err).toBe(false);
    const info = JSON.parse(r.text);
    expect(info).toMatchObject({ connected: true, username: "demo_user" });
    expect(info.connect_link).toBeUndefined();
    expect((await store.load()).threads).toMatchObject({ userId: "acc_1", username: "demo_user", token: "zernio" });
    expect(JSON.stringify(await store.load())).not.toContain(KEY); // the key lives in Vercel, never in the saved state
  });
  it("says what to do when Zernio has no Threads account yet", async () => {
    await store.save(store.emptyState());
    fake.state.accounts = [];
    const r = await call("connect_threads");
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Connections/);
    expect(r.text).toMatch(/Business atau Creator/);
  });
  it("asks which account when there are two, then takes the one named", async () => {
    await store.save(store.emptyState());
    fake.state.accounts.push({ _id: "acc_2", platform: "threads", username: "kedai_kek", isActive: true });
    const ask = await call("connect_threads");
    expect(ask.err).toBe(true);
    expect(ask.text).toMatch(/@demo_user, @kedai_kek/);
    const pick = await call("connect_threads", { username: "@kedai_kek" });
    expect(pick.err).toBe(false);
    expect((await store.load()).threads?.userId).toBe("acc_2");
  });
  it("reports a rejected key plainly", async () => {
    fake.state.rejectKey = true;
    const r = await call("connect_threads", { reconnect: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Kunci API Zernio/);
  });
});

describe("publishing through Zernio", () => {
  it("posts now with the key, the account, the topic and publishNow", async () => {
    const r = await call("create_post", { text: "Live sekarang", topic: "Business", mode: "publish", confirm_publish: true });
    expect(r.err).toBe(false);
    expect(r.text).toMatch(/Dah post/);
    expect(r.text).toContain("threads.com");
    const c = fake.calls("POST", "/posts");
    expect(c).toHaveLength(1);
    expect(c[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(c[0].body).toMatchObject({ content: "Live sekarang", publishNow: true, platforms: [{ platform: "threads", accountId: "acc_1", platformSpecificData: { topic_tag: "Business" } }] });
  });
  it("sends thread parts as threadItems, first part first", async () => {
    const r = await call("create_post", { text: "Satu", parts: ["Dua", "Tiga"], mode: "publish", confirm_publish: true });
    expect(r.err).toBe(false);
    const body = fake.calls("POST", "/posts")[0].body;
    expect(body.platforms[0].platformSpecificData.threadItems).toEqual([{ content: "Satu" }, { content: "Dua" }, { content: "Tiga" }]);
  });
  it("sends pictures as mediaItems (on the first part of a thread)", async () => {
    const token = await threads.accessToken();
    await threads.publish(token, ["Satu"], { mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"] });
    expect(fake.calls("POST", "/posts")[0].body.mediaItems).toEqual([{ type: "image", url: "https://x.test/a.png" }, { type: "image", url: "https://x.test/b.png" }]);
    await threads.publish(token, ["Satu", "Dua"], { mediaUrls: ["https://x.test/a.png"] });
    expect(fake.calls("POST", "/posts")[1].body.platforms[0].platformSpecificData.threadItems[0]).toEqual({ content: "Satu", mediaItems: [{ type: "image", url: "https://x.test/a.png" }] });
  });
  it("does not need Meta settings at all", async () => {
    expect(threads.zernio()).toBe(true);
    expect(threads.appConfigured()).toBe(true);
    expect(await threads.connected()).toBe(true);
  });
  it("waits for Zernio while it is still publishing", async () => {
    vi.useRealTimers(); // the poll uses a real 2 s sleep
    fake.state.postMode = "publishing";
    try {
      const r = await call("create_post", { text: "Perlahan sikit", mode: "publish", confirm_publish: true });
      expect(r.err).toBe(false);
      expect(r.text).toContain("threads.com");
      expect(fake.calls("GET", /^\/posts\/zp_/).length).toBeGreaterThanOrEqual(1);
    } finally { vi.useFakeTimers({ toFake: ["Date"] }); at(NOW); }
  }, 20_000);
  it("shows Zernio's own reason when it says failed", async () => {
    fake.state.postMode = "failed";
    const r = await call("create_post", { text: "Akan gagal", mode: "publish", confirm_publish: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Instagram account is restricted/);
  });
  it("explains a disconnected account and a duplicate", async () => {
    fake.state.postMode = "disconnected";
    expect((await call("create_post", { text: "A", mode: "publish", confirm_publish: true })).text).toMatch(/terputus/);
    fake.state.postMode = "duplicate";
    expect((await call("create_post", { text: "A", mode: "publish", confirm_publish: true })).text).toMatch(/sama/);
  });
});

describe("scheduled posts through Zernio", () => {
  const sched = (text = "Jadual malam", when = "2026-11-24T19:30") => call("create_post", { text, mode: "schedule", scheduled_for: when });
  it("goes out at its time, exactly once, with the queue id as idempotency key", async () => {
    expect((await sched()).err).toBe(false);
    const item = Object.values((await store.load()).queue)[0];
    expect(fake.calls("POST", "/posts")).toHaveLength(0);
    at("2026-11-24T11:31:00Z");
    const t = await scheduler.tick();
    expect(t).toMatchObject({ due: 1, published: 1 });
    const c = fake.calls("POST", "/posts");
    expect(c).toHaveLength(1);
    expect(c[0].headers["idempotency-key"]).toBe(item.id);
    const done = Object.values((await store.load()).queue)[0];
    expect(done).toMatchObject({ status: "published", threadsId: "zp_11" });
    expect(done.url).toContain("threads.com");
    await scheduler.tick();
    expect(fake.calls("POST", "/posts")).toHaveLength(1);
  });
  it("never retries a post when Zernio's answer is lost (a server error): it is marked failed for a human to check", async () => {
    await sched();
    fake.state.postMode = "server";
    at("2026-11-24T11:31:00Z");
    await scheduler.tick();
    const q = Object.values((await store.load()).queue)[0];
    expect(q.status).toBe("failed");
    expect(q.error).toMatch(/Semak/);
    at("2026-11-24T13:00:00Z");
    await scheduler.tick();
    expect(fake.calls("POST", "/posts")).toHaveLength(1);
  });
  it("a post Zernio says failed is kept and tried again later", async () => {
    await sched();
    fake.state.postMode = "failed";
    at("2026-11-24T11:31:00Z");
    await scheduler.tick();
    const q = Object.values((await store.load()).queue)[0];
    expect(q).toMatchObject({ status: "scheduled", attempts: 1 });
    expect(q.error).toMatch(/restricted/);
    expect(q.nextAttemptAt).toBeTruthy();
  });
});

describe("reading through Zernio", () => {
  it("lists the published posts with their numbers", async () => {
    const { posts: list } = await posts.loadPosts({ force: true });
    const a = list.find((p) => p.id === "zp_a")!;
    expect(a).toMatchObject({ status: "published", text: "Post terbaru semalam", metricsKnown: true });
    expect(a.url).toContain("threads.com");
    expect(a.metrics).toMatchObject({ views: 100, likes: 3, replies: 1 });
  });
  it("keeps numbers unknown (never zero) when Zernio's analytics add-on is off", async () => {
    fake.state.analytics402 = true;
    const { posts: list, notes } = await posts.loadPosts({ force: true });
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((p) => p.metricsKnown === false)).toBe(true);
    expect(notes.join(" ")).toMatch(/add-on/);
  });
  it("shows the follower count when available", async () => {
    expect(await threads.followers(await threads.accessToken())).toBe(321);
    fake.state.followers = undefined;
    expect(await threads.followers(await threads.accessToken())).toBeUndefined();
  });
  it("get_replies shows who commented and what they said", async () => {
    fake.state.comments.zp_a = [{ id: "c1", message: "Betul tu!", from: { username: "ali" }, createdTime: "2026-11-23T05:00:00Z", url: "https://www.threads.com/@ali/post/C1", replyCount: 1, isHidden: false }];
    const r = await call("get_replies", { post: "zp_a" });
    expect(r.err).toBe(false);
    expect(r.text).toContain("Betul tu!");
    expect(r.text).toContain("ali");
    expect(fake.calls("GET", "/inbox/comments/zp_a")[0].query.accountId).toBe("acc_1");
  });
});

describe("deleting through Zernio", () => {
  it("removes a post Zernio will delete", async () => {
    fake.state.deleteLive = true;
    posts.invalidate();
    const r = await call("remove_post", { post_id: "zp_b", confirm_delete: true });
    expect(r.err).toBe(false);
    expect(fake.calls("DELETE", "/posts/zp_b")).toHaveLength(1);
  });
  it("says so when Zernio refuses a live post, and points to the Threads app", async () => {
    posts.invalidate();
    const r = await call("remove_post", { post_id: "zp_b", confirm_delete: true });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/app Threads/);
  });
});

describe("the setup page in Zernio mode", () => {
  it("asks for ZERNIO_API_KEY and no longer asks for Meta addresses", async () => {
    const html = (await (await fetch(base + "/setup")).text()).replace(/<!--[\s\S]*?-->/g, "");
    expect(html).toContain("ZERNIO_API_KEY");
    expect(html).not.toMatch(/THREADS_APP_ID/);
    expect(html).not.toMatch(/Redirect Callback URL/);
    expect(html).toContain("https://studio.test/mcp/");
    expect(html).not.toContain(KEY);
  });
});
