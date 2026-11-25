// The photo bank. Meta's Threads API takes a picture only as a PUBLIC https address (it downloads the file itself),
// so uploads are stored in Vercel Blob (public store) and the bank keeps their addresses. Claude chat attachments cannot be
// handed to a connector, so pictures come in through the widget (file picker) or through a one-time upload page.
import { del, put } from "@vercel/blob";
import { randomBytes } from "node:crypto";
import { durable, load, update } from "./store.js";
import { StudioError, type Photo, type State } from "./types.js";

export const MAX_BYTES = 8 * 1024 * 1024; // Threads: JPEG or PNG, up to 8 MB
export const MAX_PHOTOS = 200;
export const blobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Look at the bytes, not the file name or the claimed type. */
export function sniff(buf: Buffer): "image/jpeg" | "image/png" | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG)) return "image/png";
  return undefined;
}

/** A link to where a picture was designed (e.g. a Canva edit link). https only, no credentials; it is only ever opened by the owner's own tap. */
export function cleanEditUrl(u: string | undefined): string | undefined {
  if (!u?.trim()) return undefined;
  let x: URL;
  try { x = new URL(u.trim()); } catch { throw new StudioError("Pautan edit tak sah."); }
  if (x.protocol !== "https:" || x.username || x.password) throw new StudioError("Pautan edit mesti https dan tanpa nama pengguna atau kata laluan.");
  if (x.href.length > 500) throw new StudioError("Pautan edit terlalu panjang.");
  return x.href;
}

export async function savePhoto(buf: Buffer, name: string, desc?: string, editUrl?: string): Promise<Photo> {
  if (!blobConfigured()) throw new StudioError("Storan gambar (Vercel Blob) belum disambung. Buka halaman /setup untuk semak; tambah Blob (pilih Public) di Vercel > Storage.");
  if (!durable()) throw new StudioError("Bank gambar perlukan Redis, tapi Redis belum disambung pada Vercel (buka halaman /setup pada alamat connector awak untuk semak).");
  const mime = sniff(buf);
  if (!mime) throw new StudioError("Hanya JPEG atau PNG dibenarkan oleh Threads. Tukar format gambar dulu.");
  if (buf.length > MAX_BYTES) throw new StudioError(`Gambar terlalu besar (${(buf.length / 1048576).toFixed(1)} MB). Maksimum 8 MB.`);
  const state = await load();
  if (Object.keys(state.photos).length >= MAX_PHOTOS) throw new StudioError(`Bank gambar penuh (${MAX_PHOTOS}). Padam yang tak guna dulu.`);
  const id = "ph_" + randomBytes(6).toString("hex");
  const safe = (name.replace(/\.[a-z0-9]+$/i, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 50) || "gambar") + (mime === "image/png" ? ".png" : ".jpg");
  const blob = await put(`photos/${id}-${safe}`, buf, { access: "public", contentType: mime, addRandomSuffix: true });
  const photo: Photo = { id, url: blob.url, name: safe, mime, size: buf.length, desc: desc?.trim().slice(0, 200) || undefined, editUrl: cleanEditUrl(editUrl), uploadedAt: new Date().toISOString() };
  await update((s) => { s.photos[id] = photo; });
  return photo;
}

/** Which unfinished posts still point at this picture (a deleted picture would break them). */
export function usedBy(state: Pick<State, "queue">, url: string) {
  return Object.values(state.queue).filter((q) => (q.status === "draft" || q.status === "scheduled" || q.status === "publishing") && (q.mediaUrls ?? []).includes(url));
}

export async function removePhoto(id: string): Promise<void> {
  const state = await load();
  const p = state.photos[id];
  if (!p) throw new StudioError("Gambar tak dijumpai dalam bank.");
  const users = usedBy(state, p.url);
  if (users.length) throw new StudioError(`Gambar ini dipakai oleh ${users.length} draf/jadual ("${users[0].hook}"). Padam atau tukar post itu dulu.`);
  try { await del(p.url); } catch (e) {
    if (!/not.?found|does not exist|404/i.test((e as Error).message)) throw new StudioError(`Gagal padam fail gambar: ${(e as Error).message}`);
  }
  await update((s) => { delete s.photos[id]; });
}

/** Photo ids to public addresses, in order. An unknown id is an error, never skipped silently. */
export function urlsFor(state: Pick<State, "photos">, ids: string[]): string[] {
  return ids.map((id) => {
    const p = state.photos[id];
    if (!p) throw new StudioError(`Gambar "${id}" tak ada dalam bank. Guna list_photos untuk id yang betul.`);
    return p.url;
  });
}
