// Meta's official Threads API (graph.threads.net), straight from the connector, for the owner's own account. Needs a Meta app with
// the "Access the Threads API" use case and @username as a Threads tester. Nothing here likes, follows or comments on
// other people's posts.
//
// The API has NO drafts and NO scheduling: those live in the connector's own queue (scheduler.ts).
import { createHmac, timingSafeEqual } from "node:crypto";
import { load, update } from "./store.js";
import { StudioError, type Metrics, type Post } from "./types.js";

const BASE = "https://graph.threads.net/v1.0";
const AUTH_BASE = "https://graph.threads.net";
// Everything this connector can use on THEIR OWN account: read posts, publish, insights, delete, read comments, manage comments
// (reply, hide). Each name here must also be switched on in the Meta app (Use cases > Access the Threads API > Permissions),
// otherwise Meta's Allow page says "Invalid Scopes". THREADS_SCOPES overrides this list without a code change.
export const SCOPES = process.env.THREADS_SCOPES?.trim() || "threads_basic,threads_content_publish,threads_manage_insights,threads_delete,threads_read_replies,threads_manage_replies";
const DAY = 86_400_000;
const REFRESH_AFTER_MS = 7 * DAY; // a long-lived token can be renewed once it is a day old; weekly keeps it safe

export class ThreadsError extends StudioError {
  constructor(message: string, public status?: number, public code?: number, public ambiguous = false) {
    super(message);
  }
}

export const publicUrl = (): string => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${process.env.PORT || 3002}`;
};
export const redirectUri = () => `${publicUrl()}/oauth/callback`;
export const appConfigured = () => Boolean(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);

const NEED_CONNECT = "Threads belum disambung atau tokennya tamat. Panggil tool connect_threads dan buka pautan yang diberi.";

// ---- HTTP -------------------------------------------------------------------------------------

type Params = Record<string, string | number | undefined>;

async function req(method: "GET" | "POST" | "DELETE", path: string, token: string, params: Params = {}): Promise<any> {
  const url = new URL(path.startsWith("https://") ? path : BASE + path);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { method, signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    // After a POST this may mean the request arrived but the answer did not: the caller must not blindly retry.
    throw new ThreadsError(`Threads tak dapat dihubungi (${(e as Error).name}).`, undefined, undefined, method !== "GET");
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.ok) return body;
  const err = body?.error ?? {};
  const msg: string = err.message ?? `Threads ${res.status}`;
  if (err.code === 190 || (err.type === "OAuthException" && /token|session|expired/i.test(msg))) throw new ThreadsError(NEED_CONNECT, res.status, err.code);
  if (res.status === 429 || [4, 17, 32, 613].includes(err.code)) throw new ThreadsError("Had request Threads dicapai. Cuba lagi sebentar lagi.", res.status, err.code);
  throw new ThreadsError(msg, res.status, err.code);
}

/** Threads sends "2026-11-24T04:00:00+0000" (no colon in the offset). */
export const normTs = (ts: string | undefined): string => {
  if (!ts) return new Date(0).toISOString();
  const t = ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? new Date(0).toISOString() : new Date(ms).toISOString();
};

// ---- token ------------------------------------------------------------------------------------

export async function connected(): Promise<boolean> {
  const s = await load();
  return Boolean(s.threads || process.env.THREADS_ACCESS_TOKEN);
}

/** The current token, renewed weekly. THREADS_ACCESS_TOKEN (from Meta's dashboard) works as a first bootstrap. */
export async function accessToken(now = new Date()): Promise<string> {
  const s = await load();
  let t = s.threads;
  if (!t && process.env.THREADS_ACCESS_TOKEN) {
    t = { token: process.env.THREADS_ACCESS_TOKEN, expiresAt: new Date(now.getTime() + 55 * DAY).toISOString(), refreshedAt: new Date(now.getTime() - 6 * DAY).toISOString() };
    const boot = t;
    await update((st) => { st.threads ??= boot; });
  }
  if (!t) throw new ThreadsError(NEED_CONNECT);
  if (Date.parse(t.expiresAt) < now.getTime()) throw new ThreadsError(NEED_CONNECT);
  if (now.getTime() - Date.parse(t.refreshedAt) > REFRESH_AFTER_MS) {
    try {
      const url = new URL(`${AUTH_BASE}/refresh_access_token`);
      url.searchParams.set("grant_type", "th_refresh_token");
      url.searchParams.set("access_token", t.token);
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const j: any = r.ok ? await r.json() : {};
      if (j.access_token) {
        const fresh = { ...t, token: String(j.access_token), refreshedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (Number(j.expires_in) || 60 * 86400) * 1000).toISOString() };
        await update((st) => { st.threads = fresh; });
        return fresh.token;
      }
    } catch { /* keep the current token; it is still valid until expiresAt */ }
  }
  return t.token;
}

export function authorizeUrl(state: string): string {
  if (!appConfigured()) throw new StudioError("THREADS_APP_ID dan THREADS_APP_SECRET belum diset (buka halaman /setup pada alamat connector awak untuk semak).");
  const q = new URLSearchParams({ client_id: process.env.THREADS_APP_ID!, redirect_uri: redirectUri(), scope: SCOPES, response_type: "code", state });
  return `https://threads.net/oauth/authorize?${q}`;
}

/** Code from Meta's redirect to a 60-day token. */
export async function exchangeCode(code: string): Promise<{ token: string; expiresIn: number }> {
  const id = process.env.THREADS_APP_ID, secret = process.env.THREADS_APP_SECRET;
  if (!id || !secret) throw new StudioError("THREADS_APP_ID / THREADS_APP_SECRET belum diset.");
  let r = await fetch(`${AUTH_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirectUri(), code: code.replace(/#_$/, "") }),
    signal: AbortSignal.timeout(30_000),
  });
  const short: any = await r.json().catch(() => ({}));
  if (!short.access_token) throw new ThreadsError(short?.error?.message ?? short?.error_message ?? "Kod sambungan tak sah atau sudah digunakan.");
  const url = new URL(`${AUTH_BASE}/access_token`);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("access_token", String(short.access_token));
  r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const long: any = await r.json().catch(() => ({}));
  if (!long.access_token) throw new ThreadsError(long?.error?.message ?? "Threads tak beri token jangka panjang.");
  return { token: String(long.access_token), expiresIn: Number(long.expires_in) || 60 * 86400 };
}

export async function saveConnection(token: string, expiresIn: number, now = new Date()): Promise<{ id: string; username: string }> {
  const me = await req("GET", "/me", token, { fields: "id,username" });
  const conn = { token, expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(), refreshedAt: now.toISOString(), userId: String(me.id), username: String(me.username ?? "") };
  await update((s) => { s.threads = conn; });
  return { id: conn.userId, username: conn.username };
}

export async function disconnect(): Promise<void> {
  await update((s) => { delete s.threads; });
}

/** Meta's deauthorize / data-deletion callbacks send a signed_request: "<sig>.<payload>" (base64url, HMAC-SHA256 with the app secret). */
export function parseSignedRequest(signed: string): Record<string, unknown> | undefined {
  const secret = process.env.THREADS_APP_SECRET;
  if (!secret || typeof signed !== "string" || !signed.includes(".")) return undefined;
  const [sig, payload] = signed.split(".", 2);
  const expected = createHmac("sha256", secret).update(payload).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return undefined; }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")); } catch { return undefined; }
}

// ---- reading ----------------------------------------------------------------------------------

export type MetaPost = { id: string; text?: string; timestamp?: string; permalink?: string; media_type?: string };

export const fromMetaPost = (m: MetaPost): Post => ({
  id: String(m.id),
  platformId: String(m.id),
  text: (m.text ?? "").trim(),
  status: "published",
  at: normTs(m.timestamp),
  url: m.permalink,
  media: ["IMAGE", "VIDEO", "CAROUSEL_ALBUM"].includes(m.media_type ?? "") ? 1 : 0,
  source: "native", // posts.ts marks the ones the connector published as "studio"
  metricsKnown: false,
});

export async function me(token: string): Promise<{ id: string; username: string }> {
  const r = await req("GET", "/me", token, { fields: "id,username" });
  return { id: String(r.id), username: String(r.username ?? "") };
}

/** Their own posts newest first, including ones typed in the Threads app (reposts of other people left out). */
export async function listPosts(token: string, days: number, maxPages = 3): Promise<Post[]> {
  const out: Post[] = [];
  let after: string | undefined;
  const cutoff = Date.now() - days * DAY;
  let useSince = true; // `since` narrows the query on Meta's side; if Meta rejects it we fall back to filtering here
  for (let i = 0; i < maxPages; i++) {
    let page: any;
    try {
      page = await req("GET", "/me/threads", token, { fields: "id,text,timestamp,permalink,media_type", limit: 100, since: useSince ? Math.floor(cutoff / 1000) : undefined, after });
    } catch (e) {
      if (useSince && e instanceof ThreadsError && e.code === 100) { useSince = false; i--; continue; }
      throw e;
    }
    const data = (page.data ?? []) as MetaPost[];
    for (const m of data) {
      if (m.media_type === "REPOST_FACADE") continue;
      const p = fromMetaPost(m);
      if (Date.parse(p.at) >= cutoff) out.push(p);
    }
    after = page?.paging?.cursors?.after;
    const oldest = data.length ? Date.parse(normTs(data[data.length - 1].timestamp)) : 0;
    if (!after || !data.length || oldest < cutoff) break; // newest first: once we are past the window there is nothing more to read
  }
  return out;
}

const valueOf = (e: any): number => {
  if (typeof e?.total_value?.value === "number") return e.total_value.value;
  const vals = e?.values ?? [];
  const last = vals[vals.length - 1];
  return typeof last?.value === "number" ? last.value : 0;
};

/** Views, likes, replies, reposts, quotes, shares of one post, live from Threads. */
export async function insights(token: string, id: string): Promise<Metrics> {
  const out = await req("GET", `/${id}/insights`, token, { metric: "views,likes,replies,reposts,quotes,shares" });
  const m: Record<string, number> = {};
  for (const e of out.data ?? []) m[e.name] = valueOf(e);
  return { views: m.views, likes: m.likes, replies: m.replies, reposts: m.reposts, quotes: m.quotes, shares: m.shares };
}

export async function followers(token: string): Promise<number | undefined> {
  try {
    const out = await req("GET", "/me/threads_insights", token, { metric: "followers_count" });
    for (const e of out.data ?? []) if (e.name === "followers_count") return valueOf(e);
  } catch { /* not available for every account */ }
  return undefined;
}

// ---- writing ----------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function container(token: string, params: Params): Promise<string> {
  const r = await req("POST", "/me/threads", token, params);
  return String(r.id);
}

/** Wait until Threads has processed a container (photos take a few seconds; text is instant). */
async function ready(token: string, cid: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const st = await req("GET", `/${cid}`, token, { fields: "status,error_message" });
    if (st.status === "FINISHED") return;
    if (st.status === "ERROR" || st.status === "EXPIRED") throw new ThreadsError(`Threads tak terima post (${st.error_message ?? st.status}).`);
    await sleep(2000);
  }
  throw new ThreadsError("Threads ambil masa terlalu lama memproses post. Semak dalam app Threads sebelum cuba lagi.", undefined, undefined, true);
}

async function go(token: string, cid: string): Promise<string> {
  await ready(token, cid);
  const r = await req("POST", "/me/threads_publish", token, { creation_id: cid });
  return String(r.id);
}

export type Published = { id: string; url?: string; ids: string[]; warning?: string };

/** Publish now. Several parts become one Threads thread (photos and the topic go on the first). */
export async function publish(token: string, parts: string[], opts: { mediaUrls?: string[]; topic?: string } = {}): Promise<Published> {
  const posts = parts.map((p) => p.trim()).filter(Boolean);
  if (!posts.length) throw new ThreadsError("Post kosong.");
  const media = (opts.mediaUrls ?? []).slice(0, 20);
  let first: string;
  if (media.length > 1) {
    const kids: string[] = [];
    for (const u of media) kids.push(await container(token, { media_type: "IMAGE", image_url: u, is_carousel_item: "true" }));
    for (const k of kids) await ready(token, k);
    first = await container(token, { media_type: "CAROUSEL", children: kids.join(","), text: posts[0], topic_tag: opts.topic });
  } else if (media.length === 1) {
    first = await container(token, { media_type: "IMAGE", image_url: media[0], text: posts[0], topic_tag: opts.topic });
  } else {
    first = await container(token, { media_type: "TEXT", text: posts[0], topic_tag: opts.topic });
  }
  const firstId = await go(token, first);
  const ids = [firstId];
  let warning: string | undefined;
  try {
    for (const p of posts.slice(1)) ids.push(await go(token, await container(token, { media_type: "TEXT", text: p, reply_to_id: ids[ids.length - 1] })));
  } catch (e) {
    warning = `Post pertama dah live tetapi sambungan ${ids.length + 1} gagal: ${(e as Error).message}`;
  }
  let url: string | undefined;
  try { url = (await req("GET", `/${firstId}`, token, { fields: "permalink" })).permalink; } catch { /* the post is live either way */ }
  return { id: firstId, url, ids, warning };
}

/** Turns Meta's "no permission" errors into one clear instruction; anything else passes through. */
function permissionHint(e: unknown, what: string, scope: string): unknown {
  if (e instanceof ThreadsError && (e.code === 10 || e.code === 200 || /permission|scope|not authori[sz]ed|\bthreads_[a-z_]+/i.test(e.message))) {
    return new ThreadsError(`Meta tak benarkan ${what} (${e.message}). Selalunya kebenaran ${scope} belum diberi pada sambungan ini: panggil connect_threads dengan reconnect=true, pemilik buka pautan dan tekan Allow semula. Pastikan juga permission ${scope} dihidupkan dalam use case Threads API pada Meta app.`, e.status, e.code);
  }
  return e;
}

export async function remove(token: string, id: string): Promise<void> {
  try { await req("DELETE", `/${id}`, token); }
  catch (e) { throw permissionHint(e, "padam post ini", "threads_delete"); }
}

export type Reply = { id: string; from: string; text: string; at: string; link?: string; hasReplies: boolean; hidden: boolean };

/** The comments (top level) under one of their posts. Needs threads_read_replies. */
export async function replies(token: string, postId: string, limit = 50): Promise<Reply[]> {
  try {
    const r = await req("GET", `/${postId}/replies`, token, { fields: "id,text,username,timestamp,permalink,has_replies,hide_status", limit: Math.min(Math.max(limit, 1), 100) });
    return ((r.data ?? []) as any[]).map((x) => ({ id: String(x.id), from: String(x.username ?? ""), text: String(x.text ?? ""), at: normTs(x.timestamp), link: x.permalink, hasReplies: Boolean(x.has_replies), hidden: x.hide_status === "HIDDEN" }));
  } catch (e) { throw permissionHint(e, "baca komen", "threads_read_replies"); }
}
