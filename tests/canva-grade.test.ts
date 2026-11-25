// Canva link in, colour grading, real pixels through sharp. Same set-up as photos.test.ts: real MCP protocol, fake Meta, fake Blob.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeThreads } from "./fake-threads.js";

process.env.ALLOW_MEMORY_STATE = "1";
process.env.VERCEL = "1";
process.env.PUBLIC_URL = "https://studio.test";
process.env.BLOB_READ_WRITE_TOKEN = "blob_test";

const blobFiles = vi.hoisted(() => new Map<string, Buffer>()); // what the fake Blob store holds, by public address
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (path: string, body: Buffer) => {
    const url = `https://abc123.public.blob.vercel-storage.com/${path}`;
    blobFiles.set(url, Buffer.from(body));
    return { url, pathname: path };
  }),
  del: vi.fn(async () => {}),
}));
import { del as blobDel, put as blobPut } from "@vercel/blob";
import { imageNet } from "../src/fetch-image.js";

const NOW = "2026-11-24T10:00:00Z";
const fake = createFakeThreads();
let client: Client;
let store: typeof import("../src/store.js");
let posts: typeof import("../src/posts.js");

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: (r.content?.[0]?.text as string) ?? "", err: Boolean(r.isError), sc: r.structuredContent as any };
};
const raw = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as any;
const savePic = (buf: Buffer, name = "foto.jpg") => call("photo_save", { name, data_base64: buf.toString("base64") });
const solid = (w: number, h: number, c: { r: number; g: number; b: number }) => sharp({ create: { width: w, height: h, channels: 3, background: c } });
const mean = async (buf: Buffer) => { const s = await sharp(buf).stats(); return { r: s.channels[0].mean, g: s.channels[1].mean, b: s.channels[2].mean }; };
const lum = (m: { r: number; g: number; b: number }) => (m.r + m.g + m.b) / 3;
const publicLink = (bytes: Buffer, type = "image/png") => { imageNet.lookup = async () => ["93.184.216.34"]; imageNet.fetch = async () => new Response(new Uint8Array(bytes), { headers: { "content-type": type } }); };
const lastBlob = () => [...blobFiles.values()].pop()!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", (input: any, init?: any) => {
    const file = blobFiles.get(String(input)); // our own public Blob files come from the fake store
    return file ? Promise.resolve(new Response(new Uint8Array(file), { headers: { "content-type": "image/jpeg" } })) : fake.fetch(input, init);
  });
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
  blobFiles.clear();
  vi.mocked(blobPut).mockClear();
  vi.mocked(blobDel).mockClear();
});

describe("photo_from_url: a Canva export (or any image link) into the bank", () => {
  it("saves a PNG from an https link and returns the id to attach it with", async () => {
    publicLink(await solid(120, 80, { r: 200, g: 50, b: 50 }).png().toBuffer());
    const r = await call("photo_from_url", { url: "https://export-download.canva.com/abc/Poster%20Promo.png?sig=1", desc: "Poster promo" });
    expect(r.err).toBe(false);
    expect(r.sc.kind).toBe("photos");
    const ph = r.sc.photos[0];
    expect(ph).toMatchObject({ name: "Poster-Promo.png", desc: "Poster promo" });
    expect(r.text).toContain(ph.id);
    expect((vi.mocked(blobPut).mock.calls[0] as any)[2]).toMatchObject({ contentType: "image/png", access: "public" });
    // the id works on a post right away
    expect((await call("create_post", { text: "Post dengan poster Canva", mode: "draft", photo_ids: [ph.id] })).err).toBe(false);
    expect(Object.values((await store.load()).queue)[0].mediaUrls).toEqual([ph.url]);
  });
  it("turns WebP into JPEG, since Threads only takes JPEG or PNG", async () => {
    publicLink(await solid(60, 60, { r: 10, g: 200, b: 10 }).webp().toBuffer(), "image/webp");
    const r = await call("photo_from_url", { url: "https://cdn.example.com/a.webp", name: "hijau" });
    expect(r.err).toBe(false);
    expect(r.sc.photos[0].name).toBe("hijau.jpg");
    expect((await store.load()).photos[r.sc.photos[0].id].mime).toBe("image/jpeg");
    expect(Buffer.from(lastBlob()).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true); // really JPEG bytes, not renamed WebP
  });
  it("shrinks a valid picture over the 8 MB limit instead of refusing it", async () => {
    const noise = await sharp(Buffer.from(Array.from({ length: 2400 * 2400 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 2400, height: 2400, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(noise.length).toBeGreaterThan(8 * 1024 * 1024 - 1);
    imageNet.lookup = async () => ["93.184.216.34"];
    imageNet.fetch = async () => new Response(noise, { headers: { "content-length": "1000" } }); // header lies; the stream is checked
    const r = await call("photo_from_url", { url: "https://cdn.example.com/huge.png" });
    expect(r.err).toBe(true); // over the download cap: refused up front, never half-saved
    expect(r.text).toMatch(/terlalu besar/);
    expect(vi.mocked(blobPut)).not.toHaveBeenCalled();
  });
  it("refuses links to private addresses, plain http, and files that are not pictures; saves nothing", async () => {
    imageNet.lookup = async () => ["93.184.216.34"];
    for (const url of ["http://example.com/a.png", "https://localhost/a.png", "https://169.254.169.254/x.png"]) expect((await call("photo_from_url", { url })).err).toBe(true);
    imageNet.fetch = async () => new Response("<html>ini bukan gambar</html>");
    const notImg = await call("photo_from_url", { url: "https://example.com/page" });
    expect(notImg.err).toBe(true);
    expect(notImg.text).toMatch(/PNG atau JPG/);
    expect(vi.mocked(blobPut)).not.toHaveBeenCalled();
    expect((await call("list_photos")).sc.photos).toHaveLength(0);
  });
});

describe("Canva edit link: a poster remembers its design so the owner can tweak it", () => {
  const DESIGN = "https://www.canva.com/design/DAGabc123XYZ/edit";
  it("keeps the edit link on the picture, shows it in the bank and in list_photos for Claude", async () => {
    publicLink(await solid(120, 80, { r: 200, g: 180, b: 40 }).png().toBuffer());
    const r = await call("photo_from_url", { url: "https://export-download.canva.com/abc/poster.png?sig=1", name: "poster", edit_url: DESIGN });
    expect(r.err).toBe(false);
    expect(r.sc.photos[0].editUrl).toBe(DESIGN);
    expect(r.text).toMatch(/Edit di Canva/);
    const id = r.sc.photos[0].id;
    expect((await store.load()).photos[id].editUrl).toBe(DESIGN);
    const l = await call("list_photos");
    expect(l.sc.photos[0].editUrl).toBe(DESIGN);
    expect(l.text).toContain(`[edit: ${DESIGN}]`);
  });
  it("a picture without a design link has none (nothing is invented)", async () => {
    publicLink(await solid(60, 60, { r: 1, g: 2, b: 3 }).png().toBuffer());
    const r = await call("photo_from_url", { url: "https://cdn.example.com/a.png" });
    expect(r.sc.photos[0].editUrl).toBeUndefined();
    expect(r.text).not.toMatch(/Edit di Canva/);
  });
  it("refuses a bad edit link BEFORE downloading or saving anything (javascript:, http:, user:pass@, data:)", async () => {
    publicLink(await solid(60, 60, { r: 1, g: 2, b: 3 }).png().toBuffer());
    const fetched = vi.fn(imageNet.fetch);
    imageNet.fetch = fetched as any;
    for (const edit_url of ["javascript:alert(1)", "http://www.canva.com/design/x/edit", "https://user:pass@www.canva.com/design/x/edit", "data:text/html;base64,PHNjcmlwdD4=", "bukan pautan"]) {
      const r = await call("photo_from_url", { url: "https://cdn.example.com/a.png", edit_url });
      expect(r.err, edit_url).toBe(true);
      expect(r.text).toMatch(/Pautan edit/);
    }
    expect(fetched).not.toHaveBeenCalled();
    expect(vi.mocked(blobPut)).not.toHaveBeenCalled();
    expect((await call("list_photos")).sc.photos).toHaveLength(0);
  });
  it("describe_photo can set, change and clear the link, and still edits only the caption when asked to", async () => {
    publicLink(await solid(60, 60, { r: 9, g: 9, b: 9 }).png().toBuffer());
    const id = (await call("photo_from_url", { url: "https://cdn.example.com/a.png" })).sc.photos[0].id;
    expect((await call("describe_photo", { photo_id: id, edit_url: DESIGN })).err).toBe(false);
    expect((await store.load()).photos[id].editUrl).toBe(DESIGN);
    expect((await call("describe_photo", { photo_id: id, desc: "Poster promo" })).err).toBe(false); // caption only: link kept
    expect((await store.load()).photos[id]).toMatchObject({ desc: "Poster promo", editUrl: DESIGN });
    expect((await call("describe_photo", { photo_id: id, edit_url: "http://x.test/a" })).err).toBe(true); // bad link: nothing changed
    expect((await store.load()).photos[id].editUrl).toBe(DESIGN);
    expect((await call("describe_photo", { photo_id: id, edit_url: "" })).err).toBe(false);
    expect((await store.load()).photos[id].editUrl).toBeUndefined();
    expect((await call("describe_photo", { photo_id: id })).err).toBe(true); // nothing to change
  });
  it("a picture uploaded by hand still works, with no link", async () => {
    const r = await savePic(await solid(50, 50, { r: 5, g: 5, b: 5 }).jpeg().toBuffer());
    expect(r.err).toBe(false);
    expect(r.sc.photos[0].editUrl).toBeUndefined();
  });
});

describe("Tracker > Ubah: a draft or scheduled post opens as an editable card, is changed in place and can be scheduled", () => {
  const EXTRA = "https://cdn.example.com/dari-luar.jpg";
  const mk = async () => {
    publicLink(await solid(80, 60, { r: 30, g: 120, b: 200 }).png().toBuffer());
    const id = (await call("photo_from_url", { url: "https://export-download.canva.com/abc/p.png", name: "poster", edit_url: "https://www.canva.com/design/DAGabc123XYZ/edit" })).sc.photos[0].id;
    const made = await call("create_post", { text: "Draf asal yang aku nak ubah", parts: ["Sambungan satu"], topic: "Business", mode: "draft", photo_ids: [id] });
    expect(made.err).toBe(false);
    const qid = Object.keys((await store.load()).queue)[0];
    expect((await call("edit_post", { post_id: qid, photo_ids: [id], media_urls: [EXTRA] })).err).toBe(false); // one picture from the bank, one from outside
    return { id, qid };
  };
  it("is for the widget only (hidden from Claude's tool list)", async () => {
    const t: any = (await client.listTools()).tools.find((x) => x.name === "queue_item");
    expect(t._meta.ui.visibility).toEqual(["app"]);
  });
  it("opens a draft with its text, thread part, topic, bank picture and outside picture", async () => {
    const { id, qid } = await mk();
    const r = await call("queue_item", { post_id: qid });
    expect(r.err).toBe(false);
    expect(r.sc.kind).toBe("recs");
    const c = r.sc.recs[0];
    expect(c).toMatchObject({ queueId: qid, status: "draft", text: "Draf asal yang aku nak ubah", parts: ["Sambungan satu"], topic: "Business", photoIds: [id], extraMedia: [EXTRA] });
    expect(r.sc.photos.find((p: any) => p.id === id).editUrl).toContain("canva.com/design/DAGabc123XYZ");
  });
  it("opens a scheduled post with its time", async () => {
    const { qid } = await mk();
    expect((await call("reschedule_post", { post_id: qid, scheduled_for: "2026-11-25T20:00" })).err).toBe(false);
    const c = (await call("queue_item", { post_id: qid })).sc.recs[0];
    expect(c.status).toBe("scheduled");
    expect(c.scheduledFor).toBe("2026-11-25T12:00:00.000Z");
  });
  it("refuses a post that is gone, being posted, or already live", async () => {
    expect((await call("queue_item", { post_id: "q_tiada" })).err).toBe(true);
    const { qid } = await mk();
    await store.update((st) => { st.queue[qid].status = "publishing"; });
    expect((await call("queue_item", { post_id: qid })).text).toMatch(/sedang dipost/);
    await store.update((st) => { st.queue[qid].status = "published"; });
    expect((await call("queue_item", { post_id: qid })).text).toMatch(/sudah live/);
  });
  it("the widget's own save and schedule calls work on it: changed in place, pictures kept, then scheduled", async () => {
    const { id, qid } = await mk();
    // exactly what the card sends on Simpan perubahan (empty parts and topic clear them, photo list is complete)
    const e = await call("edit_post", { post_id: qid, text: "Teks baharu selepas aku ubah", parts: [], topic: "", photo_ids: [id], media_urls: [EXTRA] });
    expect(e.err, e.text).toBe(false);
    let q = (await store.load()).queue[qid];
    expect(q.parts).toEqual(["Teks baharu selepas aku ubah"]);
    expect(q.topic).toBeUndefined();
    expect(q.mediaUrls).toHaveLength(2);
    expect(q.mediaUrls).toContain(EXTRA);
    expect(Object.keys((await store.load()).queue)).toEqual([qid]); // changed in place, no copy made
    // then Jadual on the same card
    const s = await call("reschedule_post", { post_id: qid, scheduled_for: "2026-11-25T21:30" });
    expect(s.err, s.text).toBe(false);
    q = (await store.load()).queue[qid];
    expect(q).toMatchObject({ status: "scheduled", scheduledFor: "2026-11-25T13:30:00.000Z" });
    expect(q.parts[0]).toBe("Teks baharu selepas aku ubah");
  });
  it("a time less than 10 minutes away is refused and the text change before it is still kept", async () => {
    const { qid } = await mk();
    expect((await call("edit_post", { post_id: qid, text: "Diubah dulu", parts: [], topic: "", photo_ids: [], media_urls: [EXTRA] })).err).toBe(false);
    expect((await call("reschedule_post", { post_id: qid, scheduled_for: "2026-11-24T18:05" })).err).toBe(true); // NOW is 18:00 MYT
    const q = (await store.load()).queue[qid];
    expect(q.status).toBe("draft");
    expect(q.parts[0]).toBe("Diubah dulu");
  });
});

describe("grade_photo: real colour grading, original kept", () => {
  const bankPhoto = async (c = { r: 100, g: 120, b: 140 }) => (await savePic(await solid(200, 120, c).jpeg().toBuffer(), "kedai.jpg")).sc.photos[0];

  it("a warm preset makes a new, warmer picture; the original is untouched; Claude gets a preview image", async () => {
    const src = await bankPhoto();
    const before = await mean(lastBlob());
    const res = await raw("grade_photo", { photo_id: src.id, preset: "hangat" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Salinan baharu: ph_/);
    expect(res.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(res.content[1].data, "base64").length).toBeGreaterThan(100);
    const photos = res.structuredContent.photos;
    expect(photos).toHaveLength(2);
    const graded = photos.find((p: any) => p.id !== src.id);
    expect(graded.name).toBe("kedai-hangat.jpg");
    expect((await store.load()).photos[graded.id].mime).toBe("image/jpeg");
    expect(graded.desc).toMatch(/Grade hangat/);
    const after = await mean(lastBlob());
    expect(after.r / after.b).toBeGreaterThan((before.r / before.b) * 1.15); // warmer: more red against blue
    expect(vi.mocked(blobDel)).not.toHaveBeenCalled(); // the original stays
    expect((await store.load()).photos[src.id]).toBeTruthy();
  });
  it("cool, bright, dark, black-and-white and fade each move the pixels the right way", async () => {
    const src = await bankPhoto();
    const base = await mean(lastBlob());
    const run = async (args: Record<string, unknown>) => { await raw("grade_photo", { photo_id: src.id, ...args }); return mean(lastBlob()); };
    const cool = await run({ preset: "sejuk" });
    expect(cool.b / cool.r).toBeGreaterThan((base.b / base.r) * 1.12);
    expect(lum(await run({ exposure: 0.8 }))).toBeGreaterThan(lum(base) + 10);
    expect(lum(await run({ exposure: -0.8 }))).toBeLessThan(lum(base) - 10);
    const bw = await run({ preset: "hitam-putih" });
    expect(Math.abs(bw.r - bw.b)).toBeLessThan(4);
    const dark = await bankPhoto({ r: 20, g: 20, b: 20 });
    await raw("grade_photo", { photo_id: dark.id, fade: 1 });
    expect(lum(await mean(lastBlob()))).toBeGreaterThan(30); // blacks lifted
  });
  it("numbers override the preset, and the vignette darkens the corners", async () => {
    const src = await bankPhoto({ r: 128, g: 128, b: 128 });
    await raw("grade_photo", { photo_id: src.id, vignette: 1 });
    const out = lastBlob();
    const patch = async (left: number, top: number) => (await sharp(await sharp(out).extract({ left, top, width: 12, height: 12 }).toBuffer()).stats()).channels[0].mean; // stats() ignores extract, so crop first
    expect(await patch(0, 0)).toBeLessThan((await patch(94, 54)) - 25);
    expect(await patch(94, 54)).toBeGreaterThan(120); // the centre is left alone
    await raw("grade_photo", { photo_id: src.id, preset: "hangat", warmth: -0.5 }); // explicit warmth beats the preset's
    const m = await mean(lastBlob());
    expect(m.b).toBeGreaterThan(m.r);
  });
  it("rejects nothing-to-do, an unknown picture, an unknown preset and out-of-range numbers", async () => {
    const src = await bankPhoto();
    expect((await call("grade_photo", { photo_id: src.id })).text).toMatch(/Tiada apa untuk diubah/);
    expect((await call("grade_photo", { photo_id: "ph_nope", preset: "hangat" })).text).toMatch(/tak ada dalam bank/);
    expect((await call("grade_photo", { photo_id: src.id, preset: "pelangi" })).err).toBe(true);
    expect((await call("grade_photo", { photo_id: src.id, warmth: 5 })).err).toBe(true);
    expect((await call("list_photos")).sc.photos).toHaveLength(1); // none of those saved anything
  });
  it("list_photos gives Claude each picture's public address, so Canva can import it", async () => {
    const src = await bankPhoto();
    expect((await call("list_photos")).text).toContain(src.url);
  });
});

describe("edit_post: add or swap a picture on a post that already exists", () => {
  const seedPhotos = async () => store.update((s) => {
    const at = new Date().toISOString();
    s.photos.ph_a = { id: "ph_a", url: "https://abc123.public.blob.vercel-storage.com/photos/a.jpg", name: "a.jpg", mime: "image/jpeg", size: 1000, uploadedAt: at };
    s.photos.ph_b = { id: "ph_b", url: "https://abc123.public.blob.vercel-storage.com/photos/b.jpg", name: "b.jpg", mime: "image/jpeg", size: 1000, uploadedAt: at };
  });
  const queued = async (id: string) => (await store.load()).queue[id];
  const scheduleOne = async (text = "Hari ni aku suruh Claude post sendiri", when = "2026-11-25T13:30") => {
    await call("create_post", { text, mode: "schedule", scheduled_for: when });
    return JSON.parse((await call("list_scheduled")).text).find((r: any) => r.hook.startsWith(text.slice(0, 20))).id as string;
  };

  it("adds a picture to a scheduled post without touching its text or time", async () => {
    await seedPhotos();
    const id = await scheduleOne();
    const before = JSON.parse(JSON.stringify(await queued(id))); // a copy: the in-memory store hands out live objects
    const r = await call("edit_post", { post_id: id, photo_ids: ["ph_a"] });
    expect(r.err).toBe(false);
    expect(r.sc.kind).toBe("result");
    expect(r.text).toMatch(/gambar \(1\)/);
    const after = await queued(id);
    expect(after.mediaUrls).toEqual(["https://abc123.public.blob.vercel-storage.com/photos/a.jpg"]);
    expect(after.parts).toEqual(before.parts);
    expect(after.scheduledFor).toBe(before.scheduledFor);
    expect(after.status).toBe("scheduled");
    expect(Object.keys((await store.load()).queue)).toEqual([id]); // edited in place, not recreated
  });
  it("photo_ids is the whole list: swap one, add another, then clear them", async () => {
    await seedPhotos();
    const id = await scheduleOne();
    await call("edit_post", { post_id: id, photo_ids: ["ph_a"] });
    await call("edit_post", { post_id: id, photo_ids: ["ph_b", "ph_a"] });
    expect((await queued(id)).mediaUrls).toHaveLength(2);
    await call("edit_post", { post_id: id, photo_ids: ["ph_b"] });
    expect((await queued(id)).mediaUrls).toEqual(["https://abc123.public.blob.vercel-storage.com/photos/b.jpg"]);
    await call("edit_post", { post_id: id, photo_ids: [] });
    expect((await queued(id)).mediaUrls).toBeUndefined();
  });
  it("changes text, topic and time, and keeps the list view in step", async () => {
    const id = await scheduleOne();
    const r = await call("edit_post", { post_id: id, text: "Teks baharu yang lebih baik", topic: "Business", scheduled_for: "2026-11-26T20:00" });
    expect(r.err).toBe(false);
    expect(await queued(id)).toMatchObject({ parts: ["Teks baharu yang lebih baik"], topic: "Business", scheduledFor: "2026-11-26T12:00:00.000Z", hook: "Teks baharu yang lebih baik" });
    expect(JSON.parse((await call("list_scheduled")).text)[0]).toMatchObject({ id, hook: "Teks baharu yang lebih baik" });
    await call("edit_post", { post_id: id, topic: "" });
    expect((await queued(id)).topic).toBeUndefined();
  });
  it("works on a draft too, and a draft has no time to change", async () => {
    await seedPhotos();
    await call("create_post", { text: "Draf belum siap", mode: "draft" });
    const id = JSON.parse((await call("list_scheduled")).text)[0].id;
    expect((await call("edit_post", { post_id: id, photo_ids: ["ph_a"] })).err).toBe(false);
    const t = await call("edit_post", { post_id: id, scheduled_for: "2026-11-26T20:00" });
    expect(t.err).toBe(true);
    expect(t.text).toMatch(/reschedule_post/);
  });
  it("refuses live posts, unknown ids, empty edits, bad times, an unknown picture, a duplicate and bad text; changes nothing", async () => {
    await seedPhotos();
    const id = await scheduleOne();
    await call("create_post", { text: "Satu lagi post", mode: "schedule", scheduled_for: "2026-11-27T10:00" });
    const snapshot = JSON.stringify((await store.load()).queue);
    const attempts: [Record<string, unknown>, RegExp][] = [
      [{ post_id: "t_z1", text: "x" }, /tak dijumpai/],
      [{ post_id: "q_nope", text: "x" }, /tak dijumpai/],
      [{ post_id: id }, /Tiada apa untuk diubah/],
      [{ post_id: id, scheduled_for: "2026-11-24T18:05" }, /10 minit/],
      [{ post_id: id, scheduled_for: "bukan masa" }, /bukan masa yang sah/],
      [{ post_id: id, scheduled_for: "2027-06-01T10:00" }, /terlalu jauh/],
      [{ post_id: id, photo_ids: ["ph_nope"] }, /tak ada dalam bank/],
      [{ post_id: id, text: "Satu lagi post" }, /Teks yang sama/],
      [{ post_id: id, text: "x".repeat(501) }, /Tak boleh ubah/],
    ];
    for (const [args, why] of attempts) {
      const r = await call("edit_post", args);
      expect(r.err, JSON.stringify(args)).toBe(true);
      expect(r.text, JSON.stringify(args)).toMatch(why);
    }
    expect(JSON.stringify((await store.load()).queue)).toBe(snapshot);
  });
  it("refuses a post that is being published or already published", async () => {
    const id = await scheduleOne();
    await store.update((s) => { s.queue[id].status = "publishing"; });
    expect((await call("edit_post", { post_id: id, text: "Baru" })).text).toMatch(/sedang dipost/);
    await store.update((s) => { s.queue[id].status = "published"; s.queue[id].threadsId = "t_9"; });
    expect((await call("edit_post", { post_id: id, text: "Baru" })).text).toMatch(/tak benarkan edit/);
  });
  it("saving the same text onto itself is not treated as a duplicate", async () => {
    const id = await scheduleOne();
    expect((await call("edit_post", { post_id: id, text: "Hari ni aku suruh Claude post sendiri", topic: "Business" })).err).toBe(false);
  });
});

describe("the tools and rules Claude sees", () => {
  it("lists the new tools, and the rules send Claude to Canva, photo_from_url, grade_photo and edit_post", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["photo_from_url", "grade_photo", "edit_post"]) expect(names).toContain(n);
    const rules = client.getInstructions() ?? "";
    for (const w of ["export-design", "photo_from_url", "upload-asset-from-url", "grade_photo", "edit_post", "Canva cannot colour-grade"]) expect(rules).toContain(w);
    // the Studio rules: Claude writes or designs only when asked, and the poster flow keeps the design link
    for (const w of ["STUDIO TAB", "Do NOT write posts, suggest ideas or make posters on your own", "edit_url", "Never export or save over their design before the owner says it is good", "Pilih dari bank", "Export download links expire"]) expect(rules, w).toContain(w);
    expect(rules).not.toMatch(/Cadang post untuk saya/);
    expect(tools.find((t) => t.name === "grade_photo")!.description).toMatch(/hangat.*sinematik/);
    expect(tools.find((t) => t.name === "edit_post")!.description).toMatch(/never delete and recreate/);
  });
});
