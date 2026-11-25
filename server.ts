// Threads Studio: remote MCP server for Claude (custom connector). Stateless Streamable HTTP, so it runs on Vercel.
// Address Claude uses:  https://<host>/mcp/<MCP_TOKEN>   ("No sign in"; the long random token IS the password).
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import { blobConfigured, savePhoto } from "./src/photos.js";
import { invalidate } from "./src/posts.js";
import { tick } from "./src/scheduler.js";
import { durable, load, update } from "./src/store.js";
import * as threads from "./src/threads.js";
import { buildServer } from "./src/tools.js";
import { uploadPage } from "./src/upload-page.js";

const onVercel = Boolean(process.env.VERCEL);
let token = process.env.MCP_TOKEN ?? "";
if (!token && !onVercel) {
  token = crypto.randomBytes(16).toString("hex"); // local dev only: a fresh one each start
}
const tokenOk = token.length >= 24;
const tickToken = process.env.TICK_TOKEN ?? "";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const page = (res: express.Response, status: number, title: string, body: string) =>
  res.status(status).type("html").send(`<!doctype html><html lang="ms"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1rem"><h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(body)}</p></body></html>`);

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.type("text/plain").send("threads-studio: ok"));

// ---- setup check: what is configured, and the exact addresses Meta needs. Shows only yes/no, never a secret value. ----
app.get("/setup", async (_req, res) => {
  const base = threads.publicUrl();
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(base);
  let connected = false;
  let lastPing: string | undefined;
  try { if (durable()) { const s = await load(); connected = Boolean(s.threads); lastPing = s.lastPingAt; } } catch { /* storage not ready: the checklist says so */ }
  const timerOk = Boolean(lastPing) && Date.now() - Date.parse(lastPing!) < 11 * 60_000;
  type Row = { label: string; ok: boolean; optional?: boolean; fix: string };
  const rows: Row[] = [
    { label: threads.zernio() ? "Zernio: ZERNIO_API_KEY ada di Vercel" : "Meta: Threads App ID dan Threads App secret ada di Vercel", ok: threads.appConfigured(), fix: "Vercel > projek awak > Settings > Environment Variables: tambah THREADS_APP_ID dan THREADS_APP_SECRET (daripada Meta), kemudian Redeploy." },
    { label: "MCP_TOKEN ada (kata laluan connector, 24 aksara atau lebih)", ok: tokenOk, fix: "Vercel > Settings > Environment Variables: tambah MCP_TOKEN (rentetan panjang rawak), kemudian Redeploy." },
    { label: "TICK_TOKEN ada (kata laluan pemasa, 24 aksara atau lebih, lain daripada MCP_TOKEN)", ok: tickToken.length >= 24, fix: "Vercel > Settings > Environment Variables: tambah TICK_TOKEN (rentetan panjang rawak yang lain), kemudian Redeploy." },
    { label: "Redis disambung (simpan token Threads, draf dan jadual)", ok: durable(), fix: "Vercel > projek awak > Storage > Create Database > Upstash Redis > sambung pada projek, kemudian Redeploy." },
    { label: "Threads disambung", ok: connected, fix: "Dalam Claude, tulis: sambung Threads. Buka pautan yang Claude beri dan tekan Allow." },
    { label: "Pemasa berjalan (jadual post keluar ikut masa)", ok: timerOk, optional: true, fix: "Cron-job.org: buat cronjob yang melawat alamat /tick/<TICK_TOKEN> setiap 5 minit." },
    { label: "Storan gambar (Vercel Blob, public)", ok: blobConfigured(), optional: true, fix: "Vercel > Storage > Create Database > Blob (pilih Public), sambung pada projek, kemudian Redeploy." },
  ];
  if (threads.zernio()) {
    rows[0].fix = "Vercel > projek awak > Settings > Environment Variables: tambah ZERNIO_API_KEY (Zernio > Settings > API keys), kemudian Redeploy.";
    const rt = rows.find((r) => r.label === "Threads disambung");
    if (rt) rt.fix = "Pastikan akaun Threads dah disambung dalam Zernio (zernio.com, Connections, Threads). Kemudian dalam Claude, tulis: sambung Threads.";
  }
  const next = rows.find((r) => !r.ok && !r.optional);
  const li = (r: Row) => `<li><b>${r.ok ? "✔" : r.optional ? "○" : "✘"}</b> ${esc(r.label)}${r.ok ? "" : `<br><small>${r.optional ? "Pilihan. " : ""}${esc(r.fix)}</small>`}</li>`;
  const code = (s: string) => `<code style="display:block;word-break:break-all;background:#f3ece0;padding:.4rem .6rem;border-radius:6px;margin:.2rem 0 .7rem">${esc(s)}</code>`;
  res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex").status(200).type("html").send(`<!doctype html><html lang="ms"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Semak penyediaan Threads Studio</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:6vh auto;padding:0 1rem;color:#3b2a1a;background:#fbf6ec">
<h1 style="font-size:1.3rem">Semak penyediaan</h1>
<p>${local ? "Ini masih berjalan di komputer, bukan di Vercel. Alamat di bawah belum betul." : "Alamat connector awak: " + esc(base)}</p>
<ul style="list-style:none;padding:0">${rows.map(li).join("")}</ul>
<p><b>${next ? "Langkah seterusnya: " + esc(next.fix) : "Semua yang wajib dah siap."}</b></p>
${threads.zernio() ? "<!--" : ""}<h2 style="font-size:1.05rem;margin-top:1.6rem">Isi dalam Meta (tetapan Threads API)</h2>
<p><small>Nama kotak boleh berbeza sedikit. Salin alamat tepat seperti di bawah.</small></p>
<div>Redirect Callback URL (atau Valid OAuth Redirect URIs)</div>${code(threads.redirectUri())}
<div>Uninstall Callback URL (atau Deauthorize callback URL)</div>${code(`${base}/oauth/deauthorize`)}
<div>Delete Callback URL (atau Data Deletion Requests URL)</div>${code(`${base}/oauth/delete`)}${threads.zernio() ? "-->" : ""}
<h2 style="font-size:1.05rem;margin-top:1.6rem">Alamat untuk Claude (Add custom connector)</h2>
${code(`${base}/mcp/<MCP_TOKEN awak>`)}<p><small>Ganti &lt;MCP_TOKEN awak&gt; dengan nilai MCP_TOKEN yang awak letak di Vercel. Anggap alamat penuh itu kata laluan.</small></p>
</body></html>`);
});

app.post("/mcp/:token", async (req, res) => {
  if (!tokenOk) return res.status(503).json({ error: "MCP_TOKEN belum diset (minimum 24 aksara)." });
  if (!same(String(req.params.token), token)) return res.status(404).end();
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("mcp error", (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp/:token", (_req, res) => res.status(405).end());

// ---- scheduler: a free pinger (cron-job.org) calls this every minute; it publishes what is due ------------------
app.all("/tick/:token", async (req, res) => {
  if (tickToken.length < 24) return res.status(503).json({ error: "TICK_TOKEN belum diset (minimum 24 aksara)." });
  if (!same(String(req.params.token), tickToken)) return res.status(404).end();
  try {
    await update((s) => { s.lastPingAt = new Date().toISOString(); });
    const r = await tick();
    if (r.published || r.failed) invalidate();
    res.json(r);
  } catch (e) {
    console.error("tick error", (e as Error).message);
    res.status(500).json({ error: "tick gagal" });
  }
});

// ---- connecting Threads through Meta ---------------------------------------------------------------------------
// connect_threads (a tool) makes a one-time, 10-minute link /connect/<nonce>; Meta sends them back to /oauth/callback.
app.get("/connect/:nonce", async (req, res) => {
  const exp = (await load()).nonces[String(req.params.nonce)];
  if (!exp || Date.parse(exp) < Date.now()) return page(res, 400, "Pautan tak sah", "Pautan ini sudah tamat atau sudah digunakan. Minta pautan baharu daripada Claude (connect_threads).");
  try { res.redirect(302, threads.authorizeUrl(String(req.params.nonce))); }
  catch (e) { page(res, 500, "Belum boleh sambung", (e as Error).message); }
});

app.get("/oauth/callback", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.error) return page(res, 400, "Meta tak benarkan", q.error_description ?? q.error);
  const nonce = String(q.state ?? "");
  if (!durable()) return page(res, 500, "Redis belum disambung", "Token Threads tak boleh disimpan tanpa Redis pada Vercel. Tambah Upstash Redis (buka halaman /setup pada alamat connector awak untuk semak), kemudian minta pautan baharu.");
  // single use: the nonce is spent here, so a replayed callback cannot connect anything
  const valid = await update((s) => { const exp = s.nonces[nonce]; const ok = Boolean(exp) && Date.parse(exp) > Date.now(); if (ok) delete s.nonces[nonce]; return ok; });
  if (!valid || !q.code) return page(res, 400, "Pautan tak sah", "Sambungan ini tak dimulakan daripada Claude, atau sudah tamat. Minta pautan baharu (connect_threads).");
  try {
    const { token: t, expiresIn } = await threads.exchangeCode(q.code);
    const who = await threads.saveConnection(t, expiresIn);
    invalidate();
    page(res, 200, `Disambung sebagai @${who.username}`, "Siap. Tutup tab ini dan balik ke Claude, kemudian tanya 'berapa post aku minggu ni?'.");
  } catch (e) {
    page(res, 500, "Sambungan gagal", (e as Error).message);
  }
});

// ---- picture upload page: photo_upload_link (a tool) makes a 30-minute link /upload/<nonce> -----------------------
const uploadNonceOk = async (n: string) => { const exp = n.startsWith("u_") ? (await load()).nonces[n] : undefined; return Boolean(exp) && Date.parse(exp!) > Date.now(); };
app.get("/upload/:nonce", async (req, res) => {
  if (!(await uploadNonceOk(String(req.params.nonce)))) return page(res, 400, "Pautan tak sah", "Pautan muat naik ini sudah tamat. Minta pautan baharu daripada Claude (photo_upload_link).");
  res.type("html").send(uploadPage(String(req.params.nonce)));
});
app.post("/upload/:nonce/file", express.raw({ type: ["image/jpeg", "image/png"], limit: "4.5mb" }), async (req, res) => {
  if (!(await uploadNonceOk(String(req.params.nonce)))) return res.status(404).json({ error: "Pautan tamat. Minta pautan baharu." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Fail kosong atau bukan JPEG/PNG." });
  try {
    const p = await savePhoto(req.body, String(req.query.name ?? "gambar"));
    res.json({ id: p.id, name: p.name });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Meta requires these two URLs in the app settings. Both carry a signed_request that is verified with the app secret.
const urlencoded = express.urlencoded({ extended: false });
app.post("/oauth/deauthorize", urlencoded, async (req, res) => {
  if (!threads.parseSignedRequest(String(req.body?.signed_request ?? ""))) return res.status(400).end();
  await threads.disconnect();
  res.json({});
});
app.post("/oauth/delete", urlencoded, async (req, res) => {
  if (!threads.parseSignedRequest(String(req.body?.signed_request ?? ""))) return res.status(400).end();
  await update((s) => { delete s.threads; s.metricsCache = {}; });
  res.json({ url: `${threads.publicUrl()}/`, confirmation_code: "deleted" });
});

export default app;

if (!onVercel) {
  const port = Number(process.env.PORT || 3002);
  app.listen(port, () => {
    console.log(`Threads Studio listening on port ${port}`);
    console.log(`Local URL:  http://localhost:${port}/mcp/${token}`);
    console.log(`Tunnel:     https://<tunnel-address>/mcp/${token}`);
    if (!process.env.MCP_TOKEN) console.log("(MCP_TOKEN is not set: this token changes every start. Set a fixed one in .env.)");
  });
}
