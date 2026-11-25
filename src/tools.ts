// The connector's tools. Claude is the brain: the server hands it context (studio_brief), validates and performs actions,
// and renders results as one widget (ui://studio/threads-v<N>.html). Nothing here writes a post by itself.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { lintPost } from "./lint.js";
import { addDays, baseline, bestWindows, DOW, engagement, features, heatmap, hookOf, hookStats, hookType, mytDate, mytParts, rankWinners, suggestSlots, tracker } from "./metrics.js";
import type { Payload, PhotoOut, PostOut, QueueRow, Rec } from "./payload.js";
import { fetchImage } from "./fetch-image.js";
import { gradeImage, isNeutral, PRESET_NAMES, resolveGrade, toThreadsFormat } from "./grade.js";
import { blobConfigured, MAX_BYTES, removePhoto, savePhoto, cleanEditUrl, sniff, urlsFor } from "./photos.js";
import { ANGLES, effective } from "./playbook.js";
import { duplicateOf, findByRef, freshen, fromQueue, invalidate, loadPosts } from "./posts.js";
import { maybeTick, newQueueItem, runItem } from "./scheduler.js";
import { backend, durable, load, storageLatencyMs, update } from "./store.js";
import * as threads from "./threads.js";
import * as zernio from "./zernio.js";
import { StudioError, type Photo, type Post, type QueueItem, type State } from "./types.js";
import { UI_HTML } from "./ui-html.generated.js";

// The card gets a NEW address whenever it changes, so an app that saved the old card cannot keep showing it. The old
// address stays registered and serves the same new card, for apps that still hold an old saved tool list.
export const CARD_VERSION = "9";
const RESOURCE_URI = `ui://studio/threads-v${CARD_VERSION}.html`;
const LEGACY_URIS = ["ui://studio/threads.html", "ui://studio/threads-v4.html", "ui://studio/threads-v5.html", "ui://studio/threads-v6.html", "ui://studio/threads-v7.html", "ui://studio/threads-v8.html"];
const ui = { _meta: { ui: { resourceUri: RESOURCE_URI } } };
const DAILY_CAP = 250; // Threads' own limit is 250 API posts per 24 hours; this is only a brake against a runaway loop

type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (text: string, payload?: Payload): Result => ({ content: [{ type: "text", text }], ...(payload ? { structuredContent: payload as unknown as Record<string, unknown> } : {}) });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

export const fmt = (iso: string) => {
  const p = mytParts(iso);
  return `${DOW[p.dow]} ${p.date.slice(8)}/${p.date.slice(5, 7)} ${String(p.hour).padStart(2, "0")}:${String(new Date(Date.parse(iso) + 8 * 3600_000).getUTCMinutes()).padStart(2, "0")} MYT`;
};

const photoOut = (p: Photo): PhotoOut => ({ id: p.id, url: p.url, name: p.name, desc: p.desc, editUrl: p.editUrl, size: p.size, uploadedAt: p.uploadedAt });
const bank = (s: { photos: Record<string, Photo> }): PhotoOut[] => Object.values(s.photos).sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt)).map(photoOut);
const queueRows = (posts: Post[]): QueueRow[] =>
  posts.filter((p) => p.status === "scheduled" || p.status === "draft" || p.status === "failed")
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((p) => ({ id: p.id, status: p.status as QueueRow["status"], at: p.status === "draft" ? undefined : p.at, hook: hookOf(p.text), error: p.error, photos: p.media }));

const postOut = (p: Post): PostOut => ({ id: p.id, text: p.text, hook: hookOf(p.text), at: p.at, status: p.status, url: p.url, topic: p.topic, metrics: p.metrics, metricsKnown: p.metricsKnown, leads: p.leads, source: p.source });

/** "2026-11-25T19:30" without an offset means Malaysia time. */
export function parseWhen(s: string): number {
  const t = s.trim();
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : t.replace(" ", "T") + "+08:00";
  return Date.parse(withZone);
}

async function guard<T>(fn: () => Promise<T>): Promise<T | Result> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof StudioError) return fail(e.message);
    return fail(`Ralat tak dijangka: ${(e as Error).message}`);
  }
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "Threads Studio", version: "0.1.0" },
    {
      instructions:
        "Threads studio for the connected Threads account. You are the brain and nothing here limits you: write whatever the owner asks for, in any shape (one post or many, 20 or 50 if the owner says so, a thread, a list, a story, long or short, any language, any angle, any tone). This connector only keeps their data (posts, numbers, queue, pictures, notes), runs actions and shows helpful cards. Its playbook is their own notes: context, never a limit. The only real limits are Threads' own: max 500 characters per post (use parts for a thread), a topic label is 1-50 characters without '.' or '&', and you never publish live unless the owner clearly says to post. When the owner asks what to post or for ideas, call studio_brief to get their data, write the posts yourself, then let them review and edit them with show_recommendations (any number) or save many at once with create_posts. Never invent facts or numbers. FINDING POSTS: when the owner points at a post (a Threads link, a short code, 'post tadi', 'yang baru tu') or asks which posts have comments, call find_posts first. It accepts Threads links, reads fresh from Threads, and returns the id, time, hook and live numbers including replies (komen). To read what the comments say, call get_replies. Never guess an id, and never tell the owner to delete or check something in the Threads app unless a tool actually failed; if it failed, quote the exact error. DELETING: before calling remove_post or remove_photo, tell the owner in plain words exactly what will be deleted (the hook or picture name, and whether it is a draft, scheduled, or LIVE on Threads, which cannot be undone) and wait for a clear yes in chat; only then call it, with confirm_delete=true for a live post. Never delete several things from one vague request. To delete several drafts or scheduled posts at once use remove_posts after one clear yes that covers that list. PICTURES: whenever the owner wants to upload, add or attach a picture (including when the owner attaches one in the chat, which cannot be passed to this connector), call list_photos IMMEDIATELY. Its card has a big Upload button plus drag-and-drop and paste (Ctrl+V), so the owner uploads right there in the chat. If the picture is for a new post, write the post and show it with show_recommendations: every post card has its own 'Upload gambar' button and takes dropped or pasted pictures. Tell them in one short line, e.g. 'Tekan Upload gambar kat kad tu, atau seret / tampal gambar terus.' NEVER lead with photo_upload_link or any web link: use it only if the owner says the card upload does not work or the owner asks for a link. Never pretend you attached a picture. STUDIO TAB: the card's Studio tab is the owner's own workspace, not a request. Do NOT write posts, suggest ideas or make posters on your own; do it only when the owner asks (in chat or with its Tulis post / Poster Canva buttons). POSTER WITH CANVA: when the owner asks for a poster or image (for a post, or from a card's Poster Canva button), use the Canva connector if it is switched on: ask in one line only for what you really need (the words on it, the mood; default portrait 1080x1350), create the design, show them the result and the design's edit link, and let them tweak it in Canva themselves or tell you what to change (apply it with Canva's edit tools). Never export or save over their design before the owner says it is good. When the owner says it is good: export it as PNG with Canva's export-design, then call photo_from_url with the export download link AND edit_url set to the design's edit link, then tell them in one line to tap 'Pilih dari bank' on the card in the Studio tab and pick it (or attach it yourself with photo_ids when the owner asked you to create the post). If the owner tweaks the design again later, export again, call photo_from_url again (same edit_url), and swap the picture on any draft or scheduled post with edit_post (full photo_ids list); only offer to delete the old picture, and only after a clear yes. Threads cannot edit a post that is already live. Export download links expire, so save the picture to the bank right after exporting. To use a bank picture inside Canva, give its url (list_photos shows each picture's url) to Canva's upload-asset-from-url. Canva cannot colour-grade a photo (it has no brightness, saturation or warmth edit), so for ANY colour grading call grade_photo: it saves a graded copy and returns a preview image you can look at. To add or swap a picture on a post that is already a draft or scheduled, call edit_post with the full photo_ids list; never delete and recreate it. A post already live on Threads cannot be edited. If Canva is not switched on in this chat, tell the owner: open + then Connectors and switch Canva on (Customize > Connectors > Canva > Connect if it was never connected).",
    },
  );

  // ---- feed the brain ---------------------------------------------------------------------------
  server.registerTool(
    "studio_brief",
    {
      title: "Brief untuk cadang post",
      description:
        "Get the owner's DATA before writing posts for them: their goal vs posts made, their own recent posts, their winners and how hook types perform, best times, lessons the owner saved, and their own playbook notes. It is data and context only, never rules: write whatever the owner asks for, in any shape and any number, then show it with show_recommendations or save it with create_posts.",
      inputSchema: { focus: z.string().optional().describe("Optional topic or situation the owner mentioned, e.g. 'client baru siap' or 'missed calls'") },
      annotations: { readOnlyHint: true },
    },
    async ({ focus }) => guard(async () => {
      const now = new Date();
      await maybeTick(now);
      const [{ posts, notes }, state] = await Promise.all([loadPosts(), load()]);
      const pb = effective(state.playbookEdits, state.removed);
      const t = tracker(posts, now, state.settings.goalPerDay);
      const published = posts.filter((p) => p.status === "published");
      const own = published.filter((p) => p.source === "native").slice(0, 20);
      const grid = heatmap(published);
      const winners = rankWinners(published, now, 5);
      const angleUse: Record<string, number> = {};
      const since = addDays(mytDate(now), -14);
      for (const q of Object.values(state.queue)) if (q.angle && q.createdAt.slice(0, 10) >= since) angleUse[q.angle] = (angleUse[q.angle] ?? 0) + 1;
      const hooksSeen = [...posts.slice(0, 15).map((p) => hookOf(p.text)), ...state.recHistory.slice(-4).flatMap((r) => r.hooks)];
      const stats = hookStats(published, now);
      const brief = {
        instruction:
          "This is data, not rules. Write exactly what the owner asked for, in whatever shape fits: one post or many (any number), a thread, a list, a story, long or short, any language and angle. playbook (angles, pillars, voice, facts) is their own notes: use it when it helps, go beyond it when the request does. Real limits only: 500 characters per post (use parts for a thread), topic label 1-50 characters without '.' or '&'. Use only facts from playbook.facts or ones the owner gives you; ask if you need one. Do not publish anything unless the owner says to post.",
        focus: focus ?? null,
        now_myt: fmt(now.toISOString()),
        goal: { per_day: t.goal, today: t.today, left_today: t.todayLeft, week: t.week, streak: t.streak, hours_since_last_post: t.hoursSinceLast ?? null, scheduled_next: t.scheduled.slice(0, 5).map((s) => ({ at: fmt(s.at), hook: s.hook })), drafts: t.drafts },
        style_examples: own.map((p) => ({ date: mytDate(p.at), text: p.text.slice(0, 400), views: p.metrics?.views ?? null, likes: p.metrics?.likes ?? null, replies: p.metrics?.replies ?? null, hook_type: hookType(p.text) })),
        recent_hooks: hooksSeen,
        winners: winners.map((w) => ({ id: w.post.id, hook: hookOf(w.post.text), text: w.post.text.slice(0, 300), labels: w.labels, vs_median_views: w.vsViews, vs_median_engagement: w.vsEng, hook_type: w.features.hookType, language: w.features.language, slot: w.features.slot, leads: w.post.leads ?? 0 })),
        hook_stats: stats,
        angles_used_last_14_days: angleUse,
        best_windows: bestWindows(grid, 3),
        saved_insights: state.insights.slice(-10).map((i) => i.text),
        playbook: { angles: ANGLES, pillars: pb.pillars, voice: pb.voice, facts: pb.facts, banned_words: pb.banned },
        default_topic: state.settings.defaultTopic ?? null,
        data_notes: [...notes, ...(backend() === "memory" ? ["Tetapan tak disimpan kekal (Redis belum disambung)."] : [])],
      };
      return ok(JSON.stringify(brief));
    }),
  );

  server.registerTool(
    "lint_post",
    {
      title: "Semak draf post",
      description: "Optional check of a draft against Threads' real limits only: 500 characters per post, a non-empty post, and the topic label rules (1-50 characters, no '.' or '&'). It never judges style. Warnings only list words the owner themselves put on their avoid-list. parts = thread continuation.",
      inputSchema: { text: z.string(), parts: z.array(z.string()).optional(), topic: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ text, parts, topic }) => guard(async () => {
      const state = await load();
      const r = lintPost([text, ...(parts ?? [])], { topic, banned: effective(state.playbookEdits, state.removed).banned });
      return ok(JSON.stringify(r));
    }),
  );

  // ---- widget tools -----------------------------------------------------------------------------
  registerAppTool(
    server,
    "post_tracker",
    {
      title: "Jejak post Threads",
      description: "Show how many Threads posts the owner has made: today vs goal, this week, this month, streak, last 30 days and the scheduled queue. Use for 'berapa post aku', 'dah cukup ke hari ni', 'tunjuk tracker'.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      ...ui,
    },
    async () => guard(async () => {
      const now = new Date();
      await maybeTick(now);
      const [{ posts, notes }, state] = await Promise.all([loadPosts(), load()]);
      const t = tracker(posts, now, state.settings.goalPerDay);
      const slots = suggestSlots(heatmap(posts.filter((p) => p.status === "published")), t.scheduled.map((s) => s.at), now, 3);
      const text = `Hari ni ${t.today}/${t.goal} post${t.todayLeft ? `, kurang ${t.todayLeft}` : " (cukup)"}. Minggu ni ${t.week}/${t.weekGoal}. Bulan ni ${t.month}. Streak ${t.streak} hari${t.todayPending && t.streak ? " (sampai semalam, hari ni belum cukup)" : ""}, terpanjang ${t.longestStreak}. 30 hari: ${t.total30} post. ${t.lastPostAt ? `Post terakhir ${fmt(t.lastPostAt)} (${t.hoursSinceLast} jam lalu).` : "Belum ada post."} Dijadualkan: ${t.scheduled.length}, draf: ${t.drafts}.${notes.length ? " Nota: " + notes.join(" | ") : ""}`;
      return ok(text, { kind: "tracker", data: t, slots, queue: queueRows(posts), notes });
    }),
  );

  const recSchema = z.object({
    angle: z.string().optional().describe("Any label you like for the angle or idea (free text; the playbook ideas are only suggestions)"),
    type: z.string().optional().describe("Optional post type label"),
    hook: z.string().optional().describe("The first line. Defaults to the first line of text."),
    text: z.string().describe("The full post, max 500 characters"),
    parts: z.array(z.string()).optional().describe("Thread continuation posts, each max 500 characters"),
    photo_ids: z.array(z.string()).max(20).optional().describe("Optional picture ids from list_photos to attach (the owner can also add or remove them on the card)"),
    why: z.string().optional().describe("Optional short note to the owner about this post"),
    topic: z.string().optional().describe("Threads topic label (1-50 chars, no '.' or '&')"),
  });

  registerAppTool(
    server,
    "show_recommendations",
    {
      title: "Studio: kad post",
      description: "Show posts you wrote as cards the owner can edit, then Draf / Jadual / Post (or save them all as drafts with one button). Any number: 1, 5, 20 or up to 50, in any shape (single posts, threads, any length or language). The widget does the rest, so do not repeat the full texts in chat; add one short line. Every card has its own 'Upload gambar' button (and takes dropped or pasted pictures), so when the owner wants a picture on a post, show the card and tell them to upload there; never send them to a web link.",
      inputSchema: { recs: z.array(recSchema).min(1).max(50) },
      annotations: { readOnlyHint: false },
      ...ui,
    },
    async ({ recs }) => guard(async () => {
      const now = new Date();
      let posts: Post[] = [];
      try { posts = (await loadPosts()).posts; } catch { /* cards still work without history */ }
      const state = await load();
      const banned = effective(state.playbookEdits, state.removed).banned;
      const out: Rec[] = recs.map((r) => ({
        angle: r.angle ? ANGLES.find((a) => a.id === r.angle!.toLowerCase() || a.name.toLowerCase() === r.angle!.toLowerCase())?.name ?? r.angle : "",
        type: r.type,
        hook: (r.hook ?? hookOf(r.text)).slice(0, 140),
        text: r.text.trim(),
        parts: r.parts?.length ? r.parts : undefined,
        photoIds: (r.photo_ids ?? []).filter((id) => state.photos[id]),
        why: r.why ?? "",
        topic: r.topic ?? state.settings.defaultTopic,
        lint: (() => { const l = lintPost([r.text, ...(r.parts ?? [])], { topic: r.topic ?? state.settings.defaultTopic, banned }); return { errors: l.errors, warnings: l.warnings, chars: l.chars }; })(),
      }));
      await update((s) => { s.recHistory.push({ at: now.toISOString(), hooks: out.map((o) => o.hook) }); s.recHistory = s.recHistory.slice(-20); });
      const sched = posts.filter((p) => p.status === "scheduled").map((p) => p.at);
      const slots = suggestSlots(heatmap(posts.filter((p) => p.status === "published")), sched, now, 3);
      const bad = out.filter((o) => o.lint.errors.length).length;
      const text = `${out.length} post dipaparkan sebagai kad (pemilik boleh edit, Draf, Jadual atau Post, atau simpan semua sebagai draf).${bad ? ` ${bad} kad melebihi had Threads (contoh lebih 500 aksara); betulkan dan paparkan semula.` : ""} Slot cadangan: ${slots.map((s) => s.label).join(" | ") || "tiada"}.`;
      return ok(text, { kind: "recs", recs: out, slots, photos: bank(state), defaultTopic: state.settings.defaultTopic });
    }),
  );

  registerAppTool(
    server,
    "winning_threads",
    {
      title: "Thread yang menang",
      description: "Show the owner's winning Threads posts: ranked by how far they beat their own median in views and engagement (plus leads the owner logged). Each card has a 'Kenapa menang?' button. Use for 'post mana paling menjadi', 'winning threads'.",
      inputSchema: { days: z.number().int().min(7).max(365).optional().describe("Look-back window, default 60"), limit: z.number().int().min(1).max(15).optional() },
      annotations: { readOnlyHint: true },
      ...ui,
    },
    async ({ days, limit }) => guard(async () => {
      const now = new Date();
      const d = days ?? 60;
      const { posts, notes } = await loadPosts({ days: Math.max(d, 60) });
      const since = now.getTime() - d * 86_400_000;
      const pool = posts.filter((p) => p.status === "published" && Date.parse(p.at) >= since);
      const base = baseline(pool);
      const winners = rankWinners(pool, now, limit ?? 8);
      const n = notes.slice();
      if (!winners.length) n.push("Belum ada post dengan nombor tontonan. Threads mungkin belum bagi insights untuk post-post ini.");
      const text = winners.length
        ? `Median ${base.medianViews} tontonan (${base.n} post berangka). Teratas: ` + winners.map((w, i) => `${i + 1}. "${hookOf(w.post.text)}" [id ${w.post.id}] ${w.post.metrics?.views ?? "?"} tontonan (${w.vsViews}x), engage ${w.vsEng}x, hook ${w.features.hookType}${w.labels.length ? ", " + w.labels.join("/") : ""}`).join("; ")
        : n.join(" ");
      return ok(text, { kind: "winners", winners: winners.map((w) => ({ ...w, post: postOut(w.post) })), baseline: base, days: d, notes: n });
    }),
  );

  registerAppTool(
    server,
    "show_post_analysis",
    {
      title: "Kenapa post ni menang",
      description: "Show your analysis of WHY one post performed: first call winning_threads (or use studio_brief winners) to get the post id and numbers, think about the hook, structure, language, timing and audience, then call this with your read. The server adds the computed facts (hook type, length, language, slot, vs their median).",
      inputSchema: {
        post_id: z.string(),
        hook_type: z.string().optional().describe("Your own label for the hook mechanism, e.g. 'kontra + angka'"),
        why: z.array(z.string()).min(1).max(6).describe("Why it worked, one short bullet each, in Malay"),
        reuse: z.array(z.string()).max(5).describe("What the owner can reuse next time"),
        avoid: z.array(z.string()).max(4).optional().describe("What not to copy or overdo"),
      },
      annotations: { readOnlyHint: true },
      ...ui,
    },
    async ({ post_id, hook_type, why, reuse, avoid }) => guard(async () => {
      const { posts } = await loadPosts();
      const post = posts.find((p) => p.id === post_id || p.platformId === post_id);
      if (!post) return fail(`Post "${post_id}" tak dijumpai. Guna id daripada winning_threads.`);
      const base = baseline(posts.filter((p) => p.status === "published"));
      const views = post.metrics?.views ?? 0;
      const vsViews = base.medianViews ? Math.round((views / base.medianViews) * 10) / 10 : 0;
      const er = views > 0 ? engagement(post.metrics) / views : 0;
      const vsEng = base.medianEngRate ? Math.round((er / base.medianEngRate) * 10) / 10 : 0;
      const f = features(post);
      return ok(`Analisis dipaparkan untuk "${f.hook}" (${vsViews}x median tontonan, ${vsEng}x median engagement). Tawarkan 'Simpan pelajaran' dan 'Buat yang serupa'.`, {
        kind: "analysis", post: postOut(post), features: f, vsViews, vsEng, read: { hookType: hook_type, why, reuse, avoid: avoid ?? [] },
      });
    }),
  );

  registerAppTool(
    server,
    "page_analytics",
    {
      title: "Analitik page",
      description: "Show the owner's page: followers, posts, views and engagement for the last N days, the day-by-time heatmap, best posting windows and how each hook type performs. Use for 'macam mana page aku', 'waktu terbaik post', 'analitik'.",
      inputSchema: { days: z.number().int().min(7).max(90).optional().describe("Default 30") },
      annotations: { readOnlyHint: true },
      ...ui,
    },
    async ({ days }) => guard(async () => {
      const now = new Date();
      const d = days ?? 30;
      const { posts, notes } = await loadPosts({ days: Math.max(d, 60) });
      const pool = posts.filter((p) => p.status === "published" && Date.parse(p.at) >= now.getTime() - d * 86_400_000);
      const m = pool.filter((p) => p.metricsKnown && p.metrics?.views !== undefined);
      const totalViews = m.reduce((a, p) => a + p.metrics!.views!, 0);
      const base = baseline(pool);
      const grid = heatmap(pool);
      const best = bestWindows(grid, 3);
      let followers: number | undefined;
      try { followers = await threads.followers(await threads.accessToken()); } catch { /* optional */ }
      const hooks = hookStats(pool, now);
      const text = `${d} hari: ${pool.length} post, ${totalViews} tontonan (${m.length} post berangka), purata ${m.length ? Math.round(totalViews / m.length) : 0}, median ${base.medianViews}, engagement ${(base.medianEngRate * 100).toFixed(1)}%. Pengikut: ${followers ?? "tak diketahui"}. Waktu terbaik: ${best.map((b) => `${b.label} (${b.avgViews})`).join(", ") || "belum cukup data"}. Hook: ${hooks.filter((h) => h.n).map((h) => `${h.type} ${h.n}x purata ${h.avgViews}`).join(", ")}.`;
      return ok(text, { kind: "analytics", days: d, followers, posts: pool.length, totalViews, avgViews: m.length ? Math.round(totalViews / m.length) : 0, medianViews: Math.round(base.medianViews), engRate: base.medianEngRate, withMetrics: m.length, grid, best: best.map((b) => ({ label: b.label, n: b.n, avgViews: b.avgViews })), hooks, notes });
    }),
  );

  // ---- creating posts: ONE code path for create_post (one) and create_posts (many) ------------------
  // Two steps so a bulk call is fast: prepareOne() checks a post against a snapshot in memory (no storage calls), and
  // commit() writes every prepared post to storage in ONE update.
  type NewPost = {
    text: string; parts?: string[]; topic?: string; mode: "draft" | "schedule" | "publish"; scheduled_for?: string; confirm_publish?: boolean;
    angle?: string; type?: string; photo_ids?: string[]; media_urls?: string[];
  };
  type Prepared = { ok: true; item: QueueItem; day: string; counted: boolean; msg: string; extra: string; post: Post; warnings: string[]; mode: NewPost["mode"] } | { ok: false; error: string };
  type Ctx = { now: Date; posts: Post[]; state: State; used: Record<string, number>; ids: Set<string> };

  /** Checks ONE post and builds its queue item. Writes nothing. ctx carries what earlier posts in the same batch already took (ids, per-day counts, duplicate texts). */
  function prepareOne(a: NewPost, ctx: Ctx): Prepared {
    const { now, posts, state } = ctx;
    const topic = a.topic ?? state.settings.defaultTopic;
    const parts = [a.text, ...(a.parts ?? [])].map((p) => p.trim());
    const lint = lintPost(parts, { topic, banned: effective(state.playbookEdits, state.removed).banned });
    if (!lint.ok) return { ok: false, error: "Tak boleh cipta: " + lint.errors.join(" ") };

    if (a.mode === "publish" && a.confirm_publish !== true) return { ok: false, error: "mode=publish perlukan confirm_publish=true, dan hanya selepas pemilik jelas minta post sekarang. Guna 'draft' atau 'schedule' kalau tak pasti." };
    let when: number | undefined;
    if (a.mode === "schedule") {
      if (!a.scheduled_for) return { ok: false, error: "mode=schedule perlukan scheduled_for (waktu Malaysia)." };
      when = parseWhen(a.scheduled_for);
      if (Number.isNaN(when)) return { ok: false, error: `scheduled_for "${a.scheduled_for}" bukan masa yang sah. Contoh: 2026-11-25T19:30` };
      if (when < now.getTime() + 10 * 60_000) return { ok: false, error: "Jadual mesti sekurang-kurangnya 10 minit dari sekarang." };
      if (when > now.getTime() + 60 * 86_400_000) return { ok: false, error: "Jadual terlalu jauh (maksimum 60 hari)." };
    }
    const dup = duplicateOf(posts, parts[0], a.mode, now);
    if (dup) return { ok: false, error: `Teks yang sama sudah ada (${dup.status}, ${fmt(dup.at)}). Tak cipta lagi sekali supaya tak double post.` };

    const day = mytDate(when ?? now.getTime());
    const counted = a.mode !== "draft";
    if (counted && (ctx.used[day] ?? state.publishLog[day] ?? 0) >= DAILY_CAP) return { ok: false, error: `Had ${DAILY_CAP} post sehari melalui connector untuk ${day} dah sampai (had Threads sendiri ialah 250 sehari).` };

    // The id is derived from the content, so a retried call cannot create a second queue entry.
    const whenIso = when ? new Date(when).toISOString() : undefined;
    const id = "q_" + createHash("sha256").update([parts.join("\n--\n"), topic ?? "", a.mode, whenIso ?? mytDate(now)].join("\u0001")).digest("hex").slice(0, 12);
    const existing = state.queue[id];
    if ((existing && existing.status !== "failed") || ctx.ids.has(id)) return { ok: false, error: `Sudah ada dalam queue (${existing?.status ?? "dalam kumpulan ini"}). Tak cipta lagi sekali.` };

    const mediaUrls = [...new Set([...urlsFor(state, a.photo_ids ?? []), ...(a.media_urls ?? [])])].slice(0, 20);
    const item = newQueueItem({
      id, parts, topic, mediaUrls: mediaUrls.length ? mediaUrls : undefined, angle: a.angle, type: a.type, scheduledFor: whenIso,
      status: a.mode === "publish" ? "publishing" : a.mode === "schedule" ? "scheduled" : "draft",
      lockedAt: a.mode === "publish" ? now.toISOString() : undefined,
    }, now);

    let msg: string;
    let extra = "";
    if (a.mode === "publish") msg = "Dah post ke Threads.";
    else if (a.mode === "schedule") {
      msg = `Dijadualkan ${fmt(whenIso!)}.`;
      const ping = state.lastPingAt ? now.getTime() - Date.parse(state.lastPingAt) : Infinity;
      if (ping > 15 * 60_000) extra = " Amaran: penjadual (/tick) belum berjalan dalam 15 minit lepas. Post hanya keluar bila awak guna Claude selepas masa itu, dan kalau lewat lebih 3 jam ia tak dipost. Pasang pemasa (buka halaman /setup pada alamat connector awak untuk semak).";
    } else msg = "Draf disimpan (dalam connector, belum di Threads). Guna Jadual atau Post bila sedia.";

    ctx.ids.add(id);
    if (counted) ctx.used[day] = (ctx.used[day] ?? state.publishLog[day] ?? 0) + 1;
    return { ok: true, item, day, counted, msg, extra, post: { ...fromQueue(item), source: "studio", text: parts[0] }, warnings: lint.warnings, mode: a.mode };
  }

  /** Writes prepared posts in ONE storage update. Returns the ids that could not be written because the same post appeared meanwhile. */
  async function commit(preps: Extract<Prepared, { ok: true }>[]): Promise<Set<string>> {
    const clash = new Set<string>();
    if (!preps.length) return clash;
    await update((s) => {
      clash.clear(); // this function may run again on a fresh state
      for (const p of preps) {
        const cur = s.queue[p.item.id];
        if (cur && cur.status !== "failed") { clash.add(p.item.id); continue; }
        s.queue[p.item.id] = p.item;
        if (p.counted) s.publishLog[p.day] = (s.publishLog[p.day] ?? 0) + 1;
      }
    });
    invalidate();
    return clash;
  }

  const newCtx = async (now: Date, posts: Post[]): Promise<Ctx> => ({ now, posts: [...posts], state: await load(), used: {}, ids: new Set() });

  type Made = { ok: true; msg: string; extra: string; post: Post; warnings: string[] } | { ok: false; error: string };
  /** Creates ONE post (and publishes it when mode is publish). */
  async function createOne(a: NewPost, base: { now: Date; posts: Post[] }): Promise<Made> {
    const p = prepareOne(a, await newCtx(base.now, base.posts));
    if (!p.ok) return p;
    if ((await commit([p])).size) return { ok: false, error: "Sudah ada dalam queue. Tak cipta lagi sekali." };
    if (p.mode !== "publish") return { ok: true, msg: p.msg, extra: p.extra, post: p.post, warnings: p.warnings };
    const done = await runItem(p.item.id, base.now);
    invalidate();
    if (done.status !== "published") return { ok: false, error: `Gagal post: ${done.error ?? "tak diketahui"}` };
    return { ok: true, msg: p.msg, extra: done.error ? ` Amaran: ${done.error}` : "", post: { ...fromQueue(done), source: "studio", text: p.item.parts[0] }, warnings: p.warnings };
  }

  // ---- actions ----------------------------------------------------------------------------------
  registerAppTool(
    server,
    "create_post",
    {
      title: "Cipta post Threads",
      description:
        "Create a Threads post as a draft, a scheduled post, or publish now. Default to 'draft' or 'schedule'. mode 'publish' goes live on their public account immediately, so set confirm_publish=true ONLY if the owner clearly said to post it now in this conversation. Max 500 characters per post; `parts` makes a thread. scheduled_for is Malaysia time (e.g. 2026-11-25T19:30). Drafts and schedules are kept by this connector (Threads has none); scheduled posts go out through its /tick scheduler.",
      inputSchema: {
        text: z.string().describe("The post, max 500 characters"),
        parts: z.array(z.string()).optional().describe("Thread continuation, each max 500 characters"),
        topic: z.string().optional().describe("Threads topic label (1-50 chars, no '.' or '&')"),
        mode: z.enum(["draft", "schedule", "publish"]),
        scheduled_for: z.string().optional().describe("Required for mode=schedule. ISO time; no offset means Malaysia time"),
        confirm_publish: z.boolean().optional().describe("Must be true for mode=publish"),
        angle: z.string().optional(),
        type: z.string().optional(),
        photo_ids: z.array(z.string()).max(20).optional().describe("Picture ids from the photo bank (list_photos). Pictures the owner uploaded are stored for Meta to fetch. 2 or more make a carousel."),
        media_urls: z.array(z.string().url()).max(20).optional().describe("Other public https image URLs (JPEG/PNG up to 8 MB). Prefer photo_ids."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...ui,
    },
    async (a) => guard(async () => {
      const now = new Date();
      if (a.mode !== "publish" && !durable()) return fail("Draf dan jadual perlukan Redis, tapi Redis belum disambung pada Vercel. Tambah Upstash Redis (buka halaman /setup pada alamat connector awak untuk semak) dulu. Post terus masih boleh.");
      await maybeTick(now);
      const { posts } = await loadPosts({ force: true }); // also proves Threads is connected
      const r = await createOne(a, { now, posts });
      if (!r.ok) return fail(r.error);
      const text = `${r.msg}${r.post.url ? " " + r.post.url : ""}${r.extra}${r.warnings.length ? " Amaran: " + r.warnings.join(" ") : ""}`;
      return ok(text, { kind: "result", ok: true, message: r.msg, post: postOut(r.post) });
    }),
  );

  const bulkItem = z.object({
    text: z.string().describe("The post, max 500 characters"),
    parts: z.array(z.string()).optional().describe("Thread continuation, each max 500 characters"),
    topic: z.string().optional().describe("Threads topic label (1-50 chars, no '.' or '&')"),
    scheduled_for: z.string().optional().describe("Malaysia time, e.g. 2026-11-25T19:30. Required for every item when mode=schedule"),
    angle: z.string().optional(),
    type: z.string().optional(),
    photo_ids: z.array(z.string()).max(20).optional(),
    media_urls: z.array(z.string().url()).max(20).optional(),
  });

  registerAppTool(
    server,
    "create_posts",
    {
      title: "Cipta banyak post sekali gus",
      description:
        "Save MANY posts in ONE call (up to 50): use it whenever the owner asks for several posts, e.g. '20 post untuk minggu depan'. Write them all, then call this once instead of calling create_post over and over. mode 'draft' saves them all as drafts (no times needed). mode 'schedule' needs scheduled_for (Malaysia time) on every item: spread them over the days and times the owner wants. It never publishes live (for that, the owner says so and you call create_post). Each item is checked on its own: one that is too long, a duplicate or too soon is reported by number and does not stop the others. Returns each item's id.",
      inputSchema: { mode: z.enum(["draft", "schedule"]), posts: z.array(bulkItem).min(1).max(50) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...ui,
    },
    async ({ mode, posts: items }) => guard(async () => {
      const now = new Date();
      if (!durable()) return fail("Draf dan jadual perlukan Redis, tapi Redis belum disambung pada Vercel. Tambah Upstash Redis (buka halaman /setup pada alamat connector awak untuk semak) dulu.");
      await maybeTick(now);
      const ctx = await newCtx(now, (await loadPosts({ force: true })).posts);
      const slots: ({ n: number; prep: Extract<Prepared, { ok: true }> } | { n: number; error: string })[] = [];
      for (let i = 0; i < items.length; i++) {
        let r: Prepared;
        try { r = prepareOne({ ...items[i], mode }, ctx); }
        catch (e) { r = { ok: false, error: e instanceof StudioError ? e.message : `Ralat tak dijangka: ${(e as Error).message}` }; }
        if (r.ok) { ctx.posts.unshift(r.post); slots.push({ n: i + 1, prep: r }); } // later items see it, so a duplicate inside one batch is caught
        else slots.push({ n: i + 1, error: r.error });
      }
      const clash = await commit(slots.flatMap((s) => ("prep" in s ? [s.prep] : [])));
      const results: Record<string, unknown>[] = slots.map((s) => {
        const it = items[s.n - 1];
        if ("prep" in s) return clash.has(s.prep.item.id) ? { n: s.n, ok: false, hook: hookOf(it.text), error: "Sudah ada dalam queue. Tak cipta lagi sekali." } : { n: s.n, ok: true, id: s.prep.post.id, hook: hookOf(s.prep.post.text), when: it.scheduled_for ?? null };
        return { n: s.n, ok: false, hook: hookOf(it.text), error: s.error };
      });
      const done = results.filter((r) => r.ok).length;
      const failed = results.length - done;
      const state = await load();
      const ping = state.lastPingAt ? now.getTime() - Date.parse(state.lastPingAt) : Infinity;
      const timer = mode === "schedule" && done && ping > 15 * 60_000 ? " Amaran: penjadual (/tick) belum berjalan dalam 15 minit lepas, jadi post hanya keluar bila pemilik guna Claude selepas masanya (dan tak dipost kalau lewat lebih 3 jam)." : "";
      const msg = `${done} daripada ${results.length} ${mode === "draft" ? "disimpan sebagai draf" : "dijadualkan"}${failed ? `, ${failed} gagal` : ""}.`;
      return ok(`${msg}${timer} ${JSON.stringify(results)}`, { kind: "result", ok: failed === 0, message: msg });
    }),
  );

  server.registerTool(
    "list_scheduled",
    {
      title: "Senarai dijadual, draf dan gagal",
      description: "List scheduled posts, drafts and failed ones with their ids (needed for reschedule_post and remove_post).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => {
      await maybeTick();
      const { posts } = await loadPosts({ force: true });
      const rows = posts.filter((p) => p.status === "scheduled" || p.status === "draft" || p.status === "failed").map((p) => ({ id: p.id, status: p.status, at: p.status === "draft" ? null : fmt(p.at), hook: hookOf(p.text), chars: [...p.text].length, error: p.error ?? null }));
      return ok(JSON.stringify(rows));
    }),
  );

  server.registerTool(
    "find_posts",
    {
      title: "Cari post di Threads",
      description:
        "Look up LIVE Threads posts of the connected account without guessing. Give refs = Threads links (e.g. https://www.threads.com/@username/post/DgHfKpkleHF), short codes or ids; or contains = words in the text; or neither for the latest posts. It always reads fresh from Threads (not cached) and returns for each post the numeric id (needed by show_post_analysis), link, time, hook, and live numbers: views, likes, replies (komen), reposts, quotes. has_replies tells which posts already have comments. Use it before remove_post or whenever the owner points at a post or asks which posts have comments.",
      inputSchema: {
        refs: z.array(z.string()).max(10).optional().describe("Threads links, short codes or ids"),
        contains: z.string().optional().describe("Words that appear in the post text"),
        limit: z.number().int().min(1).max(30).optional().describe("How many latest posts when no refs/contains (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ refs, contains, limit }) => guard(async () => {
      await maybeTick();
      const { posts, notes } = await loadPosts({ force: true, days: 90 });
      const live = posts.filter((p) => p.status === "published");
      const notFound: string[] = [];
      let picked: Post[] = [];
      if (refs?.length) {
        for (const r of refs) {
          const p = findByRef(live, r);
          if (!p) notFound.push(r);
          else if (!picked.includes(p)) picked.push(p);
        }
      } else if (contains?.trim()) {
        const needle = contains.trim().toLowerCase();
        picked = live.filter((p) => p.text.toLowerCase().includes(needle)).slice(0, limit ?? 10);
      } else picked = live.slice(0, limit ?? 10);
      const f = await freshen(picked);
      const rows = f.posts.map((p) => ({
        id: p.id, link: p.url ?? null, posted: fmt(p.at), hook: hookOf(p.text), text: p.text.slice(0, 240), chars: [...p.text].length,
        views: p.metrics?.views ?? null, likes: p.metrics?.likes ?? null, replies: p.metrics?.replies ?? null, reposts: p.metrics?.reposts ?? null, quotes: p.metrics?.quotes ?? null,
        has_replies: p.metrics?.replies === undefined ? null : p.metrics.replies > 0,
        photos: p.media, made_by: p.source === "studio" ? "connector" : "typed in Threads",
      }));
      const out: Record<string, unknown> = { read_from_threads: live.length, posts: rows };
      if (notFound.length) out.not_found = notFound;
      const hints = [...notes];
      if (notFound.length) hints.push(`${notFound.length} rujukan tak dijumpai antara ${live.length} post live (90 hari terakhir) yang Threads bagi. Kalau post tu baru sangat, Threads kadang ambil seminit dua untuk tunjuk; cuba lagi. Jangan teka id.`);
      if (f.failed) hints.push(`Nombor ${f.failed} post tak dapat dibaca (${f.firstError}); has_replies = null bermaksud tak diketahui, bukan tiada.`);
      if (hints.length) out.notes = hints;
      return ok(JSON.stringify(out));
    }),
  );

  server.registerTool(
    "get_replies",
    {
      title: "Baca komen pada post",
      description:
        "Read the comments (replies) under ONE of the owner's live posts: who wrote them, the text and when. post = Threads link, short code or id (find_posts gives them). Read only: it never replies, hides or deletes anything. Use it for 'siapa komen?', 'apa orang cakap pada post tu?', or to judge why a post got comments.",
      inputSchema: { post: z.string().describe("Threads link, short code or id"), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ post, limit }) => guard(async () => {
      const { posts } = await loadPosts({ force: true, days: 90 });
      const p = findByRef(posts, post);
      if (!p) return fail(`Tak jumpa post "${post}" antara post live pemilik (90 hari terakhir). Guna find_posts dulu. Jangan teka id.`);
      const list = await threads.replies(await threads.accessToken(), p.id, limit ?? 50);
      const me = (await load()).threads?.username?.toLowerCase();
      return ok(JSON.stringify({
        post: { id: p.id, link: p.url ?? null, posted: fmt(p.at), hook: hookOf(p.text) },
        reply_count: list.length,
        replies: list.map((r) => ({ from: r.from ? `@${r.from}` : "?", by_owner: Boolean(me && r.from.toLowerCase() === me), text: r.text, posted: fmt(r.at), link: r.link ?? null, has_replies_below: r.hasReplies, hidden: r.hidden })),
        note: list.length ? undefined : "Tiada komen (atau Threads belum tunjuk lagi).",
      }));
    }),
  );

  server.registerTool(
    "reschedule_post",
    {
      title: "Tukar masa jadual",
      description: "Move a scheduled post, turn a draft into a scheduled post, or reschedule a failed one, to a new Malaysia-time slot. Get ids from list_scheduled.",
      inputSchema: { post_id: z.string(), scheduled_for: z.string().describe("ISO time; no offset means Malaysia time") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ post_id, scheduled_for }) => guard(async () => {
      const now = new Date();
      const when = parseWhen(scheduled_for);
      if (Number.isNaN(when)) return fail("Masa tak sah.");
      if (when < now.getTime() + 10 * 60_000) return fail("Jadual mesti sekurang-kurangnya 10 minit dari sekarang.");
      if (when > now.getTime() + 60 * 86_400_000) return fail("Jadual terlalu jauh (maksimum 60 hari).");
      const state = await load();
      const q = state.queue[post_id];
      if (!q) return fail("Post tak dijumpai dalam draf/jadual. Guna id daripada list_scheduled.");
      if (q.status !== "scheduled" && q.status !== "draft" && q.status !== "failed") return fail(`Post berstatus ${q.status}; hanya draf, jadual atau yang gagal boleh dijadual semula.`);
      const day = mytDate(when);
      if (q.status !== "scheduled" && (state.publishLog[day] ?? 0) >= DAILY_CAP) return fail(`Had ${DAILY_CAP} post sehari melalui connector untuk ${day} dah sampai.`);
      const iso = new Date(when).toISOString();
      await update((s) => {
        const item = s.queue[post_id];
        if (item.status !== "scheduled") s.publishLog[day] = (s.publishLog[day] ?? 0) + 1;
        Object.assign(item, { status: "scheduled", scheduledFor: iso, attempts: 0, error: undefined, nextAttemptAt: undefined, lockedAt: undefined });
      });
      invalidate();
      return ok(`Dijadualkan semula ke ${fmt(iso)}.`);
    }),
  );

  registerAppTool(
    server,
    "edit_post",
    {
      title: "Ubah draf atau post dijadual",
      description:
        "Change a draft, scheduled or failed post IN PLACE: its text, thread parts, topic, pictures, or (scheduled posts only) its time. Only the fields you pass change. photo_ids REPLACES the whole picture list ([] removes all pictures), so include the pictures it already has plus the new one. Use this to add or swap a picture on an existing post: never delete and recreate it. post_id comes from list_scheduled. A post already LIVE on Threads cannot be edited (Threads has no edit); it can only be deleted.",
      inputSchema: {
        post_id: z.string().describe("Queue id from list_scheduled"),
        text: z.string().optional().describe("New post text, max 500 characters"),
        parts: z.array(z.string()).optional().describe("New thread continuation (replaces the old parts)"),
        topic: z.string().optional().describe("New Threads topic label; empty string removes it"),
        photo_ids: z.array(z.string()).max(20).optional().describe("The complete list of bank pictures for this post"),
        media_urls: z.array(z.string().url()).max(20).optional().describe("Other public https image URLs; with photo_ids they form the complete list"),
        scheduled_for: z.string().optional().describe("New time for a SCHEDULED post, Malaysia time (e.g. 2026-11-25T19:30)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      ...ui,
    },
    async (a) => guard(async () => {
      const now = new Date();
      const state = await load();
      const q = state.queue[a.post_id];
      if (!q) return fail("Post tak dijumpai dalam draf/jadual. Guna id daripada list_scheduled. (Post yang sudah live di Threads tak boleh diubah; ia hanya boleh dipadam.)");
      if (q.status === "publishing") return fail("Post ni sedang dipost. Tunggu sebentar dan semak list_scheduled.");
      if (q.status === "published") return fail("Post ni sudah live di Threads dan Threads tak benarkan edit. Hanya boleh dipadam.");
      if ([a.text, a.parts, a.topic, a.photo_ids, a.media_urls, a.scheduled_for].every((v) => v === undefined)) return fail("Tiada apa untuk diubah. Beri sekurang-kurangnya satu medan.");

      const textChanged = a.text !== undefined || a.parts !== undefined;
      const parts = textChanged ? [(a.text ?? q.parts[0]).trim(), ...(a.parts ?? q.parts.slice(1)).map((p) => p.trim())] : q.parts;
      const topic = a.topic !== undefined ? a.topic.trim() || undefined : q.topic;
      let mediaUrls = q.mediaUrls;
      if (a.photo_ids !== undefined || a.media_urls !== undefined) {
        const urls = [...new Set([...urlsFor(state, a.photo_ids ?? []), ...(a.media_urls ?? [])])].slice(0, 20);
        mediaUrls = urls.length ? urls : undefined;
      }
      let whenIso = q.scheduledFor;
      if (a.scheduled_for !== undefined) {
        if (q.status !== "scheduled") return fail(`Post ni berstatus ${q.status}, tiada masa untuk diubah di sini. Guna reschedule_post untuk jadualkannya.`);
        const when = parseWhen(a.scheduled_for);
        if (Number.isNaN(when)) return fail(`scheduled_for "${a.scheduled_for}" bukan masa yang sah. Contoh: 2026-11-25T19:30`);
        if (when < now.getTime() + 10 * 60_000) return fail("Jadual mesti sekurang-kurangnya 10 minit dari sekarang.");
        if (when > now.getTime() + 60 * 86_400_000) return fail("Jadual terlalu jauh (maksimum 60 hari).");
        whenIso = new Date(when).toISOString();
      }

      const { posts } = await loadPosts({ force: true });
      if (textChanged || a.topic !== undefined) {
        const lint = lintPost(parts, { topic, banned: effective(state.playbookEdits, state.removed).banned });
        if (!lint.ok) return fail("Tak boleh ubah: " + lint.errors.join(" "));
      }
      if (textChanged) {
        const dup = duplicateOf(posts.filter((p) => p.id !== q.id), parts[0], q.status === "draft" ? "draft" : "schedule", now);
        if (dup) return fail(`Teks yang sama sudah ada (${dup.status}, ${fmt(dup.at)}). Tak diubah supaya tak double post.`);
      }

      const photosChanged = a.photo_ids !== undefined || a.media_urls !== undefined; // decided before the update, which may share objects with `q`
      const item = await update((s) => {
        const cur = s.queue[a.post_id];
        if (!cur || cur.status === "publishing" || cur.status === "published") throw new StudioError("Post ini baru sahaja berubah (sedang atau sudah dipost). Tak diubah.");
        Object.assign(cur, { parts, topic, mediaUrls, scheduledFor: whenIso, hook: hookOf(parts[0]) });
        return { ...cur };
      });
      invalidate();
      const bits = [textChanged && "teks", a.topic !== undefined && "topik", photosChanged && `gambar (${mediaUrls?.length ?? 0})`, a.scheduled_for !== undefined && `masa ${fmt(whenIso!)}`].filter(Boolean).join(", ");
      const msg = `Dikemas kini: ${bits}.`;
      return ok(msg, { kind: "result", ok: true, message: msg, post: postOut({ ...fromQueue(item), source: "studio", text: parts[0] }) });
    }),
  );

  server.registerTool(
    "remove_post",
    {
      title: "Buang post",
      description: "Delete a draft, scheduled or failed post, or a LIVE Threads post. post_id can be an id from list_scheduled, a Threads id, a Threads link (https://www.threads.com/@username/post/...) or its short code. FIRST tell the owner exactly what will be deleted (use find_posts to see the hook and replies) and get a clear yes in chat. A post that is already LIVE on Threads is removed only when confirm_delete=true, which you may set only after the owner explicitly said yes to deleting that live post (it cannot be undone).",
      inputSchema: { post_id: z.string().describe("Queue id, Threads id, Threads link or short code"), confirm_delete: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ post_id, confirm_delete }) => guard(async () => {
      const state = await load();
      const q = state.queue[post_id];
      if (q) {
        if (q.status === "publishing") return fail("Post ni sedang dipost. Tunggu sebentar dan semak list_scheduled.");
        if (q.status === "published") return fail(`Post ni sudah live. Guna id Threads (${q.threadsId}) dengan confirm_delete=true kalau pemilik jelas minta padam.`);
        await update((s) => { delete s.queue[post_id]; });
        invalidate();
        return ok("Post dibuang daripada draf/jadual.");
      }
      const { posts } = await loadPosts({ force: true, days: 90 });
      const found = findByRef(posts, post_id);
      if (!found) return fail(`Tak jumpa post "${post_id}" antara post live pemilik (90 hari terakhir). Guna find_posts untuk cari dulu; ia terima pautan Threads, kod pendek atau sebahagian teks. Jangan teka id.`);
      const p = (await freshen([found])).posts[0];
      const replies = p.metrics?.replies;
      const label = `"${hookOf(p.text)}" (${fmt(p.at)}, id ${p.id}${replies ? `, ${replies} komen yang akan hilang sekali` : ""})`;
      if (confirm_delete !== true) return fail(`${label} sudah live di Threads. Beritahu pemilik post mana yang akan dipadam, tunggu dia setuju, kemudian panggil semula dengan confirm_delete=true.`);
      await threads.remove(await threads.accessToken(), p.id);
      await update((s) => { delete s.metricsCache[p.id]; for (const [k, item] of Object.entries(s.queue)) if (item.threadsId === p.id) delete s.queue[k]; });
      invalidate();
      return ok(`Post dibuang daripada Threads: ${label}.`);
    }),
  );

  server.registerTool(
    "remove_posts",
    {
      title: "Buang banyak draf / jadual sekali gus",
      description:
        "Delete SEVERAL drafts, scheduled or failed posts in one call (up to 100 queue ids from list_scheduled). It never touches posts that are LIVE on Threads and never touches one being published right now: those are reported and skipped. FIRST tell the owner in plain words what will be deleted (how many, and which ones if the owner did not already name them all) and get a clear yes in chat; a yes to 'padam semua draf' covers the drafts you listed. Use remove_post for a single post, or for a live one.",
      inputSchema: { post_ids: z.array(z.string()).min(1).max(100).describe("Queue ids from list_scheduled") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ post_ids }) => guard(async () => {
      const ids = [...new Set(post_ids)];
      const state = await load();
      const rows = ids.map((id) => {
        const q = state.queue[id];
        if (!q) return { id, ok: false, error: "tak dijumpai dalam draf/jadual" };
        if (q.status === "publishing") return { id, ok: false, hook: q.hook, error: "sedang dipost sekarang" };
        if (q.status === "published") return { id, ok: false, hook: q.hook, error: "sudah live di Threads (guna remove_post dengan confirm_delete)" };
        return { id, ok: true, hook: q.hook, status: q.status };
      });
      const removable = new Set(rows.filter((r) => r.ok).map((r) => r.id));
      if (removable.size) {
        await update((s) => { for (const id of removable) { const q = s.queue[id]; if (q && q.status !== "publishing" && q.status !== "published") delete s.queue[id]; } });
        invalidate();
      }
      const done = removable.size;
      const msg = `${done} daripada ${ids.length} dibuang${ids.length - done ? `, ${ids.length - done} dilangkau` : ""}.`;
      return ok(`${msg} ${JSON.stringify(rows)}`);
    }),
  );

  server.registerTool(
    "connect_threads",
    {
      title: "Sambung / semak Threads",
      description:
        "Check whether the owner's Threads account is connected, and give the one-time link to connect it (or reconnect) through Meta. When the connector runs on Zernio (ZERNIO_API_KEY is set) there is no link: it links the Threads account that is already connected inside Zernio (pass username when Zernio has several). Also reports how many posts were read, how many have numbers, and whether the scheduler pinger is running. Call this when other tools say Threads is not connected, or for 'semak sambungan'.",
      inputSchema: { reconnect: z.boolean().optional().describe("true to get a new connect link even if already connected"), username: z.string().optional().describe("Zernio mode: which Threads account to use when Zernio has several, e.g. @name") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ reconnect, username }) => guard(async () => {
      const now = new Date();
      const state = await load();
      if (threads.zernio() && (reconnect || username || !(await threads.connected()))) await zernio.connect(username, now);
      const isConnected = await threads.connected();
      const info: Record<string, unknown> = { connected: isConnected, app_configured: threads.appConfigured(), storage: backend(), card_version: CARD_VERSION, permissions_asked_on_connect: threads.zernio() ? [] : threads.SCOPES.split(","), backend: threads.zernio() ? "zernio" : "meta" };
      if (isConnected) {
        try {
          const token = await threads.accessToken(now);
          const who = await threads.me(token);
          const { posts, notes } = await loadPosts({ force: true });
          const pub = posts.filter((p) => p.status === "published");
          info.username = who.username;
          info.token_expires = threads.zernio() ? "tiada tarikh luput (kunci API Zernio)" : state.threads?.expiresAt ?? "tak diketahui (token dari env)";
          info.posts_read = pub.length;
          info.posts_with_numbers = pub.filter((p) => p.metricsKnown).length;
          info.followers = (await threads.followers(token)) ?? null;
          info.notes = notes;
        } catch (e) { info.error = (e as Error).message; info.connected = false; }
      }
      info.storage_ms = (await storageLatencyMs().catch(() => undefined)) ?? null; // one Redis round trip from this server
      info.scheduler_last_ping = state.lastPingAt ?? "belum pernah (pasang pemasa: buka halaman /setup)";
      const pingAgo = state.lastPingAt ? Math.max(0, Math.round((now.getTime() - Date.parse(state.lastPingAt)) / 60_000)) : undefined;
      info.scheduler_running = pingAgo !== undefined && pingAgo <= 10; // the timer visits every 1 to 5 minutes; 10 allows for a late visit
      info.scheduler_minutes_since_ping = pingAgo ?? null;
      const waiting = Object.values(state.queue).filter((q) => q.status === "scheduled");
      if (waiting.length && !info.scheduler_running) info.scheduler_warning = `${waiting.length} post dijadual tetapi pemasa tak berjalan, jadi ia TAK akan keluar ikut masa (hanya bila pemilik guna Claude selepas masanya, dan paling lewat 3 jam). Pasang pemasa: buka halaman /setup.`;
      if (threads.zernio()) {
        if (!info.connected) info.fix = "Semak ZERNIO_API_KEY di Vercel dan pastikan akaun Threads dah disambung dalam Zernio (zernio.com, Connections, Threads), kemudian panggil connect_threads semula.";
      } else if (!info.connected || reconnect) {
        if (!threads.appConfigured()) return fail("THREADS_APP_ID dan THREADS_APP_SECRET belum diset di Vercel (buka halaman /setup pada alamat connector awak untuk semak).");
        const nonce = randomBytes(18).toString("hex");
        await update((s) => { s.nonces[nonce] = new Date(now.getTime() + 10 * 60_000).toISOString(); });
        info.connect_link = `${threads.publicUrl()}/connect/${nonce}`;
        info.link_note = "Buka pautan ini dalam browser (sah 10 minit, sekali guna), tekan Allow. Selepas itu panggil connect_threads semula untuk sahkan.";
      }
      return ok(JSON.stringify(info));
    }),
  );

  server.registerTool(
    "mark_result",
    {
      title: "Catat hasil post",
      description: "Log what a post brought in by hand (e.g. 3 DMs or leads) so winners can count real results, not only views. leads is a total, not an increment.",
      inputSchema: { post_id: z.string(), leads: z.number().int().min(0).max(1000).optional(), note: z.string().max(300).optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ post_id, leads, note }) => guard(async () => {
      await update((s) => { s.results[post_id] = { ...s.results[post_id], ...(leads !== undefined ? { leads } : {}), ...(note ? { note } : {}) }; });
      invalidate();
      return ok(`Dicatat untuk post ${post_id}: ${leads !== undefined ? leads + " lead" : ""}${note ? " " + note : ""}.`);
    }),
  );

  server.registerTool(
    "save_insight",
    {
      title: "Simpan pelajaran",
      description: "Save a lesson about what works for the owner's page (e.g. 'hook soalan + angka dapat 2x tontonan'). Saved lessons come back in every studio_brief.",
      inputSchema: { text: z.string().min(5).max(400), post_id: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ text, post_id }) => guard(async () => {
      await update((s) => { s.insights.push({ id: Math.random().toString(36).slice(2, 8), at: new Date().toISOString(), text, postId: post_id }); });
      return ok("Pelajaran disimpan. Akan keluar dalam brief seterusnya.");
    }),
  );

  server.registerTool(
    "set_goal",
    {
      title: "Set sasaran post",
      description: "Set how many posts per day the owner wants to make (default 1) and/or their default Threads topic label.",
      inputSchema: { posts_per_day: z.number().int().min(1).max(100).optional(), default_topic: z.string().max(50).optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ posts_per_day, default_topic }) => guard(async () => {
      if (default_topic) { const e = lintPost(["x"], { topic: default_topic }); if (!e.ok) return fail(e.errors.join(" ")); }
      const s = await update((st) => {
        if (posts_per_day) st.settings.goalPerDay = posts_per_day;
        if (default_topic !== undefined) st.settings.defaultTopic = default_topic || undefined;
        return st.settings;
      });
      return ok(`Sasaran ${s.goalPerDay} post sehari${s.defaultTopic ? `, topik lalai "${s.defaultTopic}"` : ""}.${backend() === "memory" ? " Amaran: Redis belum disambung, tetapan tak kekal." : ""}`);
    }),
  );

  server.registerTool(
    "set_playbook",
    {
      title: "Ubah playbook",
      description: "Add or remove a pillar, voice rule, real fact (a true result or detail Claude may use in posts) or banned word. Use `facts` for real client results and numbers the owner gives you. Only add a fact the owner actually stated.",
      inputSchema: { section: z.enum(["pillars", "voice", "facts", "banned"]), action: z.enum(["add", "remove"]), value: z.string().min(2).max(300) },
      annotations: { readOnlyHint: false },
    },
    async ({ section, action, value }) => guard(async () => {
      await update((s) => {
        const add = (s.playbookEdits[section] ??= []);
        const rem = (s.removed[section] ??= []);
        if (action === "add") { if (!add.includes(value)) add.push(value); s.removed[section] = rem.filter((x) => x !== value); }
        else { s.playbookEdits[section] = add.filter((x) => x !== value); if (!rem.includes(value)) rem.push(value); }
      });
      const pb = effective((await load()).playbookEdits, (await load()).removed);
      return ok(`${section}: ${action === "add" ? "ditambah" : "dibuang"}. Sekarang ${pb[section].length} item.`);
    }),
  );

  // ---- photo bank -------------------------------------------------------------------------------
  // Claude chat attachments cannot be handed to a connector, so pictures come in through the widget's file picker
  // (photo_save, app only) or a one-time upload page (photo_upload_link). Both end in Vercel Blob + the bank.
  registerAppTool(
    server,
    "list_photos",
    {
      title: "Bank gambar",
      description: "THE way the owner uploads pictures. Shows the photo bank as a card with a big Upload button, drag-and-drop and paste (Ctrl+V), thumbnails and delete buttons, so the owner uploads inside the chat. Call it AT ONCE when the owner says 'upload gambar', 'tambah gambar', 'letak gambar', attaches a picture, or asks to see the bank ('tunjuk gambar aku'). Do not send them to a web link instead. Pass the picture ids to create_post (photo_ids) or show_recommendations to attach them.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      ...ui,
    },
    async () => guard(async () => {
      const state = await load();
      const ready = blobConfigured() && durable();
      const note = ready ? undefined : "Storan gambar belum sedia (Vercel Blob dan Redis). Buka halaman /setup untuk semak.";
      const photos = bank(state);
      return ok(`${photos.length} gambar dalam bank${note ? ". " + note : ""}.${photos.length ? " " + photos.slice(0, 20).map((p) => `${p.id} ${p.name} ${p.url}${p.desc ? ` (${p.desc})` : ""}${p.editUrl ? ` [edit: ${p.editUrl}]` : ""}`).join("; ") : ""}${ready ? " Beritahu pemilik: tekan Tambah gambar pada kad, atau seret / tampal (Ctrl+V) gambar terus ke kad. Jangan beri pautan web melainkan butang tak berfungsi." : ""}`, { kind: "photos", photos, ready, note });
    }),
  );

  // Canva (when switched on in the chat) makes posters and exports a PNG/JPG link; this brings that file into the bank.
  registerAppTool(
    server,
    "photo_from_url",
    {
      title: "Simpan gambar dari pautan",
      description:
        "Save a picture from a public https link into the photo bank: the download URL from Canva's export-design, or any image link the owner gives. JPEG/PNG up to 8 MB; WebP/GIF or bigger files are converted automatically. For a Canva poster ALWAYS also pass edit_url (the design's edit link from Canva) so the owner can reopen the design from the card with one tap (Edit di Canva) and tweak it. Returns the picture id to use as photo_ids in create_post, show_recommendations or edit_post. It posts nothing.",
      inputSchema: { url: z.string().url().describe("Public https link to the image"), name: z.string().optional().describe("Short name for the picture"), desc: z.string().optional().describe("Caption, e.g. what the picture shows"), edit_url: z.string().optional().describe("Canva design edit link (https), shown on the card as Edit di Canva") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...ui,
    },
    async ({ url, name, desc, edit_url }) => guard(async () => {
      const editUrl = cleanEditUrl(edit_url); // refuse a bad link before downloading anything
      const buf = await toThreadsFormat(await fetchImage(url), MAX_BYTES, (b) => Boolean(sniff(b)));
      let fallback = "gambar";
      try { fallback = decodeURIComponent(new URL(url).pathname.split("/").pop() || "gambar"); } catch { /* keep the default */ }
      const p = await savePhoto(buf, name?.trim() || fallback.slice(0, 60), desc, editUrl);
      const state = await load();
      return ok(`Gambar disimpan: ${p.id} (${p.name}, ${Math.max(1, Math.round(p.size / 1024))} KB).${p.editUrl ? " Pautan Edit di Canva disimpan pada gambar." : ""} Guna photo_ids [\"${p.id}\"] pada post, atau suruh pemilik tekan Pilih dari bank pada kad di tab Studio.`, { kind: "photos", photos: bank(state), ready: blobConfigured() && durable() });
    }),
  );

  registerAppTool(
    server,
    "grade_photo",
    {
      title: "Colour grade gambar",
      description:
        `Colour-grade a picture from the photo bank and save the result as a NEW picture (the original stays). Canva's tools cannot adjust photo colours, so use this for ANY colour grading request. Give a preset (${PRESET_NAMES.join(", ")}) and/or numbers: exposure, contrast, saturation, warmth, tint (each -1..1), fade, vignette, sharpen (each 0..1); numbers override the preset. It returns a small preview image: LOOK at it and, if needed, adjust once or twice more (grade the ORIGINAL again with new numbers, not the graded copy). Posts nothing.`,
      inputSchema: {
        photo_id: z.string().describe("Picture id from list_photos"),
        preset: z.enum(PRESET_NAMES as [string, ...string[]]).optional(),
        exposure: z.number().min(-1).max(1).optional(), contrast: z.number().min(-1).max(1).optional(), saturation: z.number().min(-1).max(1).optional(),
        warmth: z.number().min(-1).max(1).optional(), tint: z.number().min(-1).max(1).optional(),
        fade: z.number().min(0).max(1).optional(), vignette: z.number().min(0).max(1).optional(), sharpen: z.number().min(0).max(1).optional(),
        name: z.string().optional().describe("Name for the graded copy"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      ...ui,
    },
    async (a) => guard(async () => {
      const state = await load();
      const src = state.photos[a.photo_id];
      if (!src) return fail(`Gambar "${a.photo_id}" tak ada dalam bank. Guna list_photos untuk id yang betul.`);
      const g = resolveGrade(a.preset, { exposure: a.exposure, contrast: a.contrast, saturation: a.saturation, warmth: a.warmth, tint: a.tint, fade: a.fade, vignette: a.vignette, sharpen: a.sharpen });
      if (isNeutral(g)) return fail(`Pilih preset (${PRESET_NAMES.join(", ")}) atau sekurang-kurangnya satu nombor (exposure, contrast, saturation, warmth, tint, fade, vignette, sharpen). Tiada apa untuk diubah.`);
      let original: Buffer;
      try {
        const res = await fetch(src.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(String(res.status));
        original = Buffer.from(await res.arrayBuffer());
      } catch (e) { return fail(`Tak dapat buka gambar asal (${(e as Error).message}).`); }
      const out = await gradeImage(original, g);
      const label = a.preset ?? "grade";
      const used = Object.entries(g).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`).join(", ");
      const p = await savePhoto(out.jpeg, a.name?.trim() || `${src.name.replace(/\.[a-z0-9]+$/i, "")}-${label}`, `Grade ${label} (${used}) daripada ${src.name}`);
      const fresh = await load();
      return {
        content: [
          { type: "text", text: `Siap. Salinan baharu: ${p.id} (${p.name}, ${Math.max(1, Math.round(p.size / 1024))} KB), asal ${src.id} tak diubah. Tetapan: ${used}. Tengok imej pratonton; kalau tak kena, grade gambar ASAL (${src.id}) semula dengan nombor lain. Guna photo_ids ["${p.id}"] pada post.` },
          { type: "image", data: out.preview.toString("base64"), mimeType: "image/jpeg" },
        ],
        structuredContent: { kind: "photos", photos: bank(fresh), ready: blobConfigured() && durable() } as unknown as Record<string, unknown>,
      };
    }),
  );

  server.registerTool(
    "photo_upload_link",
    {
      title: "Pautan muat naik gambar",
      description: "LAST RESORT ONLY. A one-time web page (30 minutes) for uploading pictures outside the chat. Do NOT use it when the owner wants to upload or attach a picture: call list_photos instead, whose card uploads right inside the chat. Use this only if the owner says the card's upload button does not work, or the owner explicitly asks for a link. Afterwards call list_photos.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => guard(async () => {
      if (!blobConfigured()) return fail("Storan gambar (Vercel Blob) belum disambung. Buka halaman /setup untuk semak; tambah Blob (pilih Public) di Vercel > Storage.");
      if (!durable()) return fail("Bank gambar perlukan Redis (buka halaman /setup pada alamat connector awak untuk semak).");
      const nonce = "u_" + randomBytes(18).toString("hex");
      await update((s) => { s.nonces[nonce] = new Date(Date.now() + 30 * 60_000).toISOString(); });
      return ok(JSON.stringify({ upload_link: `${threads.publicUrl()}/upload/${nonce}`, note: "Buka pautan ini dalam browser (sah 30 minit), pilih gambar JPEG atau PNG. Selepas siap, panggil list_photos. Gambar yang dilampirkan terus dalam chat Claude tak boleh dihantar ke connector." }));
    }),
  );

  registerAppTool(
    server,
    "queue_item",
    {
      title: "Buka draf atau post dijadual untuk diubah",
      description: "Used by the widget's Ubah button only: loads one draft, scheduled or failed post as an editable card (text, thread parts, topic, pictures, time).",
      inputSchema: { post_id: z.string() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ post_id }) => guard(async () => {
      const state = await load();
      const q = state.queue[post_id];
      if (!q) return fail("Post tak dijumpai dalam draf/jadual. Mungkin dah dipost atau dipadam.");
      if (q.status === "publishing") return fail("Post ni sedang dipost. Tunggu sebentar.");
      if (q.status === "published") return fail("Post ni sudah live di Threads dan tak boleh diubah.");
      const idByUrl = new Map(Object.values(state.photos).map((p) => [p.url, p.id] as const));
      const photoIds: string[] = [], extraMedia: string[] = [];
      for (const u of q.mediaUrls ?? []) { const id = idByUrl.get(u); if (id) photoIds.push(id); else extraMedia.push(u); }
      const l = lintPost(q.parts, { topic: q.topic, banned: effective(state.playbookEdits, state.removed).banned });
      let slots: ReturnType<typeof suggestSlots> = [];
      try { const { posts } = await loadPosts(); slots = suggestSlots(heatmap(posts.filter((p) => p.status === "published")), posts.filter((p) => p.status === "scheduled").map((p) => p.at), new Date(), 3); } catch { /* the card works without time suggestions */ }
      const rec: Rec = {
        angle: q.angle ?? "", type: q.type, hook: q.hook, text: q.parts[0], parts: q.parts.length > 1 ? q.parts.slice(1) : undefined,
        photoIds, extraMedia: extraMedia.length ? extraMedia : undefined, why: "", topic: q.topic,
        queueId: q.id, status: q.status, scheduledFor: q.scheduledFor,
        lint: { errors: l.errors, warnings: l.warnings, chars: l.chars },
      };
      return ok(`Draf dibuka untuk diubah (${q.status}).`, { kind: "recs", recs: [rec], slots, photos: bank(state), defaultTopic: state.settings.defaultTopic });
    }),
  );

  registerAppTool(
    server,
    "photo_save",
    {
      title: "Simpan gambar (daripada kad)",
      description: "Used by the widget's file picker only: saves one already-compressed JPEG/PNG (base64) into the photo bank.",
      inputSchema: { name: z.string().max(120), data_base64: z.string().max(7_000_000), desc: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ name, data_base64, desc }) => guard(async () => {
      const buf = Buffer.from(data_base64, "base64");
      const photo = await savePhoto(buf, name, desc);
      const state = await load();
      return ok(`Gambar disimpan: ${photo.id}.`, { kind: "photos", photos: bank(state), ready: true });
    }),
  );

  server.registerTool(
    "describe_photo",
    {
      title: "Tulis keterangan gambar",
      description: "Add or change a short description of a picture in the bank (what it shows), so you can pick the right picture for a post later. Ask the owner what the picture is if you do not know. Pass an empty string to clear it. Also lets you set or clear (empty string) edit_url, the Canva design link behind a picture, for pictures saved before that link was kept.",
      inputSchema: { photo_id: z.string(), desc: z.string().max(200).optional(), edit_url: z.string().optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ photo_id, desc, edit_url }) => guard(async () => {
      if (desc === undefined && edit_url === undefined) return fail("Beri desc atau edit_url.");
      const editUrl = edit_url === undefined ? undefined : cleanEditUrl(edit_url) ?? null; // null = clear
      const found = await update((s) => { const p = s.photos[photo_id]; if (!p) return false; if (desc !== undefined) p.desc = desc.trim() || undefined; if (editUrl !== undefined) p.editUrl = editUrl ?? undefined; return true; });
      return found ? ok("Gambar dikemas kini.") : fail("Gambar tak dijumpai dalam bank.");
    }),
  );

  registerAppTool(
    server,
    "remove_photo",
    {
      title: "Padam gambar",
      description: "Delete a picture from the photo bank and from storage. FIRST tell the owner which picture (name, caption) and get a clear yes in chat; the widget's Padam button needs two taps instead. Refused while a draft or scheduled post still uses it. Pictures already on live Threads posts are not affected.",
      inputSchema: { photo_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
      ...ui,
    },
    async ({ photo_id }) => guard(async () => {
      await removePhoto(photo_id);
      const state = await load();
      return ok("Gambar dipadam.", { kind: "photos", photos: bank(state), ready: blobConfigured() && durable() });
    }),
  );

  // ---- the widget -------------------------------------------------------------------------------
  // Pictures come from Vercel Blob, so the widget's CSP must allow that image origin.
  const uiMeta = { ui: { csp: { resourceDomains: ["https://*.public.blob.vercel-storage.com"] } } };
  for (const uri of [RESOURCE_URI, ...LEGACY_URIS]) {
    registerAppResource(server, uri, uri, { mimeType: RESOURCE_MIME_TYPE, _meta: uiMeta }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: UI_HTML, _meta: uiMeta }],
    }));
  }

  return server;
}
