// Downloads a picture from a web link so it can go into the photo bank (for example a Canva export link). This is the one
// place the server fetches an address chosen from outside, so it is strict: https only, no sign-in in the address, only the
// normal port, never a private or internal address (checked on every redirect), a size cap while streaming, and a timeout.
// Note: the address is checked and then fetched, so a hostile DNS server could in theory answer differently the second time;
// this runs on Vercel with no internal network behind it, which is why that is accepted here.
import dns from "node:dns/promises";
import net from "node:net";
import { StudioError } from "./types.js";

export const MAX_DOWNLOAD = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;

/** True for loopback, private, link-local, carrier-grade NAT, multicast, reserved and "this host" addresses (IPv4 and IPv6). */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/); // IPv4 written inside IPv6
    if (mapped) return isPrivateIp(mapped[1]);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
    const first = parseInt(x.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || x.startsWith("64:ff9b:") || x.startsWith("2001:db8");
  }
  return true; // not an IP at all: treat as unsafe
}

/** Replaceable in tests. */
export const imageNet = {
  lookup: async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((r) => r.address),
  fetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
};

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== "https:") throw new StudioError("Pautan mesti https.");
  if (u.username || u.password) throw new StudioError("Pautan tak boleh mengandungi nama pengguna atau kata laluan.");
  if (u.port && u.port !== "443") throw new StudioError("Pautan mesti guna port biasa (443).");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new StudioError("Alamat dalaman tak dibenarkan.");
  const ips = net.isIP(host) ? [host] : await imageNet.lookup(host).catch(() => { throw new StudioError(`Tak dapat cari alamat "${host}".`); });
  if (!ips.length || ips.some(isPrivateIp)) throw new StudioError("Alamat dalaman atau persendirian tak dibenarkan.");
}

/** The bytes at a public https address, at most 8 MB. Does not decide whether it is a usable picture. */
export async function fetchImage(rawUrl: string): Promise<Buffer> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new StudioError("Pautan tak sah."); }
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    let res: Response;
    try { res = await imageNet.fetch(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "image/*,*/*;q=0.5", "user-agent": "ThreadsStudio/1" } }); }
    catch (e) { throw new StudioError(`Tak dapat muat turun gambar (${(e as Error).name === "TimeoutError" ? "terlalu lama" : "sambungan gagal"}).`); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop >= MAX_REDIRECTS) throw new StudioError("Terlalu banyak lencongan pada pautan gambar.");
      try { url = new URL(loc, url); } catch { throw new StudioError("Pautan lencongan tak sah."); }
      continue;
    }
    if (!res.ok) throw new StudioError(`Pautan gambar balas ${res.status}. Mungkin pautan tamat tempoh; minta pautan baharu.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_DOWNLOAD) throw new StudioError(`Gambar terlalu besar (${(declared / 1048576).toFixed(1)} MB). Maksimum 8 MB.`);
    if (!res.body) throw new StudioError("Pautan gambar kosong.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD) { await reader.cancel().catch(() => {}); throw new StudioError("Gambar terlalu besar. Maksimum 8 MB."); }
      chunks.push(value);
    }
    if (!total) throw new StudioError("Pautan gambar kosong.");
    return Buffer.concat(chunks);
  }
}
