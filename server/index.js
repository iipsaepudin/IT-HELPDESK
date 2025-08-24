  import express from 'express';
  import cors from 'cors';
  import dotenv from 'dotenv';
  import fs from 'fs';
  import path from 'path';
  import Database from 'better-sqlite3';
  import TelegramBot from 'node-telegram-bot-api';
  import multer from 'multer';
  import morgan from 'morgan';
  import helmet from 'helmet';
  import nodemailer from 'nodemailer';
  import rateLimit from 'express-rate-limit';
  import bcrypt from 'bcryptjs';
  import jwt from 'jsonwebtoken';
  import { EventEmitter } from 'events';
  import pkg from 'pg';

  dotenv.config();
  const app = express();
  const PORT = process.env.PORT || 8080;
  const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
  const DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
  const DB_FILE = process.env.DB_FILE || './data/helpdesk.db';
  const PG_URL = process.env.PG_URL || '';
  const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const TELEGRAM_NOTIFY_CHAT_ID = process.env.TELEGRAM_NOTIFY_CHAT_ID || '';
  const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || '';
  const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  app.use(morgan('tiny'));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: CLIENT_ORIGIN === '*' ? true : CLIENT_ORIGIN }));
  app.use(express.json({ limit: '8mb' }));
  app.use('/files', express.static(UPLOAD_DIR));

  // Rate limit login
  app.use('/api/login', rateLimit({ windowMs: 60_000, max: 10 }));

  // --- DB Layer ---
  let db = null;
  let pgClient = null;
  const isPg = DB_DRIVER === 'pg';
  if (isPg) {
    const { Client } = pkg;
    pgClient = new Client({ connectionString: PG_URL });
    await pgClient.connect();
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        createdAt TEXT, updatedAt TEXT,
        requesterName TEXT, requesterEmail TEXT,
        whatsappNumber TEXT,
        department TEXT, category TEXT, subcategory TEXT,
        subject TEXT, description TEXT,
        priority TEXT, impact TEXT, status TEXT,
        slaFirstResponseHrs INTEGER, slaResolutionHrs INTEGER,
        dueFirstResponseAt TEXT, dueResolutionAt TEXT,
        attachments TEXT, assetTag TEXT, location TEXT,
        tags TEXT, assignee TEXT
      );
    `);
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, ticketId TEXT, author TEXT, body TEXT, createdAt TEXT
      );
    `);
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, role TEXT
      );
    `);
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS telegram_links (
        chatId TEXT PRIMARY KEY, email TEXT
      );
    `);
  } else {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        createdAt TEXT, updatedAt TEXT,
        requesterName TEXT, requesterEmail TEXT,
        whatsappNumber TEXT,
        department TEXT, category TEXT, subcategory TEXT,
        subject TEXT, description TEXT,
        priority TEXT, impact TEXT, status TEXT,
        slaFirstResponseHrs INTEGER, slaResolutionHrs INTEGER,
        dueFirstResponseAt TEXT, dueResolutionAt TEXT,
        attachments TEXT, assetTag TEXT, location TEXT,
        tags TEXT, assignee TEXT
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, ticketId TEXT, author TEXT, body TEXT, createdAt TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, password TEXT, role TEXT
      );
      CREATE TABLE IF NOT EXISTS telegram_links (
        chatId TEXT PRIMARY KEY, email TEXT
      );
    `);
  }

  // DB utils
  function rowGetOne(sql, params=[]){
    return isPg ? pgClient.query(sql, params).then(r=>r.rows[0]) : db.prepare(sql).get(...params);
  }
  function rowRun(sql, params){
    return isPg ? pgClient.query(sql, params) : db.prepare(sql).run(params || {});
  }
  function rowAll(sql, params=[]){
    return isPg ? pgClient.query(sql, params).then(r=>r.rows) : db.prepare(sql).all(...params);
  }

  // Seed admin
  async function seedAdmin(){
    const has = await rowGetOne(isPg ? 'SELECT id FROM users WHERE email = $1' : 'SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    if (!has) {
      const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      if (isPg) await rowRun('INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,$4)', [`USR-${Date.now()}`, ADMIN_EMAIL, hash, 'admin']);
      else rowRun('INSERT INTO users (id,email,password,role) VALUES (@id,@email,@password,@role)', { id:`USR-${Date.now()}`, email:ADMIN_EMAIL, password:hash, role:'admin' });
      console.log('Seeded admin', ADMIN_EMAIL);
    }
  }
  await seedAdmin();

  // SSE bus
  const bus = new EventEmitter();
  function emit(type, payload) { bus.emit('event', { type, ...payload }); }
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const onEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    bus.on('event', onEvent);
    req.on('close', () => bus.off('event', onEvent));
  });

  // Auth
  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    const u = await rowGetOne(isPg ? 'SELECT * FROM users WHERE email = $1' : 'SELECT * FROM users WHERE email = ?', [email]);
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = bcrypt.compareSync(password, u.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ uid: u.id, role: u.role, email: u.email }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  });

  // Helpers
  const allowedImage = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'];
  const allowedDocs  = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain'];
  const upload = multer({ storage: multer.diskStorage({
      destination: (_, __, cb) => cb(null, UPLOAD_DIR),
      filename: (_, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
    }),
    fileFilter: (_, file, cb) => {
      if ([...allowedImage, ...allowedDocs].includes(file.mimetype)) cb(null, true);
      else cb(new Error('File type not allowed'), false);
    }
  });

  function parseJSON(s, fallback){ try { return JSON.parse(s); } catch { return fallback; } }
  function toTicket(row){
    return { ...row, attachments: parseJSON(row.attachments || '[]', []), tags: parseJSON(row.tags || '[]', []) };
  }

  // API
  app.get('/api/health', (req, res) => res.json({ ok:true }));

  app.get('/api/tickets', async (req, res) => {
    const rows = await rowAll(isPg ? 'SELECT * FROM tickets ORDER BY createdAt DESC' : 'SELECT * FROM tickets ORDER BY datetime(createdAt) DESC');
    res.json(rows.map(toTicket));
  });

  app.post('/api/tickets', async (req, res) => {
    const t = req.body || {};
    if (!t.id) return res.status(400).json({ error: 'id required' });
    if (!t.whatsappNumber) return res.status(400).json({ error: 'whatsappNumber required' });
    const row = {
      ...t,
      requesterEmail: t.requesterEmail ?? null,
      department: t.department ?? null,
      assetTag: t.assetTag ?? null,
      location: t.location ?? null,
      assignee: t.assignee ?? null,
      attachments: JSON.stringify(t.attachments ?? []),
      tags: JSON.stringify(t.tags ?? [])
    };
    if (isPg) {
      await rowRun(`INSERT INTO tickets (id, createdAt, updatedAt, requesterName, requesterEmail, whatsappNumber, department, category, subcategory, subject, description, priority, impact, status, slaFirstResponseHrs, slaResolutionHrs, dueFirstResponseAt, dueResolutionAt, attachments, assetTag, location, tags, assignee)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [row.id,row.createdAt,row.updatedAt,row.requesterName,row.requesterEmail,row.whatsappNumber,row.department,row.category,row.subcategory,row.subject,row.description,row.priority,row.impact,row.status,row.slaFirstResponseHrs,row.slaResolutionHrs,row.dueFirstResponseAt,row.dueResolutionAt,row.attachments,row.assetTag,row.location,row.tags,row.assignee]);
    } else {
      rowRun(`INSERT INTO tickets (id, createdAt, updatedAt, requesterName, requesterEmail, whatsappNumber, department, category, subcategory, subject, description, priority, impact, status, slaFirstResponseHrs, slaResolutionHrs, dueFirstResponseAt, dueResolutionAt, attachments, assetTag, location, tags, assignee)
              VALUES (@id,@createdAt,@updatedAt,@requesterName,@requesterEmail,@whatsappNumber,@department,@category,@subcategory,@subject,@description,@priority,@impact,@status,@slaFirstResponseHrs,@slaResolutionHrs,@dueFirstResponseAt,@dueResolutionAt,@attachments,@assetTag,@location,@tags,@assignee)`, row);
    }
    emit('ticket_created', { ticket: t });
    if (TELEGRAM_NOTIFY_CHAT_ID) notifyTelegram(`🆕 <b>Tiket Baru</b>\n<b>${t.id}</b> — ${t.subject}\nWA: ${t.whatsappNumber}`);
    res.json(t);
  });

  app.patch('/api/tickets/:id', async (req, res) => {
    const { id } = req.params;
    const old = await rowGetOne(isPg ? 'SELECT * FROM tickets WHERE id = $1' : 'SELECT * FROM tickets WHERE id = ?', [id]);
    if (!old) return res.status(404).json({ error: 'not found' });
    const patch = req.body || {};
    const merged = {
      ...old, ...patch,
      attachments: patch.attachments ? JSON.stringify(patch.attachments) : old.attachments,
      tags: patch.tags ? JSON.stringify(patch.tags) : old.tags,
      updatedAt: new Date().toISOString()
    };
    if (isPg) {
      await rowRun(`UPDATE tickets SET createdAt=$2, updatedAt=$3, requesterName=$4, requesterEmail=$5, whatsappNumber=$6, department=$7, category=$8, subcategory=$9, subject=$10, description=$11, priority=$12, impact=$13, status=$14, slaFirstResponseHrs=$15, slaResolutionHrs=$16, dueFirstResponseAt=$17, dueResolutionAt=$18, attachments=$19, assetTag=$20, location=$21, tags=$22, assignee=$23 WHERE id=$1`,
        [merged.id,merged.createdAt,merged.updatedAt,merged.requesterName,merged.requesterEmail,merged.whatsappNumber,merged.department,merged.category,merged.subcategory,merged.subject,merged.description,merged.priority,merged.impact,merged.status,merged.slaFirstResponseHrs,merged.slaResolutionHrs,merged.dueFirstResponseAt,merged.dueResolutionAt,merged.attachments,merged.assetTag,merged.location,merged.tags,merged.assignee]);
    } else {
      rowRun(`UPDATE tickets SET createdAt=@createdAt, updatedAt=@updatedAt, requesterName=@requesterName, requesterEmail=@requesterEmail, whatsappNumber=@whatsappNumber, department=@department, category=@category, subcategory=@subcategory, subject=@subject, description=@description, priority=@priority, impact=@impact, status=@status, slaFirstResponseHrs=@slaFirstResponseHrs, slaResolutionHrs=@slaResolutionHrs, dueFirstResponseAt=@dueFirstResponseAt, dueResolutionAt=@dueResolutionAt, attachments=@attachments, assetTag=@assetTag, location=@location, tags=@tags, assignee=@assignee WHERE id=@id`, merged);
    }
    const parsed = toTicket(merged);
    emit('ticket_updated', { ticket: parsed });
    if (patch.status) notifyTelegram(`♻️ <b>Status</b> ${id} → ${patch.status}`);
    if (patch.assignee) notifyTelegram(`👤 <b>Assignee</b> ${id} → ${patch.assignee}`);
    res.json(parsed);
  });

  app.get('/api/tickets/:id/comments', async (req, res) => {
    const { id } = req.params;
    const rows = await rowAll(isPg ? 'SELECT * FROM comments WHERE ticketId = $1 ORDER BY createdAt DESC' : 'SELECT * FROM comments WHERE ticketId = ? ORDER BY datetime(createdAt) DESC', [id]);
    res.json(rows);
  });

  app.post('/api/tickets/:id/comments', async (req, res) => {
    const { id } = req.params;
    const { body, author='Agent' } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const row = { id: `CMT-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, ticketId: id, author, body, createdAt: new Date().toISOString() };
    if (isPg) await rowRun('INSERT INTO comments (id,ticketId,author,body,createdAt) VALUES ($1,$2,$3,$4,$5)', [row.id,row.ticketId,row.author,row.body,row.createdAt]);
    else rowRun('INSERT INTO comments (id,ticketId,author,body,createdAt) VALUES (@id,@ticketId,@author,@body,@createdAt)', row);
    emit('comment_added', { ticketId: id, comment: row });
    notifyTelegram(`💬 <b>Komentar</b> pada ${id}\n${author}: ${body}`);
    res.json(row);
  });

  app.post('/api/tickets/:id/attachments', upload.single('file'), (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const url = `/files/${req.file.filename}`;
    res.json({ name: req.file.originalname, url });
  });

  // Stats monthly
  app.get('/api/stats/monthly', async (req, res) => {
    const year = Number(req.query.year || new Date().getFullYear());
    const rows = await rowAll(isPg ? 'SELECT * FROM tickets' : 'SELECT * FROM tickets');
    const data = Array.from({length:12},(_,i)=>({month:i+1,total:0,byCategory:{},byStatus:{}}));
    rows.forEach(r=>{
      const m = new Date(r.createdAt).getMonth()+1;
      if (new Date(r.createdAt).getFullYear() !== year) return;
      data[m-1].total++;
      const cat = r.category || 'Other';
      data[m-1].byCategory[cat] = (data[m-1].byCategory[cat]||0)+1;
      data[m-1].byStatus[r.status] = (data[m-1].byStatus[r.status]||0)+1;
    });
    res.json(data);
  });

  // SLA watchdog (minute)
  setInterval(async () => {
    const now = new Date().toISOString();
    const rows = await rowAll(isPg ? `SELECT * FROM tickets WHERE status NOT IN ('Resolved','Closed') AND dueResolutionAt <= $1` : `SELECT * FROM tickets WHERE status NOT IN ('Resolved','Closed') AND datetime(dueResolutionAt) <= datetime(?)`, [now]);
    rows.forEach(r => notifyTelegram(`⏰ <b>SLA Terlewati</b>\n<b>${r.id}</b> — ${r.subject}\nPrioritas: ${r.priority} | WA: ${r.whatsappNumber}`));
  }, 60_000);

  // --- Telegram Command Center ---
  let bot = null;
  function notifyTelegram(text, chatId = TELEGRAM_NOTIFY_CHAT_ID) {
    if (!bot || !chatId) return;
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(()=>{});
  }

  if (TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_URL ? { webHook: true } : { polling: true });
    if (TELEGRAM_WEBHOOK_URL) {
      bot.setWebHook(`${TELEGRAM_WEBHOOK_URL}/telegram/${TELEGRAM_BOT_TOKEN}`);
      app.post(`/telegram/${TELEGRAM_BOT_TOKEN}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
      console.log('Telegram bot using WEBHOOK');
    } else {
      console.log('Telegram bot using POLLING');
    }

    function renderTicket(t) {
      return `<b>${t.id}</b> — ${t.subject}
Status: <b>${t.status}</b> | Prioritas: <b>${t.priority}</b> | Impact: <b>${t.impact}</b>
Requester: ${t.requesterName}${t.requesterEmail ? ' ('+t.requesterEmail+')' : ''}
WA: ${t.whatsappNumber}
Assignee: ${t.assignee || '-'}
Dibuat: ${t.createdAt}`
    }

    bot.onText(/^\/start/, async (msg) => {
      const chatId = msg.chat.id;
      bot.sendMessage(chatId, `Halo ${msg.from?.first_name || ''}! Bot IT Helpdesk siap.
Chat ID: <code>${chatId}</code>

Perintah:
/link email@domain.com  — tautkan email ke chat ini
/ticket TKT-XXXX — detail tiket
/update TKT-XXXX | Status | catatan — update status + komentar
/newticket Subjek | Deskripsi | [Prioritas] | [Impact] | [Email] | [Nama] | [WA]
/mytickets — daftar tiket atas email yg ditautkan
/find kata — cari tiket by id/subject/email/WA
`, { parse_mode: 'HTML' });
    });

    bot.onText(/^\/link\s+(.+)/, async (msg, match) => {
      const chatId = String(msg.chat.id);
      const email = (match?.[1]||'').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bot.sendMessage(chatId, 'Email tidak valid');
      if (isPg) await rowRun('INSERT INTO telegram_links (chatId,email) VALUES ($1,$2) ON CONFLICT (chatId) DO UPDATE SET email=EXCLUDED.email', [chatId, email]);
      else rowRun('INSERT INTO telegram_links (chatId,email) VALUES (@chatId,@email) ON CONFLICT(chatId) DO UPDATE SET email=@email', { chatId, email });
      bot.sendMessage(chatId, `Linked ✅ ke <b>${email}</b>`, { parse_mode: 'HTML' });
    });

    bot.onText(/^\/ticket\s+(.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const id = (match?.[1] || '').trim();
      const t = await rowGetOne(isPg ? 'SELECT * FROM tickets WHERE id = $1' : 'SELECT * FROM tickets WHERE id = ?', [id]);
      if (!t) return bot.sendMessage(chatId, 'Ticket tidak ditemukan');
      bot.sendMessage(chatId, renderTicket(toTicket(t)), { parse_mode: 'HTML' });
    });

    bot.onText(/^\/update\s+(.+)/s, async (msg, match) => {
      const chatId = msg.chat.id;
      const parts = (match?.[1] || '').split('|').map(s=>s.trim());
      const [id, status, notes=''] = parts;
      if (!id || !status) return bot.sendMessage(chatId, 'Format: /update ID | Status | [catatan]');
      const t = await rowGetOne(isPg ? 'SELECT * FROM tickets WHERE id = $1' : 'SELECT * FROM tickets WHERE id = ?', [id]);
      if (!t) return bot.sendMessage(chatId, 'Ticket tidak ditemukan');
      const merged = { ...t, status, updatedAt: new Date().toISOString() };
      if (isPg) await rowRun('UPDATE tickets SET status=$2, updatedAt=$3 WHERE id=$1', [id, status, merged.updatedAt]);
      else rowRun('UPDATE tickets SET status=@status, updatedAt=@updatedAt WHERE id=@id', { id, status, updatedAt: merged.updatedAt });
      if (notes) {
        const c = { id:`CMT-${Date.now()}`, ticketId:id, author:'Telegram', body:notes, createdAt:new Date().toISOString() };
        if (isPg) await rowRun('INSERT INTO comments (id,ticketId,author,body,createdAt) VALUES ($1,$2,$3,$4,$5)', [c.id,c.ticketId,c.author,c.body,c.createdAt]);
        else rowRun('INSERT INTO comments (id,ticketId,author,body,createdAt) VALUES (@id,@ticketId,@author,@body,@createdAt)', c);
      }
      const t2 = await rowGetOne(isPg ? 'SELECT * FROM tickets WHERE id = $1' : 'SELECT * FROM tickets WHERE id = ?', [id]);
      emit('ticket_updated', { ticket: toTicket(t2) });
      bot.sendMessage(chatId, `Update ✅\n${renderTicket(toTicket(t2))}`, { parse_mode: 'HTML' });
    });

    bot.onText(/^\/newticket\s+(.+)/s, async (msg, match) => {
      const chatId = msg.chat.id;
      const payload = (match?.[1] || '').split('|').map(s => s.trim());
      const [subject, description, priority='Medium', impact='Moderate', email='user@example.com', name='Telegram User', wa='6280000000000'] = payload;
      if (!subject || !description || !wa) return bot.sendMessage(chatId, 'Format: /newticket Subjek | Deskripsi | [Prioritas] | [Impact] | [Email] | [Nama] | [WA]');
      const id = `TKT-${new Date().getFullYear()}-${Math.random().toString(36).slice(2,10).toUpperCase()}`;
      const createdAt = new Date().toISOString();
      const t = { id, createdAt, updatedAt: createdAt, requesterName: name, requesterEmail: email||null, whatsappNumber: wa, department: null, category: 'Account', subcategory: 'Password Reset', subject, description, priority, impact, status: 'New', slaFirstResponseHrs: 4, slaResolutionHrs: 48, dueFirstResponseAt: createdAt, dueResolutionAt: createdAt, attachments: '[]', assetTag: null, location: null, tags: '[]', assignee: null };
      if (isPg) await rowRun(`INSERT INTO tickets (id,createdAt,updatedAt,requesterName,requesterEmail,whatsappNumber,department,category,subcategory,subject,description,priority,impact,status,slaFirstResponseHrs,slaResolutionHrs,dueFirstResponseAt,dueResolutionAt,attachments,assetTag,location,tags,assignee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, [t.id,t.createdAt,t.updatedAt,t.requesterName,t.requesterEmail,t.whatsappNumber,t.department,t.category,t.subcategory,t.subject,t.description,t.priority,t.impact,t.status,t.slaFirstResponseHrs,t.slaResolutionHrs,t.dueFirstResponseAt,t.dueResolutionAt,t.attachments,t.assetTag,t.location,t.tags,t.assignee]);
      else rowRun(`INSERT INTO tickets (id,createdAt,updatedAt,requesterName,requesterEmail,whatsappNumber,department,category,subcategory,subject,description,priority,impact,status,slaFirstResponseHrs,slaResolutionHrs,dueFirstResponseAt,dueResolutionAt,attachments,assetTag,location,tags,assignee) VALUES (@id,@createdAt,@updatedAt,@requesterName,@requesterEmail,@whatsappNumber,@department,@category,@subcategory,@subject,@description,@priority,@impact,@status,@slaFirstResponseHrs,@slaResolutionHrs,@dueFirstResponseAt,@dueResolutionAt,@attachments,@assetTag,@location,@tags,@assignee)`, t);
      emit('ticket_created', { ticket: toTicket(t) });
      bot.sendMessage(chatId, `✅ Tiket dibuat: ${id}`, { parse_mode: 'HTML' });
    });

    bot.onText(/^\/mytickets/, async (msg) => {
      const chatId = String(msg.chat.id);
      const link = await rowGetOne(isPg ? 'SELECT * FROM telegram_links WHERE chatId = $1' : 'SELECT * FROM telegram_links WHERE chatId = ?', [chatId]);
      if (!link?.email) return bot.sendMessage(chatId, 'Belum tertaut. Gunakan /link email@domain.com');
      const rows = await rowAll(isPg ? 'SELECT * FROM tickets WHERE requesterEmail = $1 ORDER BY createdAt DESC LIMIT 10' : 'SELECT * FROM tickets WHERE requesterEmail = ? ORDER BY datetime(createdAt) DESC LIMIT 10', [link.email]);
      if (!rows.length) return bot.sendMessage(chatId, 'Tidak ada tiket.');
      const text = rows.map(r => `${r.id} — ${r.subject} [${r.status}]`).join('\n');
      bot.sendMessage(chatId, `<b>Tiket milik ${link.email}</b>\n${text}`, { parse_mode: 'HTML' });
    });

    bot.onText(/^\/find\s+(.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const q = (match?.[1]||'').toLowerCase();
      const rows = await rowAll(isPg ? 'SELECT * FROM tickets' : 'SELECT * FROM tickets');
      const list = rows.filter(r => (r.id + ' ' + r.subject + ' ' + (r.requesterEmail||'') + ' ' + (r.whatsappNumber||'')).toLowerCase().includes(q)).slice(0, 10);
      if (!list.length) return bot.sendMessage(chatId, 'Tidak ketemu');
      const text = list.map(r => `${r.id} — ${r.subject} [${r.status}]`).join('\n');
      bot.sendMessage(chatId, text);
    });
  } else {
    console.log('Telegram bot not configured');
  }

  app.get('/api/telegram/test', (req, res) => { try { notifyTelegram('🔔 Test notifikasi dari IT Helpdesk'); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok:false, error:String(e) }); } });

  app.listen(PORT, () => console.log(`Server http://localhost:${PORT}`));
