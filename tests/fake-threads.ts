// A fake of Meta's Threads API (graph.threads.net) for tests and for scripts/make-fixtures.ts. No test framework needed:
// install with `globalThis.fetch = fake.fetch`. Calls to localhost fall through to the real fetch (for the HTTP tests).
export type FakePost = { id: string; text: string; timestamp: string; permalink: string; media_type: string; reply_to?: string; topic_tag?: string };
export type Call = { method: string; path: string; params: Record<string, string> };

export const metaTs = (iso: string) => iso.replace("Z", "+0000").replace(/\.\d{3}/, ""); // Threads' timestamp format

export function createFakeThreads() {
  const realFetch = globalThis.fetch;
  const st = {
    live: [] as FakePost[],
    metrics: {} as Record<string, Record<string, number>>,
    insightFail: new Set<string>(),
    containers: new Map<string, Record<string, string>>(),
    calls: [] as Call[],
    seq: 0,
    publishFailures: 0, // the next N threads_publish calls fail with a server error
    containerDelays: 0, // the next N status polls say IN_PROGRESS
    rejectToken: "" as string, // any request carrying this token gets Meta's "invalid token" error (190)
    followers: 321 as number | undefined,
    pageSize: 0, // > 0 turns on cursor paging for /me/threads
    rejectSince: false, // Meta answers the `since` filter with a "(#100) invalid parameter" error
    refreshes: 0,
    deleteDenied: false, // DELETE answers with a missing-permission error
    repliesDenied: false, // reading comments answers with a missing-permission error
    replies: {} as Record<string, { id: string; text: string; username: string; timestamp: string; permalink?: string; has_replies?: boolean; hide_status?: string }[]>,
    username: "demo_user",
  };

  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const err = (message: string, code: number, type = "OAuthException", status = 400) => json({ error: { message, code, type } }, status);
  const defaults = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };

  async function fetch(input: any, init: any = {}): Promise<Response> {
    const u = new URL(String(input));
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(input, init);
    const method = String(init.method ?? "GET").toUpperCase();
    const params: Record<string, string> = Object.fromEntries(u.searchParams.entries());
    if (typeof init.body === "string" || init.body instanceof URLSearchParams) for (const [k, v] of new URLSearchParams(init.body)) params[k] = v;
    const path = u.pathname.replace(/^\/v1\.0/, "");
    st.calls.push({ method, path, params });

    // ---- OAuth (no access token) ----
    if (path === "/oauth/access_token" && method === "POST") return params.code === "bad" ? err("Invalid code", 400) : json({ access_token: "short-token", user_id: "u1" });
    if (path === "/access_token") return json({ access_token: "long-token", token_type: "bearer", expires_in: 5184000 });
    if (path === "/refresh_access_token") { st.refreshes++; return json({ access_token: "refreshed-token", expires_in: 5184000 }); }

    if (st.rejectToken && params.access_token === st.rejectToken) return err("Error validating access token: Session has expired", 190);

    if (path === "/me" && method === "GET") return json({ id: "u1", username: st.username });
    if (path === "/me/threads" && method === "GET") {
      if (params.since && st.rejectSince) return err("(#100) Invalid parameter: since", 100, "GraphMethodException");
      const since = params.since ? Number(params.since) * 1000 : 0;
      const all = st.live.filter((p) => Date.parse(p.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) >= since);
      if (!st.pageSize) return json({ data: all, paging: {} });
      const start = Number(params.after ?? 0);
      const slice = all.slice(start, start + st.pageSize);
      return json({ data: slice, paging: start + st.pageSize < all.length ? { cursors: { after: String(start + st.pageSize) } } : {} });
    }
    if (path === "/me/threads_insights") return st.followers === undefined ? err("not available", 100) : json({ data: [{ name: "followers_count", total_value: { value: st.followers } }] });
    if (path === "/me/threads" && method === "POST") {
      const id = `c${++st.seq}`;
      st.containers.set(id, params);
      return json({ id });
    }
    if (path === "/me/threads_publish" && method === "POST") {
      if (st.publishFailures > 0) { st.publishFailures--; return err("An unexpected error has occurred", 2, "OAuthException", 500); }
      const c = st.containers.get(params.creation_id);
      if (!c) return err("Container not found", 24);
      const id = `t${++st.seq}`;
      st.live.unshift({ id, text: c.text ?? "", timestamp: metaTs(new Date().toISOString()), permalink: `https://www.threads.net/@${st.username}/post/${id}`, media_type: c.media_type === "TEXT" ? "TEXT_POST" : c.media_type, reply_to: c.reply_to_id, topic_tag: c.topic_tag });
      return json({ id });
    }
    const rp = path.match(/^\/([^/]+)\/replies$/);
    if (rp && method === "GET") {
      if (st.repliesDenied) return err("(#10) Application does not have permission for this action: threads_read_replies", 10);
      return json({ data: st.replies[rp[1]] ?? [] });
    }
    const m = path.match(/^\/([^/]+)(\/insights)?$/);
    if (m) {
      const id = m[1];
      if (m[2]) {
        if (st.insightFail.has(id)) return err("(#10) Insights are unavailable for this post", 10);
        const v = { ...defaults, ...(st.metrics[id] ?? {}) };
        return json({ data: [
          { name: "views", values: [{ value: v.views }] },
          { name: "likes", total_value: { value: v.likes } },
          { name: "replies", total_value: { value: v.replies } },
          { name: "reposts", total_value: { value: v.reposts } },
          { name: "quotes", total_value: { value: v.quotes } },
          { name: "shares", total_value: { value: v.shares } },
        ] });
      }
      if (method === "GET" && st.containers.has(id)) {
        if (st.containerDelays > 0) { st.containerDelays--; return json({ id, status: "IN_PROGRESS" }); }
        return json({ id, status: "FINISHED" });
      }
      const post = st.live.find((p) => p.id === id);
      if (method === "GET") return post ? json({ id, permalink: post.permalink }) : err("Unsupported get request", 100);
      if (method === "DELETE") {
        if (st.deleteDenied) return err("(#10) Application does not have permission for this action", 10);
        if (!post) return err("Unsupported delete request", 100);
        st.live = st.live.filter((p) => p.id !== id);
        return json({ success: true, deleted_id: id });
      }
    }
    return err(`unhandled ${method} ${path}`, 100, "GraphMethodException", 404);
  }

  return {
    fetch: fetch as typeof globalThis.fetch,
    state: st,
    /** Seed one live post. `at` is a normal ISO string. */
    addPost(id: string, text: string, at: string, metrics?: Record<string, number>, shortcode?: string) {
      st.live.push({ id, text, timestamp: metaTs(at), permalink: `https://www.threads.com/@${st.username}/post/${shortcode ?? id}`, media_type: "TEXT_POST" });
      st.live.sort((a, b) => Date.parse(b.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) - Date.parse(a.timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")));
      if (metrics) st.metrics[id] = metrics;
    },
    calls: (method: string, path: RegExp | string) => st.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))),
    reset() { st.live = []; st.metrics = {}; st.insightFail.clear(); st.containers.clear(); st.calls = []; st.seq = 0; st.publishFailures = 0; st.containerDelays = 0; st.rejectToken = ""; st.followers = 321; st.pageSize = 0; st.rejectSince = false; st.refreshes = 0; st.deleteDenied = false; st.repliesDenied = false; st.replies = {}; },
  };
}
export type FakeThreads = ReturnType<typeof createFakeThreads>;
