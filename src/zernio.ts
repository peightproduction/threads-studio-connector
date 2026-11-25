// Zernio (zernio.com) as the posting backend: no Meta app, no tester invite, no OAuth. One API key (ZERNIO_API_KEY, from
// Zernio > Settings > API keys) in Vercel, and the Threads account is linked once inside Zernio itself.
//
// This file has the same job as threads-meta.ts (Meta's own Threads API) and threads.ts picks one of the two: when
// ZERNIO_API_KEY is set, everything below is used. Drafts and the queue stay in this connector (scheduler.ts); a due post is
// sent to Zernio with publishNow, and an Idempotency-Key (the queue id) stops a retry from creating a second post.
//
// Contract (docs.zernio.com): base https://zernio.com/api/v1, header "Authorization: Bearer <key>".
//   GET /accounts            -> { accounts: [{ _id, platform, username, isActive }] }
//   POST /posts              -> 201 { post: { _id, status, platforms: [{ platform, status, platformPostUrl, errorMessage }] } } (207 = partly failed)
//   GET /posts, GET /posts/{id}, DELETE /posts/{id}
//   GET /analytics?postId=   -> needs Zernio's analytics add-on (402 without it)
//   GET /inbox/comments/{postId}?accountId=   -> { comments: [...] }
import { load, update } from "./store.js";
import { StudioError, type Metrics, type Post } from "./types.js";
import { ThreadsError, normTs, type Published, type Reply } from "./threads-meta.js";

const DAY = 86_400_000;
const NEED_CONNECT = "Zernio belum disambung. Panggil tool connect_threads (akaun Threads mesti dah disambung dalam Zernio dulu).";

export const enabled = (): boolean => Boolean(process.env.ZERNIO_API_KEY?.trim());
const base = (): string => (process.env.ZERNIO_API_BASE?.trim() || "https://zernio.com/api/v1").replace(/\/+$/, "");
const apiKey = (): string => {
  const k = process.env.ZERNIO_API_KEY?.trim();
  if (!k) throw new StudioError("ZERNIO_API_KEY belum diset di Vercel (buka halaman /setup pada alamat connector awak untuk semak).");
  return k;
};

type Query = Record<string, string | number | boolean | undefined>;
type Reply2 = { status: number; body: any };

/** One call to Zernio. A POST that dies on the network or with a 5xx may still have gone through, so it is flagged "ambiguous". */
async function call(method: "GET" | "POST" | "DELETE", path: string, o: { query?: Query; body?: unknown; idem?: string } = {}): Promise<Reply2> {
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey()}`, accept: "application/json" };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.idem) headers["idempotency-key"] = o.idem.slice(0, 200);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    throw new ThreadsError(`Zernio tak dapat dihubungi (${(e as Error).name}).`, undefined, undefined, method !== "GET");
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.ok || res.status === 207) return { status: res.status, body };
  throw explain(res.status, body, method !== "GET" && res.status >= 500);
}

function explain(status: number, body: any, ambiguous: boolean): ThreadsError {
  const code = String(body?.code ?? "");
  const msg = String(body?.error ?? body?.message ?? `Zernio ${status}`);
  if (status === 401) return new ThreadsError("Kunci API Zernio tak sah atau sudah tamat. Buat kunci baharu di Zernio (Settings, API keys), tukar ZERNIO_API_KEY di Vercel dan Redeploy.", status);
  if (status === 402) return new ThreadsError(`Ciri ini perlukan pelan atau add-on Zernio (${msg}).`, status, 402);
  if (status === 403 && /DISCONNECTED/i.test(code)) return new ThreadsError("Akaun Threads dalam Zernio terputus. Sambung semula di zernio.com (Connections, Threads), kemudian cuba lagi.", status);
  if (status === 403 && /NOT_ENABLED|OVER_LIMIT/i.test(code)) return new ThreadsError(`Zernio tak benarkan akaun ini untuk post (${msg}). Semak pelan Zernio awak.`, status);
  if (status === 409 && /duplicate/i.test(code)) return new ThreadsError("Zernio tolak: kandungan yang sama baru sahaja dipost. Ubah sedikit teksnya atau tunggu.", status);
  if (status === 429) return new ThreadsError("Had permintaan Zernio dicapai (60 seminit pada pelan percuma). Cuba lagi sebentar lagi.", status);
  return new ThreadsError(msg, status, undefined, ambiguous);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ---- connection -------------------------------------------------------------------------------

type ZAccount = { _id: string; platform?: string; username?: string; displayName?: string; isActive?: boolean };

/** The Threads accounts linked inside Zernio. */
export async function accounts(): Promise<ZAccount[]> {
  const r = await call("GET", "/accounts", { query: { platform: "threads", limit: 100 } });
  return ((r.body?.accounts ?? []) as ZAccount[]).filter((a) => (a.platform ?? "threads") === "threads" && a._id);
}

/** Links this connector to one Threads account that already exists in Zernio. Nothing secret is stored: the key stays in Vercel. */
export async function connect(username: string | undefined, now = new Date()): Promise<{ id: string; username: string }> {
  const live = (await accounts()).filter((a) => a.isActive !== false);
  if (!live.length) {
    throw new StudioError("Tiada akaun Threads dalam Zernio. Buka zernio.com, Connections, pilih Threads dan log masuk dengan akaun Instagram yang memiliki profil Threads awak (mesti Business atau Creator). Lepas itu panggil connect_threads semula.");
  }
  const want = username?.replace(/^@/, "").trim().toLowerCase();
  const names = live.map((a) => "@" + (a.username ?? a._id)).join(", ");
  const pick = want ? live.find((a) => (a.username ?? "").toLowerCase() === want) : live.length === 1 ? live[0] : undefined;
  if (!pick) {
    throw new StudioError(want ? `Akaun "${username}" tak dijumpai dalam Zernio. Yang ada: ${names}.` : `Ada beberapa akaun Threads dalam Zernio (${names}). Panggil connect_threads dengan username yang dikehendaki.`);
  }
  const conn = { token: "zernio", expiresAt: new Date(now.getTime() + 3650 * DAY).toISOString(), refreshedAt: now.toISOString(), userId: pick._id, username: pick.username ?? "" };
  await update((s) => { s.threads = conn; });
  return { id: conn.userId, username: conn.username };
}

export async function connected(): Promise<boolean> {
  return enabled() && Boolean((await load()).threads?.userId);
}

/** Zernio has no token to renew: the key from Vercel is what every call carries. */
export async function accessToken(): Promise<string> {
  if (!(await connected())) throw new ThreadsError(NEED_CONNECT);
  return apiKey();
}

async function accountId(): Promise<string> {
  const id = (await load()).threads?.userId;
  if (!id) throw new ThreadsError(NEED_CONNECT);
  return id;
}

export async function me(): Promise<{ id: string; username: string }> {
  const t = (await load()).threads;
  if (!t?.userId) throw new ThreadsError(NEED_CONNECT);
  return { id: t.userId, username: t.username ?? "" };
}

// ---- reading ----------------------------------------------------------------------------------

function fromZernioPost(z: any): Post | undefined {
  const pl = (z?.platforms ?? []).find((x: any) => x?.platform === "threads") ?? {};
  if (!z?._id) return undefined;
  if (pl.status && pl.status !== "published") return undefined;
  const items = pl.platformSpecificData?.threadItems;
  const text = String(z.content ?? (Array.isArray(items) ? items[0]?.content : "") ?? "").trim();
  return {
    id: String(z._id),
    platformId: String(z._id),
    text,
    status: "published",
    at: normTs(String(pl.publishedAt ?? z.publishedAt ?? z.scheduledFor ?? z.createdAt ?? "")),
    url: pl.platformPostUrl ?? undefined,
    media: Array.isArray(z.mediaItems) ? z.mediaItems.length : 0,
    source: "native", // posts.ts marks the ones this connector sent as "studio"
    metricsKnown: false,
  };
}

/** Their published Threads posts newest first. Posts typed in the Threads app come too when Zernio has synced them. */
export async function listPosts(days: number): Promise<Post[]> {
  const acc = await accountId();
  const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const cutoff = Date.now() - days * DAY;
  const out = new Map<string, Post>();
  for (const source of [undefined, "external"] as const) {
    for (let page = 1; page <= 5; page++) {
      let r: Reply2;
      try {
        r = await call("GET", "/posts", { query: { platform: "threads", accountId: acc, status: "published", fromDate: from, limit: 100, page, source, view: "summary" } });
      } catch (e) {
        if (e instanceof ThreadsError && e.status === 400) { // an option this Zernio version does not know: ask the plain question
          try { r = await call("GET", "/posts", { query: { platform: "threads", accountId: acc, limit: 100, page } }); } catch (e2) { if (source) break; throw e2; }
        } else if (source) break; // the "external" listing is a bonus: never fail the whole read because of it
        else throw e;
      }
      const list: any[] = r.body?.posts ?? [];
      for (const z of list) {
        const p = fromZernioPost(z);
        if (p && Date.parse(p.at) >= cutoff && !out.has(p.id)) out.set(p.id, p);
      }
      const pg = r.body?.pagination;
      if (!list.length || !pg || (typeof pg.pages === "number" && page >= pg.pages) || (pg.pages === undefined && !pg.nextCursor)) break;
    }
  }
  return [...out.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Views, likes, replies, reposts of one post. Needs Zernio's analytics add-on; without it this throws and the number stays unknown (never zero). */
export async function insights(id: string): Promise<Metrics> {
  const r = await call("GET", "/analytics", { query: { postId: id } });
  if (r.status === 202 || r.body?.syncStatus === "pending") throw new ThreadsError("Zernio masih mengambil nombor post ini (sync belum siap).", r.status);
  const a = r.body?.analytics ?? r.body?.platformAnalytics?.[0]?.analytics ?? {};
  return { views: num(a.views) ?? num(a.totalViews) ?? num(a.impressions), likes: num(a.likes), replies: num(a.comments), reposts: num(a.reposts), quotes: undefined, shares: num(a.shares) };
}

/** Follower count, when Zernio's analytics add-on is on. Any failure means "unknown". */
export async function followers(): Promise<number | undefined> {
  try {
    const r = await call("GET", "/accounts/follower-stats", { query: { accountId: await accountId() } });
    const find = (o: any, depth = 0): number | undefined => {
      if (!o || typeof o !== "object" || depth > 3) return undefined;
      for (const [k, v] of Object.entries(o)) if (/^(current)?followers(count)?$/i.test(k) && num(v) !== undefined) return v as number;
      for (const v of Object.values(o)) { const f = find(v, depth + 1); if (f !== undefined) return f; }
      return undefined;
    };
    return find(r.body);
  } catch { return undefined; }
}

// ---- writing ----------------------------------------------------------------------------------

/** Publish now. Several parts become one Threads thread; photos and the topic go on the first part. */
export async function publish(parts: string[], opts: { mediaUrls?: string[]; topic?: string; idempotencyKey?: string } = {}): Promise<Published> {
  const posts = parts.map((p) => p.trim()).filter(Boolean);
  if (!posts.length) throw new ThreadsError("Post kosong.");
  const acc = await accountId();
  const media = (opts.mediaUrls ?? []).slice(0, 20).map((url) => ({ type: "image", url }));
  const special: Record<string, unknown> = {};
  if (opts.topic) special.topic_tag = opts.topic;
  if (posts.length > 1) special.threadItems = posts.map((content, i) => (i === 0 && media.length ? { content, mediaItems: media } : { content }));
  const body: Record<string, unknown> = {
    content: posts[0],
    platforms: [{ platform: "threads", accountId: acc, ...(Object.keys(special).length ? { platformSpecificData: special } : {}) }],
    publishNow: true,
  };
  if (media.length && posts.length === 1) body.mediaItems = media;

  const r = await call("POST", "/posts", { body, idem: opts.idempotencyKey });
  const finish = (post: any, partial: boolean): Published | undefined => {
    const pl = (post?.platforms ?? []).find((x: any) => x?.platform === "threads") ?? post?.platforms?.[0] ?? {};
    const st = String(pl.status ?? post?.status ?? "");
    if (st === "failed") throw new ThreadsError(`Zernio tak dapat post: ${pl.errorMessage ?? post?.error ?? "ralat tak diketahui"}`);
    if (st === "published" || pl.platformPostUrl) {
      const warn = partial || post?.status === "partial" ? `Sebahagian sambungan thread mungkin gagal: ${pl.errorMessage ?? "semak dalam Zernio"}` : undefined;
      return { id: String(post._id), url: pl.platformPostUrl ?? undefined, ids: [String(post._id)], warning: warn };
    }
    return undefined;
  };
  const post = r.body?.post ?? {};
  if (!post._id) throw new ThreadsError(`Zernio tak beri id post (${r.body?.error ?? r.body?.message ?? "jawapan kosong"}).`, undefined, undefined, true);
  const first = finish(post, r.status === 207);
  if (first) return first;
  // still "publishing": ask again a few times before giving up (give up = "ambiguous", so nothing is re-sent automatically)
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const g = await call("GET", `/posts/${encodeURIComponent(String(post._id))}`);
    const done = finish(g.body?.post ?? {}, false);
    if (done) return done;
  }
  throw new ThreadsError("Zernio masih memproses post ini. Semak dalam Zernio atau app Threads sama ada ia dah live sebelum cuba lagi.", undefined, undefined, true);
}

export async function remove(id: string): Promise<void> {
  try {
    await call("DELETE", `/posts/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ThreadsError && e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
      throw new ThreadsError(`Zernio tak benarkan padam post ini (${e.message}). Post yang dah live biasanya mesti dipadam dalam app Threads.`, e.status);
    }
    throw e;
  }
}

/** The top-level comments under one post. */
export async function replies(postId: string, limit = 50): Promise<Reply[]> {
  const r = await call("GET", `/inbox/comments/${encodeURIComponent(postId)}`, { query: { accountId: await accountId(), limit: Math.min(Math.max(limit, 1), 100) } });
  return ((r.body?.comments ?? []) as any[]).map((c) => ({
    id: String(c.id),
    from: String(c.from?.username ?? c.from?.name ?? ""),
    text: String(c.message ?? ""),
    at: normTs(String(c.createdTime ?? "")),
    link: c.url ?? undefined,
    hasReplies: Boolean(c.replyCount > 0 || c.repliesHasMore),
    hidden: Boolean(c.isHidden),
  }));
}
