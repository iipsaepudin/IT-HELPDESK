# IT Helpdesk – Server (Enterprise V2, WA required)

## Jalankan
```bash
npm install
cp .env.example .env
# set TELEGRAM_BOT_TOKEN, lalu /start di Telegram, dapatkan chat id jika ingin broadcast (TELEGRAM_NOTIFY_CHAT_ID)
npm start
```

- API: http://localhost:8080
- Files: http://localhost:8080/files/<filename>

## Fitur
- REST API tiket + komentar + upload (gambar & dokumen Office/PDF)
- Field wajib: **whatsappNumber**
- SSE realtime `/api/events`
- Telegram Command Center: /link, /ticket, /update, /newticket, /mytickets, /find
- Login aman (bcrypt + JWT), rate-limit login
- SLA watchdog, notifikasi Telegram
- SQLite default, bisa switch ke Postgres via `DB_DRIVER=pg` + `PG_URL`
