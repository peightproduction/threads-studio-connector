// The one-time upload page (/upload/<nonce>): pick pictures on a computer or phone, they are shrunk in the browser
// (longest side 1440 px, JPEG) and sent to /upload/<nonce>/file one by one. Works without the Claude widget.
export const uploadPage = (nonce: string): string => `<!doctype html>
<html lang="ms"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Muat naik gambar</title>
<style>
  body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:34rem;margin:8vh auto;padding:0 1rem;color:#0f2421}
  h1{font-size:1.25rem;margin:0 0 .25rem} p{margin:.25rem 0 1rem;color:#4d6762}
  label.pick{display:block;border:2px dashed #194b46;border-radius:14px;padding:2rem 1rem;text-align:center;cursor:pointer;font-weight:600;color:#194b46}
  input[type=file]{position:absolute;opacity:0;width:1px;height:1px}
  label.pick:focus-within{outline:3px solid #194b46;outline-offset:2px}
  ul{list-style:none;padding:0;margin:1rem 0} li{padding:.55rem .7rem;border:1px solid #c9d9d1;border-radius:10px;margin:.4rem 0;display:flex;justify-content:space-between;gap:.75rem}
  li.ok{border-color:#17803d} li.err{border-color:#b94722;color:#b94722} .n{overflow-wrap:anywhere}
  .done{font-weight:600;color:#17803d;margin-top:1rem}
  @media (prefers-color-scheme:dark){body{background:#101a18;color:#e6efec}p{color:#9ab0aa}label.pick{border-color:#5fd0bf;color:#5fd0bf}li{border-color:#2b403b}}
</style></head>
<body>
<h1>Muat naik gambar untuk Threads</h1>
<p>Pilih gambar JPEG atau PNG. Ia dikecilkan dahulu (maksimum 1440 px) dan disimpan dalam bank gambar awak. Halaman ini sah 30 minit.</p>
<label class="pick" id="pick">Tekan untuk pilih gambar (boleh banyak sekali gus)<input id="f" type="file" accept="image/jpeg,image/png,image/*" multiple></label>
<ul id="list" aria-live="polite"></ul>
<div class="done" id="done" hidden>Siap. Balik ke Claude dan tanya "tunjuk gambar aku".</div>
<script>
(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var MAX_SIDE = 1440, MAX_BYTES = 3.5 * 1024 * 1024;
  var list = document.getElementById("list"), done = document.getElementById("done");
  function row(name) { var li = document.createElement("li"); var a = document.createElement("span"); a.className = "n"; a.textContent = name; var b = document.createElement("span"); b.textContent = "menunggu..."; li.append(a, b); list.append(li); return { li: li, st: b }; }
  function toBlob(canvas, q) { return new Promise(function (res) { canvas.toBlob(res, "image/jpeg", q); }); }
  async function shrink(file) {
    var bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    var c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    var q = 0.86, blob = await toBlob(c, q);
    while (blob.size > MAX_BYTES && q > 0.4) { q -= 0.1; blob = await toBlob(c, q); }
    if (blob.size > MAX_BYTES) throw new Error("masih terlalu besar selepas dikecilkan");
    return blob;
  }
  document.getElementById("f").addEventListener("change", async function (e) {
    var files = Array.from(e.target.files || []); e.target.value = ""; var ok = 0;
    for (var i = 0; i < files.length; i++) {
      var r = row(files[i].name);
      try {
        r.st.textContent = "mengecilkan...";
        var blob = await shrink(files[i]);
        r.st.textContent = "memuat naik...";
        var res = await fetch("/upload/" + NONCE + "/file?name=" + encodeURIComponent(files[i].name), { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob });
        var j = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(j.error || ("ralat " + res.status));
        r.li.className = "ok"; r.st.textContent = "siap"; ok++;
      } catch (err) { r.li.className = "err"; r.st.textContent = String(err.message || err); }
    }
    if (ok) done.hidden = false;
  });
})();
</script></body></html>`;
