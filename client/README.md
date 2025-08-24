# IT Helpdesk – Client (Enterprise V2, WA required)
- React + Vite + TS + Tailwind + Recharts
- Login overlay (langsung hilang setelah sukses) + JWT storage
- Dashboard: filter per tahun (grafik bulanan), kategori & status
- Form tiket: **Nomor WhatsApp wajib**, Email opsional
- Tabel: filter bulan/kategori, pencarian WA
- Detail tiket, Komentar (via backend), Lampiran (upload)
- SSE realtime

## Jalankan
```bash
npm install
cp .env.example .env
# set VITE_API_URL=http://localhost:8080
npm run dev
```
