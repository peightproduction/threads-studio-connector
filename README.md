# Threads Studio

Connector untuk **Claude** yang bercakap terus dengan akaun Threads awak melalui **API rasmi Meta**. Awak bersembang dengan Claude macam biasa; Claude yang tulis, connector ini simpan data awak, jalankan tindakan dan tunjuk kad boleh diklik dalam chat.

*A Claude connector for your own Threads account, through Meta's official Threads API. Each person runs their own copy: nobody else holds your token or your data.*

## Apa yang awak dapat
- **Tracker**: post hari ni lawan sasaran, minggu, bulan, streak, 30 hari, dan queue.
- **Tab Studio**: ruang kerja awak. Claude tulis post, thread atau poster **hanya bila awak minta**. Ada kad kosong untuk tulis sendiri, dan butang Poster Canva.
- **Draf, jadual, post sekarang** (post sekarang perlukan dua tekan). Jadual berjalan melalui pemasa percuma.
- **Ubah draf atau post berjadual** terus dari Tracker.
- **Bank gambar** (JPEG/PNG) untuk post bergambar dan carousel sehingga 20 gambar.
- **Nombor sebenar**: views, suka, balasan, waktu terbaik, winning posts, hook yang menjadi.
- **Baca komen** di bawah post awak, dan **padam post** (selepas awak setuju).

## Cara paling mudah: biar Claude pandu
Awak tak perlu faham kod. Tampal fail **SETUP-FULL.md** (dalam folder `docs/`, atau yang dihantar bersama kit ini) ke dalam chat Claude, tulis `start`, dan Claude pandu langkah demi langkah: akaun Meta, Vercel, Redis, pemasa, dan sambungan ke Claude. Ambil masa kira-kira 30 hingga 45 minit sekali sahaja.

## Cara manual (untuk yang biasa)
1. Buat app Meta dengan use case **Access the Threads API**, tambah diri awak sebagai **Threads Tester**, dan salin **Threads App ID** serta **Threads App secret**.
2. Deploy ke Vercel: [**Deploy dengan Vercel**](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpeightproduction%2Fthreads-studio-connector&project-name=threads-studio&repository-name=threads-studio&env=THREADS_APP_ID,THREADS_APP_SECRET,MCP_TOKEN,TICK_TOKEN&envDescription=Threads%20App%20ID%20and%20secret%20from%20your%20Meta%20app%3B%20MCP_TOKEN%20and%20TICK_TOKEN%20are%20two%20different%20long%20random%20values%20(24%2B%20characters)). Isi `THREADS_APP_ID`, `THREADS_APP_SECRET`, `MCP_TOKEN` dan `TICK_TOKEN` (dua nilai rawak panjang, 24 aksara atau lebih, berbeza).
3. Di Vercel: **Storage** > **Create Database** > **Upstash Redis**, sambung pada projek, **Redeploy**. (Pilihan: **Blob**, jenis **Public**, untuk gambar.)
4. Buka `https://<domain-awak>/setup`: halaman ini tunjuk apa yang sudah siap dan tiga alamat yang perlu diisi dalam Meta (Redirect, Uninstall/Deauthorize, Delete).
5. Dalam Claude: **Customize > Connectors > Add custom connector**, alamat `https://<domain-awak>/mcp/<MCP_TOKEN>`, pilih **No sign in**. Buka chat baharu, hidupkan connector (+ > Connectors), tulis `sambung Threads`, tekan **Allow**.
6. Pemasa: buat cronjob percuma di cron-job.org yang melawat `https://<domain-awak>/tick/<TICK_TOKEN>` setiap 5 minit.

## Keselamatan
- `MCP_TOKEN` dalam alamat ialah satu-satunya kata laluan connector. Anggap alamat penuh itu rahsia; salah token memberi 404.
- Pemasa guna token berbeza (`TICK_TOKEN`) yang tak boleh buka connector.
- Token Threads disimpan dalam Redis di akaun Vercel/Upstash awak sendiri. Pembuat kit ini tiada akses kepada token, draf atau data awak.
- Tiada apa dipost tanpa awak minta. Default ialah **draf** atau **jadual**; post sekarang perlukan pengesahan. Teks yang sama ditolak jika sudah dipost atau didraf dalam 24 jam.
- Kebenaran yang diminta daripada Meta hanya untuk akaun awak sendiri: baca post, terbit, insights, padam post, baca dan urus komen. Tiada follow, like atau mesej kepada orang lain.
- Jangan masukkan nilai sebenar dalam fail `.env.example` atau GitHub. Rahsia hanya di Vercel (Settings > Environment Variables).

## Had yang jujur
- Threads tiada draf atau jadual dalam API-nya, jadi connector ini yang simpan, dan pemasa memicu penerbitan. Tanpa pemasa, jadual hanya jalan bila awak guna Claude selepas masanya.
- Post yang sudah live **tak boleh diedit** (Threads tiada edit); hanya boleh dipadam.
- Waktu jadual dalam **waktu Malaysia (UTC+8)**.
- App Meta kekal dalam mod pembangunan (hanya awak sebagai tester). Itu memadai untuk satu akaun.
- Vercel pelan percuma (Hobby) ialah untuk kegunaan **peribadi, bukan komersial** menurut syarat Vercel. Kalau Threads awak untuk bisnes, semak syarat Vercel dan pertimbangkan pelan berbayar.
- Gambar yang dilampir terus dalam chat Claude tak boleh dihantar ke connector; muat naik melalui kad dalam chat.

## Pembangunan
```
npm install
npm test          # ujian: metrik, had Threads, queue, OAuth, bank gambar, setiap tool melalui protokol MCP
npm run build     # bina widget dan benamkan dalam src/ui-html.generated.ts
npm run dev       # server tempatan
```
Kod dijana daripada connector peribadi ASMOS Autoflow; lesen MIT, lihat `LICENSE`. Repo: https://github.com/peightproduction/threads-studio-connector
