
  import React, { useEffect, useMemo, useState } from "react";
  import { login, hasApi, listTickets, createTicket, patchTicket, listComments, addComment, uploadAttachment, getStats, type Ticket as ApiTicket, type Comment, type StatsMonthly } from "./lib/api";
  import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

  const PRIORITIES = ["Low", "Medium", "High", "Critical"] as const;
  const IMPACTS = ["Minor", "Moderate", "Major"] as const;
  const STATUSES = ["New", "In Progress", "Waiting", "Resolved", "Closed"] as const;
  const CATEGORIES: Record<string, string[]> = {
    "Account": ["Password Reset", "Locked Account", "2FA"],
    "Hardware": ["Laptop", "Printer", "Network"],
    "Software": ["Email", "Office Suite", "Line of Business App"],
    "Access Request": ["New App Access", "VPN", "Shared Drive"],
  };

  const STORAGE_KEY = "helpdesk_tickets_v2";
  const uid = () => Math.random().toString(36).slice(2, 10);
  const nowISO = () => new Date().toISOString();
  function classNames(...xs: (string | false | null | undefined)[]) { return xs.filter(Boolean).join(" "); }
  function computeSLA(priority: Ticket["priority"], impact: Ticket["impact"]) {
    const SLA_MATRIX: Record<(typeof PRIORITIES)[number], { minor: [number, number]; moderate: [number, number]; major: [number, number] }> = {
      Low: { minor: [8, 72], moderate: [8, 72], major: [8, 72] },
      Medium: { minor: [4, 48], moderate: [4, 48], major: [4, 48] },
      High: { minor: [2, 24], moderate: [2, 24], major: [2, 24] },
      Critical: { minor: [1, 8], moderate: [1, 8], major: [1, 8] },
    };
    const lvl = impact.toLowerCase() as "minor" | "moderate" | "major";
    const [first, resolve] = SLA_MATRIX[priority][lvl];
    const firstResponse = new Date(); firstResponse.setHours(firstResponse.getHours() + first);
    const resolution = new Date(); resolution.setHours(resolution.getHours() + resolve);
    return { slaFirstResponseHrs: first, slaResolutionHrs: resolve, dueFirstResponseAt: firstResponse.toISOString(), dueResolutionAt: resolution.toISOString() };
  }

  type Ticket = ApiTicket;
  function loadLocal(): Ticket[] { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; } }
  function saveLocal(tickets: Ticket[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets)); }

  function useAuth() {
    const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
    function signIn(t: string){ localStorage.setItem('token', t); setToken(t); }
    function signOut(){ localStorage.removeItem('token'); setToken(null); }
    return { token, signIn, signOut };
  }

  function LoginOverlay({ onDone }: { onDone: () => void }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    async function submit(e: React.FormEvent) {
      e.preventDefault();
      setErr(null); setLoading(true);
      try {
        if (hasApi) {
          const res = await login(email, password);
          localStorage.setItem('token', res.token);
        } else {
          localStorage.setItem('token', 'demo');
        }
        onDone();
      } catch (e:any) {
        setErr(e?.message || 'Login gagal');
      } finally { setLoading(false); }
    }

    return (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
        <div className="w-full max-w-md card">
          <h2 className="text-xl font-semibold mb-2">Masuk</h2>
          <p className="text-sm text-slate-500 mb-4">Gunakan akun admin/agent Anda.</p>
          {err && <div className="mb-3 text-sm rounded border border-red-300 bg-red-50 p-2 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{err}</div>}
          <form onSubmit={submit} className="space-y-3">
            <input className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" type="email" placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} />
            <input className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" type="password" placeholder="password" value={password} onChange={e=>setPassword(e.target.value)} />
            <button className="btn bg-slate-900 text-white dark:bg-white dark:text-slate-900 w-full" disabled={loading}>{loading ? 'Masuk...' : 'Masuk'}</button>
          </form>
        </div>
      </div>
    );
  }

  function Header({ onToggleDark, dark, onSignOut }: { onToggleDark: ()=>void; dark:boolean; onSignOut: ()=>void }){
    return (
      <header className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/70 dark:supports-[backdrop-filter]:bg-slate-950/60 border-b dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg md:text-xl font-bold">IT Helpdesk Enterprise</div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onToggleDark} className="btn border dark:border-slate-700">{dark ? '☀️ Light' : '🌙 Dark'}</button>
            <button onClick={onSignOut} className="btn border dark:border-slate-700">Keluar</button>
          </div>
        </div>
      </header>
    )
  }

  function Dashboard({ tickets }: { tickets: Ticket[] }){
    const [year, setYear] = useState<number>(new Date().getFullYear());
    const [stats, setStats] = useState<StatsMonthly[]|null>(null);

    useEffect(()=>{
      (async () => {
        try {
          if (!hasApi) {
            const months = Array.from({length:12},(_,i)=>i+1);
            const data: StatsMonthly[] = months.map(m=>({month:m,total:0,byCategory:{},byStatus:{}}));
            for(const t of tickets){
              const m = new Date(t.createdAt).getMonth()+1;
              if (new Date(t.createdAt).getFullYear() !== year) continue;
              const row = data[m-1];
              row.total++;
              row.byCategory[t.category] = (row.byCategory[t.category]||0)+1;
              row.byStatus[t.status] = (row.byStatus[t.status]||0)+1;
            }
            setStats(data);
          } else {
            const d = await getStats(year);
            setStats(d);
          }
        } catch (e) { console.error(e); }
      })();
    }, [tickets, year]);

    const chartData = (stats||[]).map(s=>({ name: s.month, Total: s.total, Resolved: s.byStatus?.['Resolved']||0, New: s.byStatus?.['New']||0 }));

    return (
      <section className="card">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="font-semibold text-lg">Dashboard</h3>
          <select className="border rounded px-2 py-1 dark:bg-slate-900 dark:border-slate-700" value={year} onChange={e=>setYear(Number(e.target.value))}>
            {Array.from({length:5},(_,i)=>new Date().getFullYear()-i).map(y=>(<option key={y} value={y}>{y}</option>))}
          </select>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis allowDecimals={false}/>
              <Tooltip />
              <Legend />
              <Bar dataKey="Total" />
              <Bar dataKey="Resolved" />
              <Bar dataKey="New" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    )
  }

  function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
    return (
      <label className="block mb-3">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-200">{label} {required && <span className="text-red-500">*</span>}</span>
        {children}
      </label>
    );
  }
  function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "blue" | "green" | "yellow" | "red" | "purple" }) {
    const tones: Record<string, string> = {
      slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
      blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      green: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
      yellow: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
      red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
      purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    };
    return <span className={["inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium", tones[tone]].join(" ")}>{children}</span>;
  }

  function TicketForm({ onSubmit }: { onSubmit: (t: Ticket) => void }) {
    const [requesterName, setRequesterName] = useState("");
    const [requesterEmail, setRequesterEmail] = useState("");
    const [whatsapp, setWhatsapp] = useState("");
    const [department, setDepartment] = useState("");
    const [category, setCategory] = useState<keyof typeof CATEGORIES | "">("");
    const [subcategory, setSubcategory] = useState("");
    const [subject, setSubject] = useState("");
    const [description, setDescription] = useState("");
    const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("Medium");
    const [impact, setImpact] = useState<(typeof IMPACTS)[number]>("Moderate");
    const [assetTag, setAssetTag] = useState("");
    const [location, setLocation] = useState("");
    const [agree, setAgree] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const subs = useMemo(() => (category ? CATEGORIES[category] : []), [category]);

    function normalizeWa(v: string) {
      let s = v.replace(/\D/g, '');
      if (s.startsWith('0')) s = '62' + s.slice(1);
      return s;
    }

    function validate() {
      if (!requesterName.trim()) return "Nama pemohon wajib diisi";
      const wa = normalizeWa(whatsapp);
      if (!/^[0-9]{10,15}$/.test(wa)) return "Nomor WhatsApp tidak valid";
      if (!category) return "Kategori wajib dipilih";
      if (!subcategory) return "Subkategori wajib dipilih";
      if (!subject.trim()) return "Subjek wajib diisi";
      if (!description.trim()) return "Deskripsi wajib diisi";
      if (!agree) return "Anda harus menyetujui kebijakan penggunaan";
      return null;
    }

    async function handleSubmit(e: React.FormEvent) {
      e.preventDefault();
      const err = validate(); if (err) { setError(err); return; }
      const createdAt = nowISO();
      const waNorm = normalizeWa(whatsapp);
      const base: Ticket = {
        id: `TKT-${new Date().getFullYear()}-${uid().toUpperCase()}`,
        createdAt, updatedAt: createdAt,
        requesterName, requesterEmail: requesterEmail || undefined, whatsappNumber: waNorm,
        department: department || undefined,
        category: (category || "Account") as string,
        subcategory, subject, description, priority, impact,
        status: "New",
        attachments: [], assetTag: assetTag || undefined, location: location || undefined,
        tags: [], assignee: undefined,
        ...computeSLA(priority, impact),
      };
      try {
        if (hasApi) onSubmit(await createTicket(base)); else onSubmit(base);
        setRequesterName(""); setRequesterEmail(""); setWhatsapp(""); setDepartment(""); setCategory(""); setSubcategory("");
        setSubject(""); setDescription(""); setPriority("Medium"); setImpact("Moderate");
        setAgree(false); setError(null);
      } catch (e:any) {
        onSubmit(base);
        setError(`API gagal (${e?.message||'unknown'}). Tiket disimpan lokal.`);
      }
    }

    return (
      <form onSubmit={handleSubmit} className="space-y-4" aria-labelledby="ticket-form-title">
        <h2 id="ticket-form-title" className="text-xl font-semibold">Ajukan Tiket</h2>
        {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</div>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Nama" required><input value={requesterName} onChange={e => setRequesterName(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Nama lengkap" /></Field>
          <Field label="Nomor WhatsApp" required><input type="tel" value={whatsapp} onChange={e => setWhatsapp(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="6281234567890" /></Field>
          <Field label="Email (opsional)"><input type="email" value={requesterEmail} onChange={e => setRequesterEmail(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="nama@perusahaan.com" /></Field>
          <Field label="Departemen"><input value={department} onChange={e => setDepartment(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Mis. Finance" /></Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Kategori" required>
            <select value={category} onChange={e => { setCategory(e.target.value as any); setSubcategory(""); }} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
              <option value="">Pilih kategori</option>
              {Object.keys(CATEGORIES).map(k => (<option key={k} value={k}>{k}</option>))}
            </select>
          </Field>
          <Field label="Subkategori" required>
            <select value={subcategory} onChange={e => setSubcategory(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" disabled={!category}>
              <option value="">{category ? "Pilih subkategori" : "Pilih kategori dulu"}</option>
              {subs.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Prioritas" required>
            <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
              {PRIORITIES.map(p => <option key={p}>{p}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Dampak (Impact)" required>
            <select value={impact} onChange={e => setImpact(e.target.value as any)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
              {IMPACTS.map(i => <option key={i}>{i}</option>)}
            </select>
          </Field>
          <Field label="Asset Tag"><input value={assetTag} onChange={e => setAssetTag(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Mis. NB-0231" /></Field>
          <Field label="Lokasi"><input value={location} onChange={e => setLocation(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="HQ - Lantai 5" /></Field>
        </div>

        <Field label="Subjek" required><input value={subject} onChange={e => setSubject(e.target.value)} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Ringkasan singkat masalah" /></Field>
        <Field label="Deskripsi" required><textarea value={description} onChange={e => setDescription(e.target.value)} rows={5} className="w-full rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700" placeholder="Jelaskan masalah, langkah yang sudah dicoba, pesan error, dll." /></Field>

        <label className="flex items-start gap-3">
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-1" />
          <span className="text-sm text-slate-600 dark:text-slate-300">Saya menyetujui kebijakan penggunaan dan bahwa informasi yang saya berikan benar.</span>
        </label>

        <button type="submit" className="btn bg-slate-900 text-white dark:bg-white dark:text-slate-900 hover:opacity-90">Kirim Tiket</button>
      </form>
    );
  }

  function TicketTable({ tickets, onUpdate, onOpen }: { tickets: Ticket[]; onUpdate: (t: Ticket) => void; onOpen: (t: Ticket) => void }) {
    const [q, setQ] = useState("");
    const [status, setStatus] = useState<string>("All");
    const [priority, setPriority] = useState<string>("All");
    const [month, setMonth] = useState<number>(0);
    const [category, setCategory] = useState<string>("All");

    const filtered = tickets.filter(t => {
      const matchQ = q
        ? [t.id, t.subject, t.description, t.requesterEmail||'', t.requesterName, t.whatsappNumber, t.category, t.subcategory].join(" ").toLowerCase().includes(q.toLowerCase())
        : true;
      const matchStatus = status === "All" ? true : t.status === status;
      const matchPriority = priority === "All" ? true : t.priority === (priority as any);
      const matchMonth = month === 0 ? true : (new Date(t.createdAt).getMonth()+1) === month;
      const matchCat = category === "All" ? true : t.category === category;
      return matchQ && matchStatus && matchPriority && matchMonth && matchCat;
    });

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input placeholder="Cari id/subjek/pemohon/WA/kategori..." value={q} onChange={e => setQ(e.target.value)} className="rounded-lg border px-3 py-2 w-full md:w-80 dark:bg-slate-900 dark:border-slate-700" />
          <select value={status} onChange={e => setStatus(e.target.value)} className="rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
            {(["All", ...STATUSES] as string[]).map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={priority} onChange={e => setPriority(e.target.value)} className="rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
            {(["All", ...PRIORITIES] as string[]).map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={month} onChange={e => setMonth(Number(e.target.value))} className="rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
            <option value={0}>Semua Bulan</option>
            {Array.from({length:12},(_,i)=>i+1).map(m=>(<option key={m} value={m}>{m}</option>))}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border px-3 py-2 dark:bg-slate-900 dark:border-slate-700">
            {(["All", ...Object.keys(CATEGORIES)] as string[]).map(c => <option key={c}>{c}</option>)}
          </select>
        </div>

        <div className="overflow-auto rounded-xl border dark:border-slate-700">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60">
              <tr>
                {"ID,Subjek,Pemohon,WhatsApp,Prioritas,Status,Kategori,Subkategori,Dibuat,Assignee,SLA-Res,Aksi".split(",").map(h => (
                  <th key={h} className="text-left px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="border-t dark:border-slate-800">
                  <td className="px-3 py-2 font-mono text-xs">{t.id}</td>
                  <td className="px-3 py-2">{t.subject}</td>
                  <td className="px-3 py-2">{t.requesterName} <span className="text-xs text-slate-500">{t.requesterEmail ? `(${t.requesterEmail})` : ''}</span></td>
                  <td className="px-3 py-2">{t.whatsappNumber}</td>
                  <td className="px-3 py-2"><Badge tone={{ Low: "slate", Medium: "blue", High: "yellow", Critical: "red" }[t.priority]}>{t.priority}</Badge></td>
                  <td className="px-3 py-2">{t.status}</td>
                  <td className="px-3 py-2">{t.category}</td>
                  <td className="px-3 py-2">{t.subcategory}</td>
                  <td className="px-3 py-2">{new Date(t.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <input value={t.assignee || ""} onChange={async e => {
                      const name = e.target.value;
                      try { onUpdate(await (hasApi ? patchTicket(t.id, { assignee: name }) : Promise.resolve({ ...t, assignee: name } as Ticket))); }
                      catch (e) { console.error(e); }
                    }} placeholder="nama agent" className="w-36 rounded border px-2 py-1 text-xs dark:bg-slate-900 dark:border-slate-700" />
                  </td>
                  <td className="px-3 py-2 text-xs">{new Date(t.dueResolutionAt).toLocaleString()}</td>
                  <td className="px-3 py-2"><button onClick={() => onOpen(t)} className="text-xs rounded border px-2 py-1 dark:border-slate-700">Detail</button></td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-500">Tidak ada tiket</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  type TicketDetailModalProps = { ticket: Ticket; onClose: () => void; onPatched: (t: Ticket)=>void };
  function TicketDetailModal({ ticket, onClose, onPatched }: TicketDetailModalProps) {
    const [comments, setComments] = useState<Comment[]>([]);
    const [body, setBody] = useState("");
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
      let mounted = true;
      (async () => {
        try {
          if (hasApi) {
            const list = await listComments(ticket.id); if (mounted) setComments(list);
          }
        } catch (e) { console.error(e); }
      })();
      return () => { mounted = false; }
    }, [ticket.id]);

    async function sendComment() {
      if (!body.trim()) return;
      try {
        if (!hasApi) { setBody(""); return; }
        const c = await addComment(ticket.id, body);
        setComments(prev => [c, ...prev]);
        setBody("");
      } catch (e) { console.error(e); }
    }

    async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
      if (!hasApi || !e.target.files?.length) return;
      setUploading(true);
      try {
        const file = e.target.files[0];
        const res = await uploadAttachment(ticket.id, file);
        const updated = await patchTicket(ticket.id, { attachments: [...ticket.attachments, { name: res.name, url: res.url }] });
        onPatched(updated as any);
      } catch (e) { console.error(e); }
      finally { setUploading(false); (e.target as any).value = ""; }
    }

    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="w-full max-w-3xl card" onClick={e => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-4">
            <div><div className="text-lg font-semibold">{ticket.subject}</div><div className="text-xs text-slate-500">{ticket.id} • {ticket.category}/{ticket.subcategory}</div></div>
            <button onClick={onClose} className="text-sm rounded border px-2 py-1 dark:border-slate-700">Tutup</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div className="md:col-span-2 space-y-3">
              <div className="rounded-lg border p-3 dark:border-slate-700"><div className="text-sm whitespace-pre-wrap">{ticket.description}</div></div>
              <div className="rounded-lg border p-3 dark:border-slate-700">
                <div className="font-semibold mb-2">Komentar</div>
                {hasApi ? (
                  <div className="space-y-3">
                    <div className="flex items-start gap-2">
                      <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} className="flex-1 rounded border px-2 py-1 text-sm dark:bg-slate-900 dark:border-slate-700" placeholder="Tulis komentar..." />
                      <button onClick={sendComment} className="rounded border px-3 py-1 text-sm dark:border-slate-700">Kirim</button>
                    </div>
                    <div className="space-y-2 max-h-64 overflow-auto">
                      {comments.map(c => (<div key={c.id} className="rounded border px-3 py-2 text-sm dark:border-slate-800"><div className="text-xs text-slate-500 mb-1">{new Date(c.createdAt).toLocaleString()} • {c.author}</div><div>{c.body}</div></div>))}
                      {!comments.length && <div className="text-xs text-slate-500">Belum ada komentar</div>}
                    </div>
                  </div>
                ) : <div className="text-xs text-slate-500">Komentar aktif jika terhubung ke API</div>}
              </div>
            </div>
            <div className="space-y-3">
              <div className="rounded-lg border p-3 dark:border-slate-700">
                <div className="font-semibold mb-2">Properti</div>
                <div className="text-sm space-y-1">
                  <div>Status: <b>{ticket.status}</b></div>
                  <div>Prioritas: <b>{ticket.priority}</b> • Impact: <b>{ticket.impact}</b></div>
                  <div>Requester: <b>{ticket.requesterName}</b> {ticket.requesterEmail ? `(${ticket.requesterEmail})` : ''}</div>
                  <div>WhatsApp: <b>{ticket.whatsappNumber}</b></div>
                  {ticket.assignee && <div>Assignee: <b>{ticket.assignee}</b></div>}
                  <div>Due: <span className="text-xs">{new Date(ticket.dueResolutionAt).toLocaleString()}</span></div>
                </div>
              </div>
              <div className="rounded-lg border p-3 dark:border-slate-700">
                <div className="font-semibold mb-2">Lampiran</div>
                {hasApi && <input type="file" onChange={onFileChosen} disabled={uploading} />}
                <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
                  {ticket.attachments?.map((a, i) => (<li key={i}><a className="underline" target="_blank" href={a.url || '#'} rel="noreferrer">{a.name}</a></li>))}
                  {!ticket.attachments?.length && <li className="text-slate-500">Tidak ada lampiran</li>}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  export default function App() {
    const [tickets, setTickets] = useState<Ticket[]>([]);
    const [tab, setTab] = useState<"dashboard" | "submit" | "table">("dashboard");
    const [dark, setDark] = useState<boolean>(() => document.documentElement.classList.contains("dark"));
    const [open, setOpen] = useState<Ticket | null>(null);
    const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));

    useEffect(() => {
      (async () => {
        try {
          if (hasApi) { setTickets(await listTickets()); }
          else { setTickets(loadLocal()); }
        } catch (e) { console.error(e); setTickets(loadLocal()); }
      })();
    }, []);

    useEffect(() => { if (!hasApi) saveLocal(tickets); }, [tickets]);
    useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);

    // SSE realtime
    useEffect(() => {
      if (!hasApi) return;
      const url = (import.meta as any).env.VITE_API_URL + "/api/events";
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data);
          if (e.type === 'ticket_created') setTickets(prev => [e.ticket, ...prev]);
          if (e.type === 'ticket_updated') setTickets(prev => prev.map(t => t.id === e.ticket.id ? e.ticket : t));
        } catch (e) { console.error(e); }
      };
      return () => es.close();
    }, []);

    function addTicket(t: Ticket) { setTickets(prev => [t, ...prev]); }
    function updateTicket(updated: Ticket) { setTickets(prev => prev.map(t => (t.id === updated.id ? updated : t))); }

    return (
      <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <Header onToggleDark={()=>setDark(v=>!v)} dark={dark} onSignOut={() => { localStorage.removeItem('token'); setToken(null); }} />

        <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
          <nav className="flex gap-2">
            <button onClick={()=>setTab('dashboard')} className={`btn ${tab==='dashboard' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'border dark:border-slate-700'}`}>Dashboard</button>
            <button onClick={()=>setTab('submit')} className={`btn ${tab==='submit' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'border dark:border-slate-700'}`}>Form Tiket</button>
            <button onClick={()=>setTab('table')} className={`btn ${tab==='table' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'border dark:border-slate-700'}`}>Daftar</button>
          </nav>

          {tab === "dashboard" && <Dashboard tickets={tickets} />}
          {tab === "submit" && <section className="card"><TicketForm onSubmit={addTicket} /></section>}
          {tab === "table" && <section className="card"><TicketTable tickets={tickets} onUpdate={updateTicket} onOpen={(t) => setOpen(t)} /></section>}
        </main>

        <footer className="max-w-7xl mx-auto px-4 py-8 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-3"><span>© {new Date().getFullYear()} IT Helpdesk Enterprise</span><span>•</span><span>Realtime + Telegram Command Center + Dashboard</span></div>
        </footer>

        {!token && <LoginOverlay onDone={()=>{ const t = localStorage.getItem('token'); if (t) setToken(t); }} />}
        {open && <TicketDetailModal ticket={open} onClose={() => setOpen(null)} onPatched={(t)=>{ setTickets(prev => prev.map(x => x.id === t.id ? t : x)); setOpen(t); }} />}
      </div>
    );
  }
