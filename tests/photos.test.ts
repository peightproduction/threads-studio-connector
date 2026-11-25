// The photo bank and the delete paths, through the real MCP protocol with fake Meta and a fake Blob store.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeThreads } from "./fake-threads.js";

process.env.ALLOW_MEMORY_STATE = "1";
process.env.VERCEL = "1";
process.env.PUBLIC_URL = "https://studio.test";
process.env.BLOB_READ_WRITE_TOKEN = "blob_test";

vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (path: string) => ({ url: `https://abc123.public.blob.vercel-storage.com/${path}`, pathname: path })),
  del: vi.fn(async () => {}),
}));
import { del as blobDel, put as blobPut } from "@vercel/blob";

const NOW = "2026-11-24T10:00:00Z";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);

const fake = createFakeThreads();
let client: Client;
let store: typeof import("../src/store.js");
let posts: typeof import("../src/posts.js");

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: (r.content?.[0]?.text as string) ?? "", err: Boolean(r.isError), sc: r.structuredContent as any };
};
const savePic = (buf: Buffer, name = "foto.jpg") => call("photo_save", { name, data_base64: buf.toString("base64") });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", fake.fetch);
  store = await import("../src/store.js");
  posts = await import("../src/posts.js");
  const { buildServer } = await import("../src/tools.js");
  const server = buildServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

beforeEach(async () => {
  vi.setSystemTime(new Date(NOW));
  fake.reset();
  fake.addPost("t_z1", "Post terbaru semalam", "2026-11-23T04:00:00Z", { views: 100 });
  await store.save({ ...store.emptyState(), threads: { token: "tok", expiresAt: "2027-01-30T00:00:00.000Z", refreshedAt: "2026-11-23T00:00:00.000Z", userId: "u1", username: "demo_user" } });
  posts.invalidate();
  fake.state.calls = [];
  vi.mocked(blobPut).mockClear();
  vi.mocked(blobDel).mockClear();
});

describe("photo bank: pictures for Threads posts (Meta needs a public address)", () => {
  it("photo_save is for the widget only; the rest are visible to Claude", async () => {
    const { tools } = await client.listTools();
    expect((tools.find((x) => x.name === "photo_save") as any)._meta.ui.visibility).toEqual(["app"]);
    for (const n of ["list_photos", "photo_upload_link", "describe_photo", "remove_photo"]) expect(tools.map((x) => x.name)).toContain(n);
  });
  it("the widget resource allows pictures from the Blob domain", async () => {
    for (const uri of ["ui://studio/threads-v9.html", "ui://studio/threads-v8.html", "ui://studio/threads-v7.html", "ui://studio/threads-v6.html", "ui://studio/threads-v5.html", "ui://studio/threads-v4.html", "ui://studio/threads.html"]) {
      const res: any = await client.readResource({ uri });
      expect(res.contents[0]._meta.ui.csp.resourceDomains).toContain("https://*.public.blob.vercel-storage.com");
    }
  });
  it("saves a JPEG and a PNG to storage, and lists them newest first", async () => {
    const a = await savePic(JPEG, "Kedai Satu 1.jpg");
    expect(a.err).toBe(false);
    expect(a.sc.kind).toBe("photos");
    expect(a.sc.photos[0]).toMatchObject({ name: "Kedai-Satu-1.jpg", size: JPEG.length });
    expect(a.sc.photos[0].url).toMatch(/^https:\/\/abc123\.public\.blob\.vercel-storage\.com\/photos\/ph_/);
    expect(vi.mocked(blobPut)).toHaveBeenLastCalledWith(expect.stringMatching(/^photos\/ph_/), expect.any(Buffer), expect.objectContaining({ access: "public", contentType: "image/jpeg" }));
    vi.setSystemTime(new Date("2026-11-24T10:05:00Z"));
    const b = await savePic(PNG, "logo.png");
    expect(b.sc.photos.map((p: any) => p.name)).toEqual(["logo.png", "Kedai-Satu-1.jpg"]);
    const l = await call("list_photos");
    expect(l.sc).toMatchObject({ kind: "photos", ready: true });
    expect(l.sc.photos).toHaveLength(2);
  });
  it("rejects anything that is not really a JPEG or PNG, and anything over 8 MB", async () => {
    expect((await savePic(Buffer.from("<html>not an image</html>"), "evil.jpg")).text).toMatch(/JPEG atau PNG/);
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9 * 1024 * 1024)]);
    expect((await savePic(huge)).err).toBe(true); // stopped at the tool's own input limit
    const { savePhoto } = await import("../src/photos.js");
    await expect(savePhoto(huge, "huge.jpg")).rejects.toThrow(/terlalu besar/); // and again by the 8 MB rule behind it
    expect((await call("list_photos")).sc.photos).toHaveLength(0);
    expect(vi.mocked(blobPut)).not.toHaveBeenCalled();
  });
  it("is not usable without Blob storage, and tells the owner what to set up", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    try {
      expect((await savePic(JPEG)).text).toMatch(/Vercel Blob/);
      expect((await call("photo_upload_link")).err).toBe(true);
      expect((await call("list_photos")).sc.ready).toBe(false);
    } finally { process.env.BLOB_READ_WRITE_TOKEN = "blob_test"; }
  });
  it("photo_upload_link gives a one-time page valid for 30 minutes (chat attachments cannot be forwarded)", async () => {
    const j = JSON.parse((await call("photo_upload_link")).text);
    expect(j.upload_link).toMatch(/^https:\/\/studio\.test\/upload\/u_[0-9a-f]{36}$/);
    expect(j.note).toMatch(/dilampirkan/);
    const n = j.upload_link.split("/").pop();
    expect(Date.parse((await store.load()).nonces[n]) - Date.now()).toBe(30 * 60_000);
  });
  it("attaches a bank picture to a published post as an IMAGE with the public address", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    const r = await call("create_post", { text: "Ada gambar", topic: "Business", mode: "publish", confirm_publish: true, photo_ids: [ph.id] });
    expect(r.err).toBe(false);
    expect(fake.calls("POST", "/me/threads")[0].params).toMatchObject({ media_type: "IMAGE", image_url: ph.url, text: "Ada gambar", topic_tag: "Business" });
  });
  it("several pictures become a carousel", async () => {
    const a = (await savePic(JPEG, "a.jpg")).sc.photos[0];
    vi.setSystemTime(new Date("2026-11-24T10:01:00Z"));
    const b = (await savePic(PNG, "b.png")).sc.photos[0];
    expect((await call("create_post", { text: "Dua gambar", mode: "publish", confirm_publish: true, photo_ids: [a.id, b.id] })).err).toBe(false);
    const cs = fake.calls("POST", "/me/threads");
    expect(cs.filter((c) => c.params.is_carousel_item === "true")).toHaveLength(2);
    expect(cs.find((c) => c.params.media_type === "CAROUSEL")!.params.text).toBe("Dua gambar");
  });
  it("keeps the picture addresses on a draft, and an unknown picture id is an error, not skipped", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    expect((await call("create_post", { text: "Draf bergambar", mode: "draft", photo_ids: [ph.id] })).err).toBe(false);
    expect(Object.values((await store.load()).queue)[0].mediaUrls).toEqual([ph.url]);
    const bad = await call("create_post", { text: "Gambar hantu", mode: "draft", photo_ids: ["ph_nope"] });
    expect(bad.err).toBe(true);
    expect(bad.text).toMatch(/tak ada dalam bank/);
  });
  it("show_recommendations preselects only pictures that exist, and carries the bank to the cards", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    const r = await call("show_recommendations", { recs: [{ angle: "cerita", text: "Satu", why: "x", photo_ids: [ph.id, "ph_ghost"] }] });
    expect(r.sc.recs[0].photoIds).toEqual([ph.id]);
    expect(r.sc.photos).toHaveLength(1);
  });
  it("describe_photo stores a caption Claude can read later", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    expect((await call("describe_photo", { photo_id: ph.id, desc: "Saya di kedai pelanggan" })).err).toBe(false);
    expect((await call("list_photos")).text).toContain("Saya di kedai pelanggan");
    expect((await call("describe_photo", { photo_id: "ph_nope", desc: "x" })).err).toBe(true);
  });
});

describe("deleting", () => {
  it("deletes a picture from storage and the bank, but not while a draft or schedule still uses it", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    await call("create_post", { text: "Guna gambar", mode: "draft", photo_ids: [ph.id] });
    const used = await call("remove_photo", { photo_id: ph.id });
    expect(used.err).toBe(true);
    expect(used.text).toMatch(/dipakai oleh 1/);
    expect(vi.mocked(blobDel)).not.toHaveBeenCalled();
    const qid = Object.keys((await store.load()).queue)[0];
    expect((await call("remove_post", { post_id: qid })).err).toBe(false);
    const gone = await call("remove_photo", { photo_id: ph.id });
    expect(gone.err).toBe(false);
    expect(gone.sc.photos).toHaveLength(0);
    expect(vi.mocked(blobDel)).toHaveBeenCalledWith(ph.url);
    expect((await call("remove_photo", { photo_id: ph.id })).err).toBe(true);
  });
  it("still removes the bank entry if the file is already gone from storage", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    vi.mocked(blobDel).mockRejectedValueOnce(new Error("The requested blob does not exist"));
    expect((await call("remove_photo", { photo_id: ph.id })).err).toBe(false);
    expect((await call("list_photos")).sc.photos).toHaveLength(0);
  });
  it("keeps the bank entry and says so if storage refuses to delete", async () => {
    const ph = (await savePic(JPEG)).sc.photos[0];
    vi.mocked(blobDel).mockRejectedValueOnce(new Error("Service unavailable"));
    const r = await call("remove_photo", { photo_id: ph.id });
    expect(r.err).toBe(true);
    expect(r.text).toMatch(/Gagal padam fail/);
    expect((await call("list_photos")).sc.photos).toHaveLength(1);
  });
  it("the tracker lists drafts, scheduled and failed posts so each can be deleted from the card", async () => {
    await call("create_post", { text: "Satu draf", mode: "draft" });
    await call("create_post", { text: "Satu jadual", mode: "schedule", scheduled_for: "2026-11-24T21:00" });
    fake.state.publishFailures = 1;
    await call("create_post", { text: "Satu gagal", mode: "publish", confirm_publish: true });
    const t = await call("post_tracker");
    expect(t.sc.queue.map((q: any) => q.status).sort()).toEqual(["draft", "failed", "scheduled"]);
    expect(t.sc.queue.find((q: any) => q.status === "failed").error).toBeTruthy();
    for (const q of t.sc.queue) expect((await call("remove_post", { post_id: q.id })).err).toBe(false);
    expect((await call("post_tracker")).sc.queue).toHaveLength(0);
  });
  it("a live post is only removed from Threads with confirm_delete (the widget sends it after two taps)", async () => {
    const no = await call("remove_post", { post_id: "t_z1" });
    expect(no.err).toBe(true);
    expect(fake.calls("DELETE", "/t_z1")).toHaveLength(0);
    expect((await call("remove_post", { post_id: "t_z1", confirm_delete: true })).err).toBe(false);
    expect(fake.calls("DELETE", "/t_z1")).toHaveLength(1);
  });
});
