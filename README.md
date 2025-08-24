# IT Helpdesk Enterprise V2 (WhatsApp wajib) – Fixed

## Struktur
- client/ — React+TS+Tailwind, Dashboard & UX responsif
- server/ — Express+SQLite/PG, Telegram command center, SSE, uploads

## Jalankan Lokal
### Server
```bash
cd server
npm install
cp .env.example .env
# Edit .env (Telegram token, dsb.)
npm start
```
### Client
```bash
cd client
npm install
cp .env.example .env       # VITE_API_URL=http://localhost:8080
npm run dev
```

## Docker (opsional)
```bash
docker compose up --build
```
- Client: http://localhost:5173
- Server: http://localhost:8080

## Catatan
- Ganti `ADMIN_PASSWORD` & `JWT_SECRET` sebelum produksi
- Pastikan Node ≥ 18 (disarankan 20)
