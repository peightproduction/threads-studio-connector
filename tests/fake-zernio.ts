// A fake of Zernio's REST API (https://zernio.com/api/v1) for tests. Install with `vi.stubGlobal("fetch", fake.fetch)`.
// Calls to localhost fall through to the real fetch (for the HTTP tests).
export type ZCall = { method: string; path: string; query: Record<string, string>; body?: any; headers: Record<string, string> };
type ZPost = { _id: string; content: string; status: string; publishedAt?: string; scheduledFor?: string; createdAt: string; mediaItems?: unknown[]; platforms: any[] };

export const KEY = "zk_test_0123456789abcdef";

export function createFakeZernio() {
  const realFetch = globalThis.fetch;
  const st = {
    accounts: [] as { _id: string; platform: string; username: string; isActive: boolean }[],
    posts: [] as ZPost[],
    external: [] as ZPost[],
    metrics: {} as Record<string, Record<string, number>>,
    comments: {} as Record<string, any[]>,
    calls: [] as ZCall[],
    seq: 0,
    postMode: "ok" as "ok" | "server" | "failed" | "duplicate" | "publishing" | "disconnected",
    publishingPolls: 1, // how many GET /posts/{id} still answer "publishing" in mode "publishing"
    analytics402: false,
    deleteLive: false, // true: DELETE may remove a published post
    rejectKey: false, // every call answers 401
    followers: 321 as number | undefined,
    idem: new Map<string, string>(),
  };

  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const iso = () => new Date().toISOString();

  async function fetch(input: any, init: any = {}): Promise<Response> {
    const u = new URL(String(input));
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(input, init);
    const method = String(init.method ?? "GET").toUpperCase();
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const query = Object.fromEntries(u.searchParams.entries());
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    st.calls.push({ method, path, query, body, headers });
    if (u.hostname !== "zernio.com") return json({ error: "unexpected host " + u.hostname }, 599);
    if (st.rejectKey || headers.authorization !== `Bearer ${KEY}`) return json({ error: "Invalid API key" }, 401);

    if (method === "GET" && path === "/accounts") return json({ accounts: st.accounts, pagination: { limit: 100 } });
    if (method === "GET" && path === "/accounts/follower-stats") return st.followers === undefined ? json({ error: "add-on required" }, 402) : json({ stats: { followers: st.followers } });

    if (method === "POST" && path === "/posts") {
      if (st.postMode === "server") return json({ error: "Bad gateway" }, 502);
      if (st.postMode === "duplicate") return json({ error: "Duplicate content", code: "duplicate_content" }, 409);
      if (st.postMode === "disconnected") return json({ error: "Account disconnected", code: "ACCOUNT_DISCONNECTED" }, 403);
      const key = headers["idempotency-key"];
      if (key && st.idem.has(key)) return json({ message: "replayed", post: st.posts.find((p) => p._id === st.idem.get(key)) }, 200);
      const id = `zp_${++st.seq}`;
      const acc = body?.platforms?.[0]?.accountId;
      const failed = st.postMode === "failed";
      const publishing = st.postMode === "publishing";
      const status = failed ? "failed" : publishing ? "publishing" : "published";
      const post: ZPost = {
        _id: id, content: body?.content ?? "", status, createdAt: iso(), mediaItems: body?.mediaItems,
        ...(status === "published" ? { publishedAt: iso() } : {}),
        platforms: [{ platform: "threads", accountId: acc, status, ...(status === "published" ? { platformPostId: "17" + id, platformPostUrl: `https://www.threads.com/@demo_user/post/Z${id}` } : {}), ...(failed ? { errorMessage: "Instagram account is restricted" } : {}) }],
      };
      st.posts.push(post);
      if (key) st.idem.set(key, id);
      return json({ message: "Post created", post }, 201);
    }
    let m = path.match(/^\/posts\/([^/]+)$/);
    if (m && method === "GET") {
      const p = st.posts.find((x) => x._id === m![1]);
      if (!p) return json({ error: "not found" }, 404);
      if (st.postMode === "publishing" && p.status === "publishing" && --st.publishingPolls <= 0) {
        p.status = "published"; p.publishedAt = iso();
        Object.assign(p.platforms[0], { status: "published", platformPostId: "17" + p._id, platformPostUrl: `https://www.threads.com/@demo_user/post/Z${p._id}` });
      }
      return json({ post: p });
    }
    if (m && method === "DELETE") {
      const i = st.posts.findIndex((x) => x._id === m![1]);
      if (i < 0) return json({ error: "not found" }, 404);
      if (st.posts[i].status === "published" && !st.deleteLive) return json({ error: "Published posts cannot be deleted" }, 400);
      st.posts.splice(i, 1);
      return json({ message: "deleted" });
    }
    if (method === "GET" && path === "/posts") {
      const pool = query.source === "external" ? st.external : st.posts;
      const list = pool.filter((p) => (!query.status || p.status === query.status) && (!query.accountId || p.platforms.some((x) => x.accountId === query.accountId)));
      return json({ posts: list, pagination: { page: Number(query.page ?? 1), limit: Number(query.limit ?? 100), total: list.length, pages: 1 } });
    }
    if (method === "GET" && path === "/analytics") {
      if (st.analytics402) return json({ error: "Analytics add-on required" }, 402);
      const id = query.postId;
      return json({ postId: id, analytics: { views: 0, likes: 0, comments: 0, reposts: 0, shares: 0, ...(st.metrics[id] ?? {}) } });
    }
    m = path.match(/^\/inbox\/comments\/([^/]+)$/);
    if (m && method === "GET") return json({ status: "success", comments: st.comments[m[1]] ?? [], pagination: { hasMore: false } });
    return json({ error: `fake zernio: no route for ${method} ${path}` }, 404);
  }

  return {
    fetch,
    state: st,
    calls: (method: string, path: string | RegExp) => st.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
    reset() {
      st.accounts = [{ _id: "acc_1", platform: "threads", username: "demo_user", isActive: true }];
      st.posts = []; st.external = []; st.metrics = {}; st.comments = {}; st.calls = []; st.seq = 0; st.postMode = "ok"; st.publishingPolls = 1;
      st.analytics402 = false; st.deleteLive = false; st.rejectKey = false; st.followers = 321; st.idem = new Map();
    },
    addPost(id: string, text: string, publishedAt: string, metrics: Record<string, number> = {}) {
      st.posts.push({ _id: id, content: text, status: "published", publishedAt, createdAt: publishedAt, platforms: [{ platform: "threads", accountId: "acc_1", status: "published", publishedAt, platformPostId: "17" + id, platformPostUrl: `https://www.threads.com/@demo_user/post/${id}` }] });
      st.metrics[id] = metrics;
    },
  };
}
