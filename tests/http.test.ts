// The HTTP layer: the secret path is the only credential for the connector, a second secret guards the scheduler,
// and Meta's connect / callback / deauthorize routes.
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeThreads } from "./fake-threads.js";

process.env.ALLOW_MEMORY_STATE = "1"; // tests treat the in-memory state as durable
process.env.VERCEL = "1"; // do not auto-listen; state in memory
process.env.MCP_TOKEN = "s".repeat(32);
process.env.TICK_TOKEN = "k".repeat(32);
process.env.THREADS_APP_ID = "app123";
process.env.THREADS_APP_SECRET = "secret456";
process.env.PUBLIC_URL = "https://studio.test";
process.env.BLOB_READ_WRITE_TOKEN = "blob_test";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (path: string) => ({ url: `https://abc123.public.blob.vercel-storage.com/${path}`, pathname: path })),
  del: vi.fn(async () => {}),
}));

const fake = createFakeThreads();
let base = "";
let close: () => void = () => {};
let store: typeof import("../src/store.js");

beforeAll(async () => {
  vi.stubGlobal("fetch", fake.fetch); // Meta calls are faked; localhost falls through to the real fetch
  store = await import("../src/store.js");
  const app = (await import("../server.js")).default;
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => { close(); vi.unstubAllGlobals(); });
beforeEach(async () => { fake.reset(); await store.save(store.emptyState()); });

const rpc = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
const nonce = async (n: string, ttlMs = 600_000) => { await store.update((s) => { s.nonces[n] = new Date(Date.now() + ttlMs).toISOString(); }); };
const signed = (obj: object, secret = "secret456") => {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
};
const form = (signed_request: string) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ signed_request }) });

describe("connector address", () => {
  it("answers on the right token and lists tools", async () => {
    const r = await rpc(`/mcp/${"s".repeat(32)}`, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.result.tools.length).toBeGreaterThan(10);
  });
  it("returns 404 for a wrong token and for no token", async () => {
    expect((await rpc(`/mcp/${"x".repeat(32)}`, {})).status).toBe(404);
    expect((await fetch(base + "/mcp")).status).toBe(404);
  });
  it("does not accept GET on the connector path", async () => {
    expect((await fetch(`${base}/mcp/${"s".repeat(32)}`)).status).toBe(405);
  });
  it("health check reveals nothing", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("threads-studio: ok");
  });
});

describe("setup page", () => {
  it("shows the exact Meta addresses and a checklist, and never a secret value", async () => {
    const r = await fetch(base + "/setup");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("https://studio.test/oauth/callback");
    expect(html).toContain("https://studio.test/oauth/deauthorize");
    expect(html).toContain("https://studio.test/oauth/delete");
    expect(html).toContain("https://studio.test/mcp/&lt;MCP_TOKEN awak&gt;");
    for (const secret of ["s".repeat(32), "k".repeat(32), "secret456", "blob_test", "long-token"]) expect(html).not.toContain(secret);
  });
  it("says what is still missing: not connected, no timer, then connected and timer running", async () => {
    let html = await (await fetch(base + "/setup")).text();
    expect(html).toContain("✘</b> Threads disambung");
    expect(html).toContain("○</b> Pemasa berjalan");
    expect(html).toContain("Langkah seterusnya: Dalam Claude, tulis: sambung Threads");
    await store.update((s) => { s.threads = { token: "tok", expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), refreshedAt: new Date().toISOString() }; s.lastPingAt = new Date().toISOString(); });
    html = await (await fetch(base + "/setup")).text();
    expect(html).toContain("✔</b> Threads disambung");
    expect(html).toContain("✔</b> Pemasa berjalan");
    expect(html).toContain("Semua yang wajib dah siap.");
    expect(html).not.toContain("tok</");
  });
  it("flags a missing Redis as the next step", async () => {
    process.env.ALLOW_MEMORY_STATE = "0";
    try {
      const html = await (await fetch(base + "/setup")).text();
      expect(html).toContain("✘</b> Redis disambung");
      expect(html).toContain("Langkah seterusnya: Vercel &gt; projek awak &gt; Storage");
    } finally { process.env.ALLOW_MEMORY_STATE = "1"; }
  });
});

describe("scheduler endpoint", () => {
  it("404 for a wrong token (also not the MCP token), JSON for the right one, and remembers the ping", async () => {
    expect((await fetch(`${base}/tick/${"x".repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${base}/tick/${"s".repeat(32)}`)).status).toBe(404); // the MCP token must not work here
    const r = await fetch(`${base}/tick/${"k".repeat(32)}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ due: 0, published: 0, failed: 0 });
    expect(Date.now() - Date.parse((await store.load()).lastPingAt!)).toBeLessThan(10_000);
    expect((await fetch(`${base}/tick/${"k".repeat(32)}`, { method: "POST" })).status).toBe(200); // a pinger may use POST
  });
  it("publishes a due post", async () => {
    await store.update((s) => {
      s.threads = { token: "tok", expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), refreshedAt: new Date().toISOString() };
      s.queue.q_due = { id: "q_due", status: "scheduled", parts: ["Waktunya tiba"], hook: "Waktunya tiba", createdAt: new Date().toISOString(), scheduledFor: new Date(Date.now() - 60_000).toISOString(), attempts: 0 };
    });
    const r: any = await (await fetch(`${base}/tick/${"k".repeat(32)}`)).json();
    expect(r).toMatchObject({ due: 1, published: 1 });
    expect(fake.calls("POST", "/me/threads_publish")).toHaveLength(1);
    expect((await store.load()).queue.q_due.status).toBe("published");
  });
});

describe("picture upload page", () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
  const send = (n: string, body: Buffer | string, type = "image/jpeg", name = "foto.jpg") => fetch(`${base}/upload/${n}/file?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: body as any });

  it("serves the page for a live upload link only", async () => {
    await nonce("u_good");
    const ok = await fetch(`${base}/upload/u_good`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Muat naik gambar");
    expect(html).toContain("/upload/");
    expect((await fetch(`${base}/upload/u_unknown`)).status).toBe(400);
    await nonce("u_old", -1000);
    expect((await fetch(`${base}/upload/u_old`)).status).toBe(400);
    await nonce("n_connect"); // a connect-Threads link must not open the upload page
    expect((await fetch(`${base}/upload/n_connect`)).status).toBe(400);
  });
  it("stores an uploaded picture in the bank and allows several uploads on one link", async () => {
    await nonce("u_multi");
    const a = await send("u_multi", JPEG, "image/jpeg", "Satu Dua.jpg");
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ name: "Satu-Dua.jpg" });
    expect((await send("u_multi", JPEG)).status).toBe(200);
    expect(Object.keys((await store.load()).photos)).toHaveLength(2);
  });
  it("refuses a wrong or expired link, fake images, empty files and other content types", async () => {
    expect((await send("u_nope", JPEG)).status).toBe(404);
    await nonce("u_old2", -1000);
    expect((await send("u_old2", JPEG)).status).toBe(404);
    await nonce("u_chk");
    const fakeImg = await send("u_chk", "<html>hello</html>");
    expect(fakeImg.status).toBe(400);
    expect((await fakeImg.json() as any).error).toMatch(/JPEG atau PNG/);
    expect((await send("u_chk", Buffer.alloc(0))).status).toBe(400);
    expect((await send("u_chk", JPEG, "text/html")).status).toBe(400);
    expect(Object.keys((await store.load()).photos)).toHaveLength(0);
  });
  it("refuses a body over the 4.5 MB request limit", async () => {
    await nonce("u_big");
    expect((await send("u_big", Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]))).status).toBe(413);
  });
  it("says Blob is missing instead of failing silently", async () => {
    await nonce("u_noblob");
    delete process.env.BLOB_READ_WRITE_TOKEN;
    try {
      const r = await send("u_noblob", JPEG);
      expect(r.status).toBe(400);
      expect((await r.json() as any).error).toMatch(/Vercel Blob/);
    } finally { process.env.BLOB_READ_WRITE_TOKEN = "blob_test"; }
  });
});

describe("connecting Threads through Meta", () => {
  it("redirects a valid one-time link to Meta's authorize page", async () => {
    await nonce("n1");
    const r = await fetch(`${base}/connect/n1`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://threads.net/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("app123");
    expect(loc.searchParams.get("state")).toBe("n1");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://studio.test/oauth/callback");
    expect(loc.searchParams.get("scope")).toBe("threads_basic,threads_content_publish,threads_manage_insights,threads_delete,threads_read_replies,threads_manage_replies");
  });
  it("rejects unknown and expired links", async () => {
    expect((await fetch(`${base}/connect/nope`, { redirect: "manual" })).status).toBe(400);
    await nonce("old", -1000);
    expect((await fetch(`${base}/connect/old`, { redirect: "manual" })).status).toBe(400);
  });
  it("finishes the connection once, and a replayed callback does nothing", async () => {
    await nonce("n2");
    const ok = await fetch(`${base}/oauth/callback?code=goodcode&state=n2`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("@demo_user");
    const t = (await store.load()).threads!;
    expect(t.token).toBe("long-token");
    expect(t.username).toBe("demo_user");
    await store.update((s) => { delete s.threads; });
    const again = await fetch(`${base}/oauth/callback?code=goodcode&state=n2`);
    expect(again.status).toBe(400);
    expect((await store.load()).threads).toBeUndefined();
  });
  it("refuses a callback with an unknown state, a missing code, or an error from Meta", async () => {
    expect((await fetch(`${base}/oauth/callback?code=x&state=unknown`)).status).toBe(400);
    await nonce("n3");
    expect((await fetch(`${base}/oauth/callback?state=n3`)).status).toBe(400);
    const denied = await fetch(`${base}/oauth/callback?error=access_denied&error_description=${encodeURIComponent("Pengguna menolak")}`);
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("Pengguna menolak");
    expect((await store.load()).threads).toBeUndefined();
  });
  it("refuses to connect when the state would be forgotten (no Redis on Vercel)", async () => {
    await nonce("n5");
    process.env.ALLOW_MEMORY_STATE = "0";
    try {
      const r = await fetch(`${base}/oauth/callback?code=goodcode&state=n5`);
      expect(r.status).toBe(500);
      expect(await r.text()).toContain("Redis");
    } finally { process.env.ALLOW_MEMORY_STATE = "1"; }
    expect((await store.load()).threads).toBeUndefined();
    expect((await store.load()).nonces.n5).toBeTruthy(); // not spent: the link still works once Redis is there
  });
  it("shows Meta's reason when the code exchange fails", async () => {
    await nonce("n4");
    const r = await fetch(`${base}/oauth/callback?code=bad&state=n4`);
    expect(r.status).toBe(500);
    expect(await r.text()).toContain("Invalid code");
    expect((await store.load()).threads).toBeUndefined();
  });
  it("deauthorize and data-deletion callbacks need a valid signature", async () => {
    await store.update((s) => { s.threads = { token: "t", expiresAt: new Date(Date.now() + 1e9).toISOString(), refreshedAt: new Date().toISOString() }; s.metricsCache = { a: { at: "x", m: {} } }; });
    expect((await fetch(`${base}/oauth/deauthorize`, form(signed({ user_id: "u1" }, "wrong-secret")))).status).toBe(400);
    expect((await store.load()).threads).toBeTruthy();
    expect((await fetch(`${base}/oauth/deauthorize`, form(signed({ user_id: "u1" })))).status).toBe(200);
    expect((await store.load()).threads).toBeUndefined();

    await store.update((s) => { s.threads = { token: "t", expiresAt: new Date(Date.now() + 1e9).toISOString(), refreshedAt: new Date().toISOString() }; });
    const d = await fetch(`${base}/oauth/delete`, form(signed({ user_id: "u1" })));
    expect(d.status).toBe(200);
    expect(await d.json()).toMatchObject({ confirmation_code: "deleted" });
    const s = await store.load();
    expect(s.threads).toBeUndefined();
    expect(s.metricsCache).toEqual({});
  });
});
