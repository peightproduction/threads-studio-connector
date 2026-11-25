// The one widget. The server sends a `structuredContent` payload (see src/payload.ts); this file draws it and
// wires the buttons to server tools (callServerTool) or to Claude (sendMessage).
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import type { Payload, PhotoOut, PostOut, QueueRow, Rec, WinnerOut } from "../payload.js";

type View = Payload["kind"];
const root = document.getElementById("root")!;
const tabsEl = document.getElementById("tabs")!;
const app = new App({ name: "Threads Studio", version: "0.1.0" });

const cache: Partial<Record<View, Payload>> = {};
let view: View = "tracker";

const TABS: { id: "tracker" | "recs" | "winners" | "analytics" | "photos"; label: string }[] = [
  { id: "tracker", label: "Tracker" },
  { id: "recs", label: "Studio" },
  { id: "photos", label: "Upload gambar" },
  { id: "winners", label: "Winning" },
  { id: "analytics", label: "Analitik" },
];
const tabOf = (v: View) => (v === "analysis" ? "winners" : v === "result" ? "recs" : v);

// ---- helpers ----------------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const num = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString("en-MY"));
const DOW = ["Isn", "Sel", "Rab", "Kha", "Jum", "Sab", "Ahd"];
function myt(iso: string) {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  const dow = (d.getUTCDay() + 6) % 7;
  return `${DOW[dow]} ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
const mytInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16);
const len = (s: string) => [...s].length;
const LANG: Record<string, string> = { ms: "Bahasa Melayu", en: "English", mix: "Campur" };
const grow = (ta: HTMLTextAreaElement) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
const growAll = () => root.querySelectorAll<HTMLTextAreaElement>("textarea:not([data-paste])").forEach(grow);
const payloadOf = (r: any): Payload | undefined => r?.structuredContent as Payload | undefined;
const textOf = (r: any): string => r?.content?.find((c: any) => c.type === "text")?.text ?? "";

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await app.callServerTool({ name, arguments: args });
  return { ok: !r?.isError, text: textOf(r), payload: payloadOf(r) };
}
const ask = (text: string) => app.sendMessage({ role: "user", content: [{ type: "text", text }] });

// ---- shell ------------------------------------------------------------------------------------
function drawTabs() {
  const cur = tabOf(view);
  tabsEl.innerHTML = TABS.map((t) => `<button role="tab" data-tab="${t.id}" aria-selected="${t.id === cur}">${t.label}</button>`).join("");
  const sel = tabsEl.querySelector<HTMLElement>('[aria-selected="true"]'); // on a narrow chat the bar scrolls: keep the open tab in view
  if (sel) tabsEl.scrollLeft = sel.offsetLeft - (tabsEl.clientWidth - sel.offsetWidth) / 2;
}
function setBody(html: string) { root.innerHTML = html; }
function show(p: Payload) { cache[p.kind] = p; view = p.kind; if (p.kind === "winners") winShown = 5; render(); }
const loading = (msg = "Memuatkan...") => setBody(`<p class="sub">${esc(msg)}</p>`);

async function openTab(id: string) {
  if (id === "recs") { view = "recs"; render(); return; }
  const name = id === "tracker" ? "post_tracker" : id === "winners" ? "winning_threads" : id === "photos" ? "list_photos" : "page_analytics";
  view = id as View; drawTabs(); loading();
  try {
    const r = await tool(name);
    if (r.payload) show(r.payload); else setBody(`<p class="err">${esc(r.text || "Tiada data.")}</p>`);
  } catch (e) { setBody(`<p class="err">Gagal: ${esc((e as Error).message)}</p>`); }
}

function render() {
  renderBody();
  growAll();
}
function renderBody() {
  drawTabs();
  const p = cache[view];
  if (view === "recs" && !p) {
    setBody(`<h1>Studio</h1><p class="sub">Tempat awak siapkan post dan gambar. Claude tak tulis atau buat apa-apa sendiri: awak minta bila awak nak.</p><div class="card empty studio-home"><div class="row" style="justify-content:center"><button class="go" data-act="new-card">+ Kad baharu</button><button data-act="ask-poster">Poster Canva</button><button data-act="ask-posts">Tulis post</button></div><p class="note" style="margin-top:10px">Kad baharu: tulis sendiri dan letak gambar. Poster Canva: Claude buat poster, awak ubah di Canva, kemudian pilih dari bank gambar.</p><div data-status aria-live="polite"></div></div>`);
    return;
  }
  if (!p) return loading();
  if (p.kind === "tracker") renderTracker(p);
  else if (p.kind === "recs") renderRecs(p);
  else if (p.kind === "winners") renderWinners(p);
  else if (p.kind === "analysis") renderAnalysis(p);
  else if (p.kind === "analytics") renderAnalytics(p);
  else if (p.kind === "photos") renderPhotos(p);
  else renderResult(p);
}

// ---- tracker ----------------------------------------------------------------------------------
function renderTracker(p: Extract<Payload, { kind: "tracker" }>) {
  const t = p.data;
  const max = Math.max(1, t.goal, ...t.last30.map((d) => d.count));
  const pct = Math.min(100, Math.round((100 * t.today) / t.goal));
  setBody(`
    <h1>Post hari ni: ${t.today} / ${t.goal}</h1>
    <p class="sub">${t.todayLeft ? `Kurang ${t.todayLeft} lagi untuk cukup sasaran.` : "Sasaran hari ni dah cukup."}${t.hoursSinceLast !== undefined ? ` Post terakhir ${t.hoursSinceLast} jam lalu.` : ""}</p>
    <div class="meter" role="progressbar" aria-valuenow="${t.today}" aria-valuemax="${t.goal}"><i style="width:${pct}%"></i></div>
    <div class="kpis four" style="margin-top:10px">
      <div class="kpi"><b>${t.week}<small style="font-size:12px;font-weight:500;color:var(--muted)"> / ${t.weekGoal}</small></b><span>Minggu ni</span></div>
      <div class="kpi"><b>${t.month}</b><span>Bulan ni</span></div>
      <div class="kpi"><b>${t.streak}</b><span>Streak (hari)</span></div>
      <div class="kpi"><b>${t.longestStreak}</b><span>Terpanjang</span></div>
    </div>
    ${t.todayPending && t.streak ? `<p class="note">Streak dikira sampai semalam. Post sekali lagi hari ni untuk kekalkan.</p>` : ""}
    <h3>30 hari lepas (${t.total30} post)</h3>
    <div class="days" aria-label="Post setiap hari">${t.last30.map((d, i) => `<div class="${d.count ? "has" : ""}${i === 29 ? " today" : ""}" style="height:${Math.max(4, (100 * d.count) / max)}%" title="${esc(d.label)}: ${d.count}"></div>`).join("")}</div>
    <div class="axis"><span>${esc(t.last30[0].label)}</span><span>hari ni</span></div>
    <h3>Dalam queue (${p.queue.length}) · dijadual ${t.scheduled.length} · draf ${t.drafts}</h3>
    ${p.queue.length ? p.queue.map(queueLine).join("") : `<p class="sub">Tiada draf atau post dijadualkan.</p>`}
    ${p.slots.length ? `<h3>Masa cadangan</h3><div class="slots">${p.slots.map((s) => `<span class="chip brand" title="${esc(s.why)}">${esc(s.label)}</span>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:12px"><button class="go" data-act="open-studio">Buka Studio</button></div>
    ${p.notes.length ? `<p class="note">${p.notes.map(esc).join("<br>")}</p>` : ""}`);
}

const STATUS_LABEL: Record<QueueRow["status"], string> = { draft: "Draf", scheduled: "Dijadual", failed: "Gagal" };
function queueLine(q: QueueRow) {
  return `<div class="list-line queue" data-qid="${esc(q.id)}">
    <div class="row between"><div><span class="chip ${q.status === "failed" ? "accent" : "brand"}">${STATUS_LABEL[q.status]}</span> ${q.at ? `<b>${myt(q.at)}</b> ` : ""}${q.photos ? `<span class="chip">${q.photos} gambar</span>` : ""}</div>
      <span class="row" style="gap:6px"><button class="small" data-act="edit-queue" aria-label="Ubah ${esc(q.hook)}">Ubah</button><button class="small warn" data-act="del-queue" aria-label="Padam ${esc(q.hook)}">Padam</button></span></div>
    <div>${esc(q.hook)}</div>${q.error ? `<div class="err">${esc(q.error)}</div>` : ""}
  </div>`;
}

// ---- recommendations --------------------------------------------------------------------------
const bulkHtml = (n: number) =>
  n >= 2
    ? `<div class="card bulk"><div class="row between"><div><b>${n} post</b><div class="sub" style="margin:0">Edit mana yang perlu, kemudian simpan semua sekali gus.</div></div><button class="go" data-act="save-all">Simpan semua sebagai draf</button></div><div data-bulkstatus aria-live="polite"></div></div>`
    : "";
function renderRecs(p: Extract<Payload, { kind: "recs" }>) {
  setBody(`<div class="row between"><h1>Studio · <span data-n>${p.recs.length}</span> kad</h1><button class="small" data-act="new-card">+ Kad baharu</button></div><p class="sub">Edit terus dalam kotak, letak gambar, kemudian Draf, Jadual atau Post. Tiada apa dihantar sehingga awak tekan.</p><div data-bulkslot>${bulkHtml(p.recs.length)}</div><div data-cards>` +
    p.recs.map((r, i) => recCard(r, i)).join("") + `</div>`);
}

/** One call for every card on screen: they all become drafts (the server checks each on its own and reports by number). */
async function saveAll(btn: HTMLButtonElement) {
  const cards = [...root.querySelectorAll<HTMLElement>(".rec")];
  const st = root.querySelector<HTMLElement>("[data-bulkstatus]")!;
  btn.disabled = true;
  st.innerHTML = `<p class="sub">Menyimpan ${cards.length} post...</p>`;
  const posts = cards.map((c) => { const r = readCard(c); return { text: r.text, parts: r.parts, topic: r.topic, angle: r.angle || undefined, type: r.type, photo_ids: r.photo_ids }; });
  try {
    const r = await tool("create_posts", { mode: "draft", posts });
    const msg = (r.payload as any)?.message ?? r.text;
    let rows: { n: number; ok: boolean; hook: string; error?: string }[] = [];
    try { rows = JSON.parse(r.text.slice(r.text.indexOf("[{"))); } catch { /* the summary line is enough */ }
    for (const x of rows) {
      const slot = cards[x.n - 1]?.querySelector<HTMLElement>("[data-status]");
      if (slot) slot.innerHTML = x.ok ? `<div class="okmsg">Draf disimpan.</div>` : `<div class="err">${esc(x.error ?? "Gagal")}</div>`;
    }
    const failed = rows.filter((x) => !x.ok);
    st.innerHTML = `<div class="${r.ok && !failed.length ? "okmsg" : "wrn"}">${esc(msg)}</div>${failed.map((x) => `<div class="err">#${x.n} ${esc(x.hook)}: ${esc(x.error ?? "")}</div>`).join("")}`;
    if (!r.ok) btn.disabled = false;
  } catch (e) {
    st.innerHTML = `<div class="err">Gagal: ${esc((e as Error).message)}</div>`;
    btn.disabled = false;
  }
}

const bankOf = (): PhotoOut[] => ((cache.recs as any)?.photos ?? (cache.photos as any)?.photos ?? []) as PhotoOut[];
const thumbsHtml = (ids: string[]) => ids.length
  ? ids.map((id) => { const p = bankOf().find((x) => x.id === id); return p ? `<span class="thumb"><img src="${esc(p.url)}" alt="${esc(p.name)}"><button class="x" data-act="photo-remove" data-pid="${esc(id)}" aria-label="Buang gambar">x</button></span>` : ""; }).join("")
  : `<span class="empty-pic">Belum ada gambar. Letak gambar kat sini: seret, tampal atau tekan Upload gambar.</span>`;
const bankHtml = (ids: string[]) => bankOf().length
  ? bankOf().map((p) => `<button class="gitem${ids.includes(p.id) ? " sel" : ""}" data-act="photo-pick" data-pid="${esc(p.id)}" aria-pressed="${ids.includes(p.id)}" title="${esc(p.desc || p.name)}"><img src="${esc(p.url)}" alt="${esc(p.name)}"></button>`).join("")
  : `<span class="note">Bank gambar kosong. Tambah gambar baharu.</span>`;
/** Pictures made in Canva remember their design: reopen it to tweak, or ask Claude to bring the new version into the bank. */
const editsHtml = (ids: string[]) => ids.map((id) => bankOf().find((x) => x.id === id)).filter((p): p is PhotoOut => Boolean(p?.editUrl))
  .map((p) => `<div class="edits"><span class="n">${esc(p.name)}</span><button class="small" data-act="open" data-url="${esc(p.editUrl)}">Edit di Canva</button><button class="small" data-act="refresh-design" data-pid="${esc(p.id)}">Ambil versi baharu</button></div>`).join("");
const cardPhotoIds = (card: HTMLElement) => (card.dataset.photos ?? "").split(",").filter(Boolean);
function refreshCardPhotos(card: HTMLElement) {
  const ids = cardPhotoIds(card);
  card.querySelector("[data-thumbs]")!.innerHTML = thumbsHtml(ids);
  card.querySelector("[data-edits]")!.innerHTML = editsHtml(ids);
  card.querySelector("[data-bank]")!.innerHTML = bankHtml(ids);
}

function recCard(r: Rec, i: number) {
  const over = len(r.text) > 500;
  const ids = r.photoIds ?? [];
  return `<div class="card rec" data-i="${i}" data-angle="${esc(r.angle)}" data-type="${esc(r.type ?? "")}" data-photos="${esc(ids.join(","))}"${r.queueId ? ` data-qid="${esc(r.queueId)}" data-qstatus="${esc(r.status ?? "")}" data-extra="${esc(JSON.stringify(r.extraMedia ?? []))}"` : ""}>
    <div class="row between"><div class="row">${r.queueId ? `<span class="chip ${r.status === "failed" ? "accent" : "brand"}">${STATUS_LABEL[r.status ?? "draft"]}${r.scheduledFor && r.status !== "draft" ? " " + myt(r.scheduledFor) : ""}</span>` : ""}${r.angle ? `<span class="chip brand">${esc(r.angle)}</span>` : ""}${r.type ? `<span class="chip">${esc(r.type)}</span>` : ""}</div><span class="count${over ? " over" : ""}" data-count>${len(r.text)}/500</span></div>
    <div class="hook" data-hook>${esc(r.hook)}</div>
    <textarea data-text aria-label="Teks post ${i + 1}">${esc(r.text)}</textarea>
    ${(r.parts ?? []).map((t, k) => `<label class="lbl">Sambungan ${k + 2}</label><textarea data-part style="min-height:64px">${esc(t)}</textarea>`).join("")}
    <div class="pbox" data-drop>
      <div class="phead"><b>Gambar untuk post ni</b><span>pilihan</span></div>
      <div class="thumbs" data-thumbs>${thumbsHtml(ids)}</div>
      <div data-edits>${editsHtml(ids)}</div>
      <div class="row" style="margin-top:8px">
        <button class="go" data-act="photo-add">Upload gambar</button>
        <button class="small" data-act="photo-toggle">Pilih dari bank</button>
        <button class="small" data-act="poster">Poster Canva</button>
        <input type="file" data-file accept="image/jpeg,image/png,image/*" multiple hidden>
      </div>
      <textarea class="pastebox" data-paste rows="1" placeholder="Atau klik sini, kemudian tampal gambar (Ctrl+V)" aria-label="Tampal gambar untuk post ni"></textarea>
      <div class="note" style="margin-top:6px">Boleh juga seret gambar ke kotak ni.</div>
      <div data-photostatus aria-live="polite"></div>
      <div class="panel" data-photopanel hidden>
        <div class="grid" data-bank>${bankHtml(ids)}</div>
      </div>
    </div>
    ${r.why ? `<p class="why">${esc(r.why)}</p>` : ""}
    ${r.lint.errors.map((e) => `<div class="err">${esc(e)}</div>`).join("")}${r.lint.warnings.map((w) => `<div class="wrn">${esc(w)}</div>`).join("")}
    <label class="lbl" for="tp${i}">Topik Threads (pilihan)</label><input type="text" id="tp${i}" data-topic maxlength="50" value="${esc(r.topic ?? "")}" placeholder="cth Business">
    <div class="row" style="margin-top:10px">
      ${r.queueId
        ? `<button class="go" data-act="save-queue">Simpan perubahan</button><button data-act="sched-toggle">${r.status === "scheduled" ? "Tukar masa" : "Jadual"}</button>`
        : `<button data-act="draft">Draf</button><button data-act="sched-toggle">Jadual</button><button class="warn" data-act="publish">Post sekarang</button>`}
    </div>
    <div class="panel" data-sched hidden>
      <div class="slots">${(cache.recs as any)?.slots?.map((s: any) => `<button class="small" data-act="slot" data-at="${esc(mytInput(s.at))}" title="${esc(s.why)}">${esc(s.label)}</button>`).join("") ?? ""}</div>
      <div class="row"><input type="datetime-local" data-when aria-label="Masa Malaysia"${r.queueId && r.status === "scheduled" && r.scheduledFor ? ` value="${esc(mytInput(r.scheduledFor))}"` : ""}><button class="go small" data-act="sched">Sahkan jadual</button></div>
      <p class="note">Masa Malaysia (MYT).</p>
    </div>
    ${r.queueId ? "" : `<div class="row" style="margin-top:8px">
      <span class="count">Ubah:</span>
      <button class="small" data-act="tweak" data-k="shorter">Lagi pendek</button>
      <button class="small" data-act="tweak" data-k="hook">Hook lain</button>
      <button class="small" data-act="tweak" data-k="english">English</button>
      <button class="small" data-act="tweak" data-k="angle">Angle lain</button>
    </div>`}
    <div data-status aria-live="polite"></div>
  </div>`;
}

const TWEAK: Record<string, string> = {
  shorter: "buat lagi pendek dan padat",
  hook: "tukar hook dengan pembukaan yang berbeza sama sekali",
  english: "tulis semula dalam English santai dan relatable",
  angle: "tukar ke pendekatan lain tetapi kekalkan topik",
};

function readCard(card: HTMLElement) {
  const text = (card.querySelector("[data-text]") as HTMLTextAreaElement).value.trim();
  const parts = [...card.querySelectorAll<HTMLTextAreaElement>("[data-part]")].map((t) => t.value.trim()).filter(Boolean);
  const topic = (card.querySelector("[data-topic]") as HTMLInputElement).value.trim();
  const photo_ids = cardPhotoIds(card);
  return { text, parts: parts.length ? parts : undefined, topic: topic || undefined, angle: card.dataset.angle, type: card.dataset.type || undefined, photo_ids: photo_ids.length ? photo_ids : undefined };
}

async function createFrom(card: HTMLElement, mode: "draft" | "schedule" | "publish", when?: string) {
  const status = card.querySelector<HTMLElement>("[data-status]")!;
  const buttons = card.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => (b.disabled = true));
  status.innerHTML = `<p class="sub">Menghantar...</p>`;
  try {
    const r = await tool("create_post", { ...readCard(card), mode, scheduled_for: when, confirm_publish: mode === "publish" ? true : undefined });
    if (r.ok) {
      const url = (r.payload as any)?.post?.url;
      status.innerHTML = `<div class="okmsg">${esc(r.text)}</div>${url ? `<button class="small" data-act="open" data-url="${esc(url)}" style="margin-top:6px">Buka di Threads</button>` : ""}`;
      if (mode === "draft") buttons.forEach((b) => (b.disabled = false));
    } else {
      status.innerHTML = `<div class="err">${esc(r.text)}</div>`;
      buttons.forEach((b) => (b.disabled = false));
    }
  } catch (e) {
    status.innerHTML = `<div class="err">Gagal: ${esc((e as Error).message)}</div>`;
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---- winners and analysis ---------------------------------------------------------------------
function metricChips(p: PostOut) {
  if (!p.metricsKnown || !p.metrics) return `<span class="chip">Nombor belum ada</span>`;
  const m = p.metrics;
  return [`${num(m.views)} tontonan`, `${num(m.likes)} like`, `${num(m.replies)} komen`, `${num(m.reposts)} repost`, ...(m.shares ? [`${num(m.shares)} kongsi`] : [])].map((x) => `<span class="chip">${x}</span>`).join("");
}

let winShown = 5;
function renderWinners(p: Extract<Payload, { kind: "winners" }>) {
  const shown = p.winners.slice(0, winShown);
  setBody(`<h1>Thread yang menang</h1><p class="sub">${p.days} hari lepas. Median awak: ${num(Math.round(p.baseline.medianViews))} tontonan (${p.baseline.n} post berangka). "2.4x" bermaksud 2.4 kali ganda median awak.</p>` +
    (shown.length ? shown.map(winnerCard).join("") : `<div class="empty">Belum ada post dengan nombor.</div>`) +
    (p.winners.length > shown.length ? `<div class="row"><button class="small" data-act="more-winners">Tunjuk lagi (${p.winners.length - shown.length})</button></div>` : "") +
    (p.notes.length ? `<p class="note">${p.notes.map(esc).join("<br>")}</p>` : ""));
}

function winnerCard(w: WinnerOut, i: number) {
  const f = w.features;
  const rest = (w.post.text.startsWith(w.post.hook) ? w.post.text.slice(w.post.hook.length) : w.post.text).trim();
  return `<div class="card win" data-id="${esc(w.post.id)}" data-hook="${esc(w.post.hook)}" data-url="${esc(w.post.url ?? "")}" data-leads="${w.post.leads ?? 0}">
    <div class="row">${i < 3 ? `<span class="chip brand">#${i + 1}</span>` : `<span class="chip">#${i + 1}</span>`}${w.labels.map((l) => `<span class="chip accent">${esc(l)}</span>`).join("")}<span class="count">${myt(w.post.at)}</span></div>
    <div class="hook">${esc(w.post.hook)}</div>
    ${rest ? `<div class="clamp" data-act="expand">${esc(rest)}</div>` : ""}
    <div class="row">${metricChips(w.post)}</div>
    <div class="row" style="margin-top:6px"><span class="chip brand">${w.vsViews}x tontonan</span><span class="chip brand">${w.vsEng}x engagement</span><span class="chip">${esc(f.hookType)}</span><span class="chip">${esc(LANG[f.language] ?? f.language)}</span><span class="chip">${esc(f.slot)}</span></div>
    <div class="row" style="margin-top:10px">
      <button class="go" data-act="why">Kenapa menang?</button>
      <button data-act="similar">Buat yang serupa</button>
      <button class="small" data-act="lead" title="Catat satu lead/DM daripada post ni">+ Lead (<span data-lead>${w.post.leads ?? 0}</span>)</button>
      ${w.post.url ? `<button class="small" data-act="open" data-url="${esc(w.post.url)}">Buka</button>` : ""}
      <button class="small warn" data-act="del-live" title="Padam post ni daripada Threads">Padam</button>
    </div>
    <div data-status aria-live="polite"></div>
  </div>`;
}

function renderAnalysis(p: Extract<Payload, { kind: "analysis" }>) {
  const post = p.post, f = p.features;
  const text = esc(post.text);
  const hook = esc(post.hook);
  const quote = text.startsWith(hook) ? `<mark>${hook}</mark>${text.slice(hook.length)}` : text;
  const list = (xs: string[]) => (xs.length ? `<ul class="pts">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="sub">-</p>`);
  setBody(`<h1>Kenapa post ni menang</h1>
    <div class="quote">${quote}</div>
    <div class="row">${metricChips(post)}</div>
    <div class="row" style="margin-top:6px">
      <span class="chip brand">${p.vsViews}x tontonan</span><span class="chip brand">${p.vsEng}x engagement</span>
      <span class="chip">hook: ${esc(p.read.hookType ?? f.hookType)}</span><span class="chip">${f.chars} aksara</span><span class="chip">${f.lines} baris</span>
      <span class="chip">${esc(LANG[f.language] ?? f.language)}</span><span class="chip">${esc(f.slot)}</span>${f.hasRinggit ? `<span class="chip">ada RM</span>` : ""}${f.hasCta ? `<span class="chip">ada ajakan</span>` : ""}${f.emoji ? `<span class="chip">${f.emoji} emoji</span>` : ""}
    </div>
    <h3>Kenapa menjadi</h3>${list(p.read.why)}
    <h3>Boleh guna semula</h3>${list(p.read.reuse)}
    ${p.read.avoid.length ? `<h3>Elak</h3>${list(p.read.avoid)}` : ""}
    <div class="row" id="analysis-actions" style="margin-top:12px" data-id="${esc(post.id)}" data-url="${esc(post.url ?? "")}" data-hook="${esc(post.hook)}">
      <button class="go" data-act="save-insight">Simpan pelajaran</button>
      <button data-act="similar">Buat 3 variasi</button>
      ${post.url ? `<button class="small" data-act="open" data-url="${esc(post.url)}">Buka</button>` : ""}
    </div><div data-status aria-live="polite"></div>`);
}

// ---- analytics --------------------------------------------------------------------------------
function renderAnalytics(p: Extract<Payload, { kind: "analytics" }>) {
  const maxAvg = Math.max(1, ...p.grid.flat().map((c) => c.avgViews));
  const maxHook = Math.max(1, ...p.hooks.map((h) => h.avgViews));
  const heads = Array.from({ length: 8 }, (_, s) => `<div class="h">${s * 3}</div>`).join("");
  const rows = p.grid.map((row, d) => `<div class="h">${DOW[d]}</div>` + row.map((c) => {
    const a = c.n ? 0.15 + 0.85 * (c.avgViews / maxAvg) : 0;
    return `<div class="c" style="${c.n ? `background:color-mix(in srgb, var(--brand) ${Math.round(a * 100)}%, transparent);${a > 0.55 ? "color:var(--brand-ink);font-weight:700" : ""}` : ""}" title="${DOW[d]} ${c.n} post, purata ${c.avgViews} tontonan">${c.n || ""}</div>`;
  }).join("")).join("");
  setBody(`<h1>Analitik ${p.days} hari</h1>
    <div class="kpis" style="margin-top:8px">
      <div class="kpi"><b>${p.followers === undefined ? "?" : num(p.followers)}</b><span>Pengikut</span></div>
      <div class="kpi"><b>${p.posts}</b><span>Post (${p.withMetrics} berangka)</span></div>
      <div class="kpi"><b>${num(p.totalViews)}</b><span>Jumlah tontonan</span></div>
      <div class="kpi"><b>${num(p.avgViews)}</b><span>Purata / post</span></div>
      <div class="kpi"><b>${num(p.medianViews)}</b><span>Median / post</span></div>
      <div class="kpi"><b>${(p.engRate * 100).toFixed(1)}%</b><span>Engagement (median)</span></div>
    </div>
    <h3>Waktu terbaik</h3>
    ${p.best.length ? p.best.map((b) => `<div class="list-line"><b>${esc(b.label)}</b> · purata ${num(b.avgViews)} tontonan (${b.n} post)</div>`).join("") : `<p class="sub">Belum cukup data.</p>`}
    <h3>Peta hari x waktu (jam MYT, nombor = bilangan post)</h3>
    <div class="heat"><div></div>${heads}${rows}</div>
    <h3>Prestasi jenis hook</h3>
    ${p.hooks.filter((h) => h.n).map((h) => `<div class="bar"><span>${esc(h.type)}</span><i style="width:${Math.max(2, (100 * h.avgViews) / maxHook)}%"></i><span>${num(h.avgViews)} (${h.n})</span></div>`).join("") || `<p class="sub">Belum ada data.</p>`}
    ${p.notes.length ? `<p class="note">${p.notes.map(esc).join("<br>")}</p>` : ""}`);
}

function renderResult(p: Extract<Payload, { kind: "result" }>) {
  setBody(`<div class="card"><h2>${esc(p.message)}</h2>${p.post ? `<p class="sub">${esc(p.post.hook)}</p>${p.post.url ? `<button class="small" data-act="open" data-url="${esc(p.post.url)}">Buka di Threads</button>` : ""}` : ""}</div>`);
}

// ---- photo bank ---------------------------------------------------------------------------------
const kb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
function renderPhotos(p: Extract<Payload, { kind: "photos" }>) {
  setBody(`<h1>Upload gambar</h1>
    <p class="sub">Gambar untuk post Threads. Meta ambil gambar daripada alamat awam, jadi gambar disimpan di sini. Boleh juga upload terus pada setiap kad di tab Studio.</p>
    ${p.note ? `<div class="wrn">${esc(p.note)}</div>` : ""}
    <div class="dz" data-drop>
      <b>Letak gambar kat sini</b>
      <span class="sub" style="margin:2px 0 8px">Tekan butang, seret gambar ke kotak ni, atau tampal di bawah. JPEG atau PNG.</span>
      <div class="row" style="justify-content:center"><button class="go" data-act="photo-add"${p.ready ? "" : " disabled"}>Upload gambar</button><input type="file" data-file accept="image/jpeg,image/png,image/*" multiple hidden></div>
      <label class="lbl" style="margin-top:10px">Tampal gambar (salin gambar atau screenshot, klik kotak, Ctrl+V)</label>
      <textarea class="pastebox" data-paste rows="2" placeholder="Klik sini, kemudian tekan Ctrl+V" aria-label="Tampal gambar"${p.ready ? "" : " disabled"}></textarea>
      <button class="small" data-act="upload-link" style="margin-top:8px"${p.ready ? "" : " disabled"}>Butang tak berfungsi? Guna pautan muat naik</button>
    </div>
    <div data-photostatus aria-live="polite"></div>
    <h3>Bank gambar (${p.photos.length})</h3>
    ${p.photos.length ? p.photos.map((x) => `<div class="card prow" data-pid="${esc(x.id)}"><img src="${esc(x.url)}" alt="${esc(x.name)}"><div><b class="n">${esc(x.name)}</b><div class="sub" style="margin:0">${kb(x.size)}${x.desc ? " · " + esc(x.desc) : ""}</div>${x.editUrl ? `<button class="small" data-act="open" data-url="${esc(x.editUrl)}" style="margin-top:6px">Edit di Canva</button>` : ""}</div><button class="small warn" data-act="photo-delete" aria-label="Padam ${esc(x.name)}">Padam</button></div>`).join("") : `<div class="empty">Belum ada gambar.</div>`}
    <div data-status aria-live="polite"></div>`);
}

/** Shrink in the browser (longest side 1440 px, JPEG) so a picture is a few hundred KB, then base64 for the tool call. */
async function shrinkToBase64(file: File): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  let side = 1440;
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.58, 0.46]) {
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", q));
      if (blob.size <= 900 * 1024) {
        const url: string = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
        return url.slice(url.indexOf(",") + 1);
      }
    }
    side = Math.round(side * 0.75);
  }
  throw new Error("masih terlalu besar selepas dikecilkan");
}

async function uploadFiles(files: File[], statusEl: HTMLElement): Promise<string[]> {
  const before = new Set(bankOf().map((p) => p.id));
  let failed = "";
  for (let i = 0; i < files.length; i++) {
    statusEl.innerHTML = `<p class="sub">Memuat naik ${i + 1} / ${files.length}...</p>`;
    try {
      const b64 = await shrinkToBase64(files[i]);
      const r = await tool("photo_save", { name: files[i].name, data_base64: b64 });
      if (!r.ok) { failed = r.text; break; }
      if (r.payload?.kind === "photos") { cache.photos = r.payload; if (cache.recs) (cache.recs as any).photos = r.payload.photos; }
    } catch (e) { failed = (e as Error).message; break; }
  }
  statusEl.innerHTML = failed
    ? `<div class="err">Tak dapat muat naik dari sini: ${esc(failed)}</div><button class="small" data-act="upload-link" style="margin-top:6px">Guna pautan muat naik</button>`
    : `<div class="okmsg">Siap.</div>`;
  return bankOf().map((p) => p.id).filter((id) => !before.has(id));
}

/** What Claude is asked when the owner taps Poster Canva. The rules for the flow live in the server's instructions. */
const POSTER_ASK = (text: string) => `Buat poster Canva${text ? ` untuk post ni:\n"""\n${text}\n"""` : ""}. Portrait 1080x1350, teks besar yang senang dibaca. Tunjuk aku dulu dan bagi pautan edit Canva supaya aku boleh ubah. Bila aku kata okay, export PNG dan simpan dalam bank gambar (photo_from_url dengan edit_url), kemudian aku pilih dari bank pada kad Studio.`;

/** Pull the bank fresh from the server (Claude may have added a picture since the card was drawn). A failure keeps what is on screen. */
async function refreshBank(card: HTMLElement) {
  try {
    const r = await tool("list_photos");
    if (r.payload?.kind === "photos") { cache.photos = r.payload; if (cache.recs) (cache.recs as any).photos = r.payload.photos; refreshCardPhotos(card); }
  } catch { /* keep the bank that is shown */ }
}

/** Tracker > Ubah: open one draft / scheduled / failed post as an editable card in Studio. */
async function editQueued(btn: HTMLButtonElement, qid: string) {
  btn.disabled = true;
  try {
    const r = await tool("queue_item", { post_id: qid });
    if (!r.ok || r.payload?.kind !== "recs") { btn.insertAdjacentHTML("afterend", `<div class="err">${esc(r.text || "Tak dapat dibuka.")}</div>`); return; }
    const one = r.payload.recs[0];
    const cur = cache.recs as Extract<Payload, { kind: "recs" }> | undefined;
    const keep = cur ? cur.recs.filter((x) => x.queueId !== qid) : [];
    cache.recs = { ...r.payload, recs: [one, ...keep], slots: r.payload.slots.length ? r.payload.slots : cur?.slots ?? [] };
    cache.photos = { kind: "photos", photos: r.payload.photos, ready: true };
    view = "recs"; render();
    root.querySelector<HTMLElement>(".rec [data-text]")?.focus();
  } catch (e) { btn.insertAdjacentHTML("afterend", `<div class="err">Gagal: ${esc((e as Error).message)}</div>`); }
  finally { btn.disabled = false; }
}

/** Save the card's changes into the existing draft / scheduled post (edit_post); with a time, then schedule it (reschedule_post). */
async function saveQueued(card: HTMLElement, when?: string) {
  const status = card.querySelector<HTMLElement>("[data-status]")!;
  const buttons = card.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => (b.disabled = true));
  status.innerHTML = `<p class="sub">Menyimpan...</p>`;
  const qid = card.dataset.qid!;
  const c = readCard(card);
  let extra: string[] = []; try { extra = JSON.parse(card.dataset.extra || "[]"); } catch { /* none */ }
  try {
    const e = await tool("edit_post", { post_id: qid, text: c.text, parts: c.parts ?? [], topic: c.topic ?? "", photo_ids: c.photo_ids ?? [], ...(extra.length ? { media_urls: extra } : {}) });
    if (!e.ok) { status.innerHTML = `<div class="err">${esc(e.text)}</div>`; return; }
    if (!when) { status.innerHTML = `<div class="okmsg">Perubahan disimpan.</div>`; return; }
    const s = await tool("reschedule_post", { post_id: qid, scheduled_for: when });
    status.innerHTML = s.ok ? `<div class="okmsg">Perubahan disimpan. ${esc(s.text)}</div>` : `<div class="err">Perubahan disimpan, tapi jadual gagal: ${esc(s.text)}</div>`;
    if (s.ok) {
      card.dataset.qstatus = "scheduled"; card.querySelector<HTMLElement>("[data-act=sched-toggle]")!.textContent = "Tukar masa";
      const chip = card.querySelector<HTMLElement>(".row .chip"); if (chip) { chip.className = "chip brand"; chip.textContent = STATUS_LABEL.scheduled + " " + myt(new Date(when + ":00+08:00").toISOString()); }
    }
  } catch (err) { status.innerHTML = `<div class="err">Gagal: ${esc((err as Error).message)}</div>`; }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

/** A blank card to write on yourself. It is appended, so what is typed in the other cards is not lost. */
async function newCard(btn: HTMLButtonElement) {
  btn.disabled = true;
  const blank: Rec = { angle: "", hook: "", text: "", why: "", lint: { errors: [], warnings: [], chars: [] } };
  try {
    const r = await tool("list_photos");
    const photos = r.payload?.kind === "photos" ? r.payload.photos : bankOf();
    if (r.payload?.kind === "photos") cache.photos = r.payload;
    if (!cache.recs) { cache.recs = { kind: "recs", recs: [blank], slots: [], photos } as Payload; view = "recs"; render(); return; }
    const rp = cache.recs as Extract<Payload, { kind: "recs" }>;
    rp.photos = photos; rp.recs.push(blank);
    const list = root.querySelector<HTMLElement>("[data-cards]");
    if (!list) { render(); return; }
    list.insertAdjacentHTML("beforeend", recCard(blank, rp.recs.length - 1));
    const n = root.querySelector<HTMLElement>("[data-n]"); if (n) n.textContent = String(rp.recs.length);
    const slot = root.querySelector<HTMLElement>("[data-bulkslot]"); if (slot && !slot.firstElementChild) slot.innerHTML = bulkHtml(rp.recs.length);
    else if (slot) { const t = slot.querySelector("b"); if (t) t.textContent = rp.recs.length + " post"; }
    list.lastElementChild?.querySelector<HTMLTextAreaElement>("[data-text]")?.focus();
  } finally { btn.disabled = false; }
}

// ---- events -----------------------------------------------------------------------------------
let armed: { btn: HTMLButtonElement; timer: number; label: string; cls: string } | undefined;
const disarm = () => { if (armed) { clearTimeout(armed.timer); armed.btn.className = armed.cls; armed.btn.textContent = armed.label; armed = undefined; } };
/** First tap arms the button (red, new label, 5 s); the second tap on the same button returns true. */
function twoTap(btn: HTMLButtonElement, armedLabel: string): boolean {
  if (armed?.btn === btn) { disarm(); return true; }
  disarm();
  armed = { btn, label: btn.textContent ?? "", cls: btn.className, timer: window.setTimeout(disarm, 5000) };
  btn.className = (btn.className.replace(/\bwarn\b/, "") + " armed").trim(); btn.textContent = armedLabel;
  return false;
}

tabsEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
  if (b) openTab(b.dataset.tab!);
});

/** Upload pictures into the bank. On a post card they are also attached to that card. */
async function ingest(files: File[], card?: HTMLElement | null) {
  if (!files.length) return;
  const statusEl = (card ?? root).querySelector<HTMLElement>("[data-photostatus]");
  if (!statusEl) return;
  const added = await uploadFiles(files, statusEl);
  if (card) { card.dataset.photos = [...cardPhotoIds(card), ...added].slice(0, 20).join(","); refreshCardPhotos(card); }
  else if (cache.photos) { const keep = statusEl.innerHTML; render(); root.querySelector<HTMLElement>("[data-photostatus]")!.innerHTML = keep; }
}
const imageFiles = (list?: FileList | null) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

root.addEventListener("change", async (e) => {
  const inp = e.target as HTMLInputElement;
  if (!inp.matches("input[data-file]")) return;
  const files = Array.from(inp.files ?? []); inp.value = "";
  await ingest(files, inp.closest<HTMLElement>(".rec"));
});

// Drag a picture onto a post card or the Gambar tab, or paste one (Ctrl+V). Same path as the button.
let dragOn: Element | undefined;
const clearDrag = () => { dragOn?.classList.remove("over"); dragOn = undefined; };
root.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  const zone = (e.target as HTMLElement).closest(".rec, .dz");
  if (!zone) return;
  e.preventDefault();
  if (dragOn !== zone) { clearDrag(); zone.classList.add("over"); dragOn = zone; }
});
root.addEventListener("dragleave", (e) => { if (!(e.relatedTarget as Node | null) || !root.contains(e.relatedTarget as Node)) clearDrag(); });
root.addEventListener("drop", async (e) => {
  const zone = (e.target as HTMLElement).closest<HTMLElement>(".rec, .dz");
  clearDrag();
  if (!zone || !hasFiles(e)) return;
  e.preventDefault();
  await ingest(imageFiles(e.dataTransfer?.files), zone.closest<HTMLElement>(".rec"));
});
document.addEventListener("paste", async (e) => {
  const files = imageFiles(e.clipboardData?.files);
  if (!files.length) return;
  const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".rec") ?? null;
  const onBank = Boolean(root.querySelector(".dz"));
  if (!card && !onBank) return; // more than one card and none focused: do not guess which one
  e.preventDefault();
  await ingest(files, card);
});

root.addEventListener("input", (e) => {
  const ta = e.target as HTMLElement;
  if (ta.matches("[data-paste]")) {
    // the paste box takes pictures only: anything typed or pasted as text is thrown away, with a hint
    (ta as HTMLTextAreaElement).value = "";
    const st = (ta.closest<HTMLElement>(".rec") ?? root).querySelector<HTMLElement>("[data-photostatus]");
    if (st) st.innerHTML = `<div class="wrn">Kotak ni untuk gambar sahaja. Salin gambar (atau ambil screenshot) dulu, kemudian tampal di sini.</div>`;
    return;
  }
  if (!ta.matches("[data-text]")) return;
  const card = ta.closest<HTMLElement>(".rec")!;
  const n = len((ta as HTMLTextAreaElement).value);
  const c = card.querySelector<HTMLElement>("[data-count]")!;
  grow(ta as HTMLTextAreaElement);
  c.textContent = `${n}/500`;
  c.classList.toggle("over", n > 500);
  card.querySelector<HTMLElement>("[data-hook]")!.textContent = (ta as HTMLTextAreaElement).value.split("\n")[0].slice(0, 140);
});

root.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!b) return;
  const act = b.dataset.act!;
  const card = b.closest<HTMLElement>(".rec");
  const win = b.closest<HTMLElement>(".win") ?? b.closest<HTMLElement>("#analysis-actions");

  if (act === "open-studio") { await openTab("recs"); return; }
  if (act === "edit-queue") { await editQueued(b as HTMLButtonElement, b.closest<HTMLElement>(".queue")!.dataset.qid!); return; }
  if (act === "ask-posts") { await ask("Tulis post untuk aku."); return; }
  if (act === "ask-poster") { await ask(POSTER_ASK("")); return; }
  if (act === "new-card") { await newCard(b as HTMLButtonElement); return; }
  if (act === "refresh-design") {
    const p = bankOf().find((x) => x.id === b.dataset.pid);
    if (p?.editUrl) await ask(`Aku dah tweak poster "${p.name}" di Canva (${p.editUrl}). Export versi terbaru sebagai PNG dan simpan dalam bank dengan photo_from_url (edit_url sama). Kalau gambar lama dipakai oleh draf atau post berjadual, tukar guna edit_post. Lepas tu bagitahu aku, aku pilih dari bank.`);
    return;
  }
  if (act === "save-all") { await saveAll(b as HTMLButtonElement); return; }
  if (act === "open") { await app.openLink({ url: b.dataset.url! }); return; }
  if (act === "expand") { b.classList.toggle("open"); return; }
  if (act === "more-winners") { winShown += 5; render(); return; }
  if (act === "photo-add" && !card) { root.querySelector<HTMLInputElement>("[data-file]")?.click(); return; }
  if (act === "upload-link") {
    const r = await tool("photo_upload_link");
    let link = ""; try { link = JSON.parse(r.text).upload_link ?? ""; } catch { /* error text below */ }
    const st = root.querySelector<HTMLElement>("[data-photostatus]") ?? root.querySelector<HTMLElement>("[data-status]");
    if (link) { await app.openLink({ url: link }); if (st) st.innerHTML = `<p class="sub">Halaman muat naik dibuka (sah 30 minit). Lepas siap, buka tab Gambar semula.</p>`; }
    else if (st) st.innerHTML = `<div class="err">${esc(r.text)}</div>`;
    return;
  }
  if (act === "photo-delete") {
    if (!twoTap(b as HTMLButtonElement, "Tekan lagi untuk PADAM")) return;
    const row = b.closest<HTMLElement>(".prow")!;
    const r = await tool("remove_photo", { photo_id: row.dataset.pid });
    if (r.ok && r.payload?.kind === "photos") { cache.photos = r.payload; if (cache.recs) (cache.recs as any).photos = r.payload.photos; render(); }
    else root.querySelector<HTMLElement>("[data-status]")!.innerHTML = `<div class="err">${esc(r.text)}</div>`;
    return;
  }
  if (act === "del-queue") {
    if (!twoTap(b as HTMLButtonElement, "Tekan lagi untuk PADAM")) return;
    const line = b.closest<HTMLElement>(".queue")!;
    const r = await tool("remove_post", { post_id: line.dataset.qid });
    if (r.ok) await openTab("tracker"); else { line.insertAdjacentHTML("beforeend", `<div class="err">${esc(r.text)}</div>`); }
    return;
  }

  if (card) {
    if (act === "save-queue") return void saveQueued(card);
    if (act === "draft") return void createFrom(card, "draft");
    if (act === "sched-toggle") { const pn = card.querySelector<HTMLElement>("[data-sched]")!; pn.hidden = !pn.hidden; return; }
    if (act === "slot") { (card.querySelector("[data-when]") as HTMLInputElement).value = b.dataset.at!; return; }
    if (act === "sched") {
      const when = (card.querySelector("[data-when]") as HTMLInputElement).value;
      if (!when) { card.querySelector<HTMLElement>("[data-status]")!.innerHTML = `<div class="err">Pilih masa dulu.</div>`; return; }
      return void (card.dataset.qid ? saveQueued(card, when) : createFrom(card, "schedule", when));
    }
    if (act === "publish") { if (twoTap(b as HTMLButtonElement, "Tekan lagi untuk post LIVE")) void createFrom(card, "publish"); return; }
    if (act === "photo-toggle") {
      const pn = card.querySelector<HTMLElement>("[data-photopanel]")!; pn.hidden = !pn.hidden;
      if (!pn.hidden) await refreshBank(card); // a poster Claude just saved should be there without reopening the Studio
      return;
    }
    if (act === "poster") { await ask(POSTER_ASK(readCard(card).text)); return; }
    if (act === "photo-pick" || act === "photo-remove") {
      const pid = b.dataset.pid!; const ids = cardPhotoIds(card);
      const next = act === "photo-remove" || ids.includes(pid) ? ids.filter((x) => x !== pid) : [...ids, pid].slice(0, 20);
      card.dataset.photos = next.join(","); refreshCardPhotos(card); return;
    }
    if (act === "photo-add") { card.querySelector<HTMLInputElement>("[data-file]")!.click(); return; }
    if (act === "tweak") {
      const { text } = readCard(card);
      await ask(`Ubah cadangan ${Number(card.dataset.i) + 1}: ${TWEAK[b.dataset.k!]}. Teks semasa:\n"""\n${text}\n"""\nPapar semula semua cadangan dengan show_recommendations (kekalkan yang lain).`);
      return;
    }
  }
  if (win) {
    const id = win.dataset.id!, hook = win.dataset.hook!;
    if (act === "del-live") {
      if (!twoTap(b as HTMLButtonElement, "Tekan lagi: PADAM dari Threads")) return;
      const r = await tool("remove_post", { post_id: id, confirm_delete: true });
      win.querySelector<HTMLElement>("[data-status]")!.innerHTML = r.ok ? `<div class="okmsg">${esc(r.text)}</div>` : `<div class="err">${esc(r.text)}</div>`;
      if (r.ok) win.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = true));
      return;
    }
    if (act === "why") { await ask(`Analisa kenapa post ini menang (hook: "${hook}", post_id: ${id}). Fikir tentang hook, struktur, bahasa, masa post dan audience, lepas tu papar dengan show_post_analysis.`); return; }
    if (act === "similar") { await ask(`Buat 3 variasi post yang serupa dengan post "${hook}" (post_id: ${id}): mekanisme sama, topik dan hook berbeza. Guna studio_brief kalau perlu, lepas tu papar dengan show_recommendations.`); return; }
    if (act === "lead") {
      const n = Number(win.dataset.leads ?? 0) + 1;
      const r = await tool("mark_result", { post_id: id, leads: n });
      if (r.ok) { win.dataset.leads = String(n); const s = win.querySelector("[data-lead]"); if (s) s.textContent = String(n); }
      return;
    }
    if (act === "save-insight") {
      const a = cache.analysis as Extract<Payload, { kind: "analysis" }> | undefined;
      const status = root.querySelector<HTMLElement>("[data-status]")!;
      const bits = a ? [...a.read.reuse.slice(0, 2), ...a.read.why.slice(0, 1)] : [];
      const text = `Post "${hook}": ${bits.join("; ")}`.slice(0, 400);
      const r = await tool("save_insight", { text, post_id: id });
      status.innerHTML = r.ok ? `<div class="okmsg">Pelajaran disimpan.</div>` : `<div class="err">${esc(r.text)}</div>`;
      return;
    }
  }
});

// ---- connect ----------------------------------------------------------------------------------
app.ontoolresult = (result: any) => {
  const p = payloadOf(result);
  if (p) show(p);
  else { drawTabs(); setBody(`<p class="sub">${esc(textOf(result) || "Tiada data.")}</p>`); }
};
app.onhostcontextchanged = (ctx: any) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};
drawTabs();
app.connect().then(() => {
  const ctx: any = (app as any).getHostContext?.();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
});
