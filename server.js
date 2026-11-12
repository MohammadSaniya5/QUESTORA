// QUESTORA API — Express on Vercel Functions + Supabase PostgreSQL.
require("dotenv").config();
const path = require("path");
// The public HTML files are intentionally unchanged to preserve the exact UI.
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Pool } = require("pg");

const SECRET = process.env.SESSION_SECRET;
const PROD = process.env.NODE_ENV === "production";
if (!SECRET || SECRET.length < 32) {
  console.warn("WARNING: Set SESSION_SECRET to a random value of at least 32 characters.");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});
const query = (text, params = []) => pool.query(text, params);
const one = async (text, params = []) => (await query(text, params)).rows[0] || null;
const many = async (text, params = []) => (await query(text, params)).rows;

const DEF = { dur: 600, quant: 5, math: 3, phys: 1, chem: 1, coin: 10, every: 5, bonus: 25, accPct: 70, trophyPct: 90 };
const cfg = async () => {
  const c = { ...DEF };
  for (const r of await many("SELECT key, value FROM app_config")) c[r.key] = Number(r.value);
  return c;
};
const hm = p => crypto.createHmac("sha256", SECRET || "development-only-change-this-secret").update(p).digest("base64url");
const sign = o => { const p = Buffer.from(JSON.stringify(o)).toString("base64url"); return p + "." + hm(p); };
const unsign = t => {
  try {
    const [p, s] = String(t || "").split(".");
    const expected = Buffer.from(hm(p)), actual = Buffer.from(s);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const o = JSON.parse(Buffer.from(p, "base64url"));
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
};
const cookie = (req, name) => {
  const found = (req.headers.cookie || "").split(/;\s*/).map(x => x.split("=")).find(x => x[0] === name);
  return found?.[1] || "";
};
const CN = { student: "qs", admin: "qa" };
const setC = (res, role, user) => res.append("Set-Cookie",
  `${CN[role]}=${sign({ ...user, role, exp: Date.now() + 86400000 })}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${PROD ? "; Secure" : ""}`);
const clearC = (res, role) => res.append("Set-Cookie", `${CN[role]}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? "; Secure" : ""}`);
const need = role => (req, res, next) => {
  const u = unsign(cookie(req, CN[role]));
  if (!u || u.role !== role) return res.status(401).json({ error: "Not authorised" });
  req.u = u; next();
};
const hits = new Map();
const limit = (n, ms = 60000) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= n) return res.status(429).json({ error: "Too many attempts. Please wait a minute." });
  a.push(now); hits.set(k, a); next();
};
const bad = (res, message) => res.status(400).json({ error: message });
const mask = h => h.slice(0, 3) + "••" + h.slice(-2);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
  next();
});
app.get("/api/health", async (req, res) => {
  try { await query("SELECT 1"); res.json({ ok: true, database: "connected" }); }
  catch { res.status(503).json({ ok: false, database: "unavailable" }); }
});

// Exam helpers. A row lock protects submission/answer/reward operations from races.
const attempt = uid => one("SELECT * FROM exam_attempts WHERE user_id=$1", [uid]);
const tally = async id => {
  const c = await cfg();
  const rows = await many(`SELECT aa.is_correct, q.marks FROM attempt_answers aa
    JOIN questions q ON q.id=aa.question_id WHERE aa.attempt_id=$1 AND aa.chosen IS NOT NULL
    ORDER BY aa.answered_at, aa.id`, [id]);
  let coins = 0, streak = 0, best = 0, score = 0;
  for (const r of rows) {
    if (r.is_correct) {
      score += Number(r.marks); coins += c.coin; streak++; best = Math.max(best, streak);
      if (c.every > 0 && streak % c.every === 0) coins += c.bonus;
    } else streak = 0;
  }
  return { coins, streak, best, score };
};
const finalize = async (id, status) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM exam_attempts WHERE id=$1 FOR UPDATE", [id]);
    const a = locked.rows[0];
    if (a && a.status === "IN_PROGRESS") {
      const t = await tally(id);
      await client.query(`UPDATE exam_attempts SET status=$1, submitted=LEAST($2, ends_at),
        score=$3, coins=$4, best_streak=$5 WHERE id=$6 AND status='IN_PROGRESS'`,
        [status, Date.now(), t.score, t.coins, t.best, id]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
};
const expire = async a => {
  if (a && a.status === "IN_PROGRESS" && Date.now() > Number(a.ends_at)) {
    await finalize(a.id, "TIME_EXPIRED");
    return await one("SELECT * FROM exam_attempts WHERE id=$1", [a.id]);
  }
  return a;
};
const state = async uid => {
  let a = await attempt(uid);
  if (!a) return { status: "NONE" };
  a = await expire(a);
  if (a.status !== "IN_PROGRESS") return { status: a.status };
  const rows = await many(`SELECT q.id,q.question_text,q.category,q.subject,q.option_a,q.option_b,q.option_c,q.option_d,
      q.correct_option, aa.chosen
    FROM attempt_questions aq JOIN questions q ON q.id=aq.question_id
    LEFT JOIN attempt_answers aa ON aa.attempt_id=aq.attempt_id AND aa.question_id=aq.question_id
    WHERE aq.attempt_id=$1 ORDER BY aq.position`, [a.id]);
  const t = await tally(a.id), answers = {}, reveal = {};
  rows.forEach(r => {
    if (r.chosen !== null && r.chosen !== undefined) { answers[r.id] = Number(r.chosen); reveal[r.id] = Number(r.correct_option); }
  });
  return {
    status: "IN_PROGRESS", msLeft: Number(a.ends_at) - Date.now(), cur: Number(a.current_index || 0),
    coins: t.coins, streak: t.streak, answers, reveal,
    questions: rows.map(r => ({
      id: Number(r.id), text: r.question_text, opts: [r.option_a, r.option_b, r.option_c, r.option_d],
      label: r.category === "QUANT" ? "Quantitative Aptitude" : "EAMCET · " + r.subject[0] + r.subject.slice(1).toLowerCase()
    }))
  };
};
const board = () => many(`SELECT u.first_name||' '||u.last_name AS name,u.hall_ticket,
  u.id AS uid,a.score,a.coins,a.best_streak AS best,
  (SELECT COUNT(*) FROM attempt_questions aq LEFT JOIN attempt_answers x ON x.attempt_id=aq.attempt_id AND x.question_id=aq.question_id WHERE aq.attempt_id=a.id AND x.id IS NULL) AS unanswered,
  a.submitted-a.started_at AS duration
  FROM exam_attempts a JOIN profiles u ON u.id=a.user_id
  WHERE a.status <> 'IN_PROGRESS'
  ORDER BY a.score DESC, unanswered ASC, duration ASC LIMIT 100`);

// Student authentication
app.post("/api/register", limit(10), async (req, res, next) => {
  try {
    const b = req.body || {}, s = k => String(b[k] || "").trim();
    const [first, last, ht, email, phone, address] = ["first", "last", "ht", "email", "phone", "address"].map(s);
    if (!first || !last || !address) return bad(res, "First name, last name and address are required.");
    if (!/^[A-Za-z0-9]{6,15}$/.test(ht)) return bad(res, "Hall Ticket must be 6-15 letters/digits.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, "Enter a valid email.");
    if (!/^[6-9]\d{9}$/.test(phone)) return bad(res, "Enter a valid 10-digit phone number.");
    if (String(b.password || "").length < 8) return bad(res, "Password must be at least 8 characters.");
    if (b.password !== b.confirm) return bad(res, "Passwords do not match.");
    const hash = await bcrypt.hash(b.password, 10);
    try {
      await query(`INSERT INTO profiles(role,email,hall_ticket,first_name,last_name,phone,address,password_hash,created_at)
        VALUES('student',$1,$2,$3,$4,$5,$6,$7,$8)`,
        [email.toLowerCase(), ht.toUpperCase(), first, last, phone, address, hash, Date.now()]);
      res.json({ ok: true });
    } catch (e) {
      if (e.code === "23505") return bad(res, e.constraint?.includes("hall_ticket") ? "Hall Ticket already registered." : "Email already registered.");
      throw e;
    }
  } catch (e) { next(e); }
});
app.post("/api/login", limit(10), async (req, res, next) => {
  try {
    const u = await one("SELECT * FROM profiles WHERE role='student' AND hall_ticket=$1", [String(req.body.ht || "").trim().toUpperCase()]);
    if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))) return res.status(401).json({ error: "Invalid Hall Ticket or password." });
    setC(res, "student", { id: u.id }); res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/logout", (req, res) => { clearC(res, "student"); res.json({ ok: true }); });
app.get("/api/me", need("student"), async (req, res, next) => {
  try {
    const u = await one("SELECT * FROM profiles WHERE id=$1", [req.u.id]);
    if (!u) return res.status(401).json({ error: "Not authorised" });
    const s = await state(u.id), a = await attempt(u.id), t = a && a.status === "IN_PROGRESS" ? await tally(a.id) : null;
    res.json({ first: u.first_name, last: u.last_name, ht: u.hall_ticket, status: s.status, coins: a ? (t ? t.coins : Number(a.coins || 0)) : 0 });
  } catch (e) { next(e); }
});

// Student exam
app.post("/api/exam/start", need("student"), async (req, res, next) => {
  try {
    const uid = req.u.id;
    if (!await attempt(uid)) {
      const c = await cfg();
      const pick = async (where, n) => (await many(`SELECT id FROM questions WHERE is_active=TRUE AND is_archived=FALSE AND ${where} ORDER BY random() LIMIT $1`, [n])).map(r => r.id);
      const Q = await pick("category='QUANT'", c.quant);
      const E = [
        ...await pick("category='EAMCET' AND subject='MATHEMATICS'", c.math),
        ...await pick("category='EAMCET' AND subject='PHYSICS'", c.phys),
        ...await pick("category='EAMCET' AND subject='CHEMISTRY'", c.chem)
      ].sort(() => Math.random() - .5);
      if (Q.length < c.quant || E.length < c.math + c.phys + c.chem) return bad(res, "Not enough active questions. Please contact your administrator.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const now = Date.now(), questionCount = c.quant + c.math + c.phys + c.chem, durationMs = questionCount * 60 * 1000;
        const ins = await client.query(`INSERT INTO exam_attempts(user_id,started_at,ends_at,last_activity)
          VALUES($1,$2,$3,$2) ON CONFLICT(user_id) DO NOTHING RETURNING id`, [uid, now, now + durationMs]);
        if (ins.rows[0]) {
          for (const [i, qid] of [...Q, ...E].entries()) {
            await client.query("INSERT INTO attempt_questions(attempt_id,question_id,position) VALUES($1,$2,$3)", [ins.rows[0].id, qid, i]);
          }
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      finally { client.release(); }
    }
    res.json(await state(uid));
  } catch (e) { next(e); }
});
app.get("/api/exam/state", need("student"), async (req, res, next) => {
  try { res.json(await state(req.u.id)); } catch (e) { next(e); }
});
app.post("/api/exam/answer", need("student"), limit(120), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ar = await client.query("SELECT * FROM exam_attempts WHERE user_id=$1 FOR UPDATE", [req.u.id]);
    const a0 = ar.rows[0];
    if (!a0) { await client.query("ROLLBACK"); return bad(res, "Exam not started."); }
    if (a0.status !== "IN_PROGRESS" || Date.now() > Number(a0.ends_at)) {
      await client.query("ROLLBACK");
      if (a0.status === "IN_PROGRESS") await finalize(a0.id, "TIME_EXPIRED");
      return res.status(409).json({ error: "Exam closed: time expired." });
    }
    const qid = Number(req.body.qid), chosen = Number(req.body.chosen);
    if (!Number.isInteger(chosen) || chosen < 0 || chosen > 3) { await client.query("ROLLBACK"); return bad(res, "Invalid option."); }
    const qr = await client.query(`SELECT q.correct_option FROM attempt_questions aq JOIN questions q ON q.id=aq.question_id
      WHERE aq.attempt_id=$1 AND aq.question_id=$2`, [a0.id, qid]);
    if (!qr.rows[0]) { await client.query("ROLLBACK"); return bad(res, "Question not in your exam."); }
    const before = await tally(a0.id);
    const inserted = await client.query(`INSERT INTO attempt_answers(attempt_id,question_id,chosen,is_correct,answered_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(attempt_id,question_id) DO NOTHING RETURNING id`,
      [a0.id, qid, chosen, chosen === Number(qr.rows[0].correct_option), Date.now()]);
    if (!inserted.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Already answered. Answers are locked." }); }
    await client.query("UPDATE exam_attempts SET last_activity=$1,current_index=$2 WHERE id=$3",
      [Date.now(), Math.max(0, Math.min(99, Number(req.body.idx) || 0)), a0.id]);
    await client.query("COMMIT");
    const t = await tally(a0.id), c = await cfg();
    res.json({ correct: chosen === Number(qr.rows[0].correct_option), correctIdx: Number(qr.rows[0].correct_option), coins: t.coins, streak: t.streak, bonus: t.coins - before.coins > c.coin });
  } catch (e) { try { await client.query("ROLLBACK"); } catch {} next(e); }
  finally { client.release(); }
});
app.post("/api/exam/submit", need("student"), async (req, res, next) => {
  try {
    const a = await attempt(req.u.id);
    if (!a) return bad(res, "Exam not started.");
    await finalize(a.id, Date.now() > Number(a.ends_at) ? "TIME_EXPIRED" : "SUBMITTED");
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get("/api/exam/result", need("student"), async (req, res, next) => {
  try {
    let a = await attempt(req.u.id);
    if (!a) return bad(res, "No exam yet.");
    a = await expire(a);
    if (a.status === "IN_PROGRESS") return bad(res, "Exam still in progress.");
    const rows = await many(`SELECT q.subject,q.category,aa.is_correct,aa.chosen FROM attempt_questions aq
      JOIN questions q ON q.id=aq.question_id LEFT JOIN attempt_answers aa
      ON aa.attempt_id=aq.attempt_id AND aa.question_id=aq.question_id WHERE aq.attempt_id=$1`, [a.id]);
    const sec = {};
    rows.forEach(r => {
      const names = [r.category === "QUANT" ? "Quantitative Aptitude" : "EAMCET", r.category === "EAMCET" ? r.subject[0] + r.subject.slice(1).toLowerCase() : null].filter(Boolean);
      names.forEach(n => { sec[n] ||= { name: n, c: 0, n: 0 }; sec[n].n++; if (r.is_correct) sec[n].c++; });
    });
    const total = rows.length, correct = rows.filter(r => r.is_correct).length;
    const unanswered = rows.filter(r => r.chosen === null).length, pct = total ? Math.round(correct / total * 100) : 0;
    const c = await cfg(), b = await board(), badges = ["🎖 Participation"];
    if (pct >= c.accPct) badges.push("🎯 Accuracy");
    if (Number(a.best_streak) >= c.every) badges.push("🔥 Streak master");
    if (pct >= c.trophyPct) badges.push("👑 Golden trophy");
    res.json({
      status: a.status, total, correct, incorrect: total - correct - unanswered, unanswered,
      coins: Number(a.coins || 0), best: Number(a.best_streak || 0),
      dur: Math.round((Number(a.submitted) - Number(a.started_at)) / 1000), pct,
      sections: Object.values(sec), rank: b.findIndex(x => Number(x.uid) === Number(req.u.id)) + 1,
      board: b.slice(0, 10).map(x => ({ name: x.name, ht: mask(x.hall_ticket), score: Number(x.score), me: Number(x.uid) === Number(req.u.id) }))
    });
  } catch (e) { next(e); }
});

// Admin
const A = need("admin");
app.post("/api/admin/login", limit(8), async (req, res, next) => {
  try {
    const u = await one("SELECT * FROM profiles WHERE role='admin' AND email=$1", [String(req.body.email || "").trim().toLowerCase()]);
    if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))) return res.status(401).json({ error: "Invalid admin credentials." });
    setC(res, "admin", { id: u.id }); res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/logout", (req, res) => { clearC(res, "admin"); res.json({ ok: true }); });
app.get("/api/admin/me", A, (req, res) => res.json({ ok: true }));
app.get("/api/admin/stats", A, async (req, res, next) => {
  try {
    const counts = await one(`SELECT
      (SELECT COUNT(*) FROM profiles WHERE role='student') students,
      (SELECT COUNT(*) FROM exam_attempts) participants,
      (SELECT COUNT(*) FROM exam_attempts WHERE status='IN_PROGRESS' AND ends_at>$1) active,
      (SELECT COUNT(*) FROM exam_attempts WHERE status<>'IN_PROGRESS') completed,
      (SELECT COUNT(*) FROM questions WHERE is_archived=FALSE) questions`, [Date.now()]);
    const scores = (await many("SELECT score FROM exam_attempts WHERE status<>'IN_PROGRESS'")).map(x => Number(x.score));
    res.json({ students: Number(counts.students), participants: Number(counts.participants), active: Number(counts.active), completed: Number(counts.completed), avg: scores.length ? +(scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1) : 0, max: Math.max(0,...scores), questions: Number(counts.questions), scores });
  } catch (e) { next(e); }
});
app.get("/api/admin/students", A, async (req, res, next) => {
  try { res.json(await many(`SELECT u.id,u.first_name||' '||u.last_name AS name,u.hall_ticket AS ht,u.email,u.phone,
    COALESCE(a.status,'NONE') AS status FROM profiles u LEFT JOIN exam_attempts a ON a.user_id=u.id
    WHERE u.role='student' ORDER BY u.id DESC`)); } catch (e) { next(e); }
});
app.get("/api/admin/monitor", A, async (req, res, next) => {
  try {
    const expired = await many("SELECT id FROM exam_attempts WHERE status='IN_PROGRESS' AND ends_at<=$1", [Date.now()]);
    for (const r of expired) await finalize(r.id, "TIME_EXPIRED");
    res.json(await many(`SELECT u.first_name||' '||u.last_name AS name,u.hall_ticket AS ht,
      COALESCE(a.status,'NONE') AS status,a.started_at AS started,a.current_index AS cur,a.last_activity AS last,a.ends_at AS ends,
      (SELECT COUNT(*) FROM attempt_answers x WHERE x.attempt_id=a.id AND x.chosen IS NOT NULL) AS answered,
      (SELECT COUNT(*) FROM attempt_questions x WHERE x.attempt_id=a.id) AS total
      FROM profiles u LEFT JOIN exam_attempts a ON a.user_id=u.id WHERE u.role='student' ORDER BY a.last_activity DESC NULLS LAST`));
  } catch (e) { next(e); }
});
app.get("/api/admin/leaderboard", A, async (req, res, next) => { try { res.json(await board()); } catch (e) { next(e); } });

const QF = b => {
  const t = k => String(b[k] ?? "").trim(), c = Number(b.correct);
  if (!t("text") || !["a","b","c","d"].every(k => t(k))) return null;
  if (!["QUANT","EAMCET"].includes(b.cat) || !["ARITHMETIC","MATHEMATICS","PHYSICS","CHEMISTRY"].includes(b.subject) || !(c >= 0 && c <= 3)) return null;
  return [t("text"),b.cat,b.subject,["EASY","MEDIUM","HARD"].includes(b.diff)?b.diff:"MEDIUM",t("a"),t("b"),t("c"),t("d"),c,t("explanation"),Math.max(1,Number(b.marks)||1),b.active===false?false:true];
};
const insertQuestion = async v => query(`INSERT INTO questions(question_text,category,subject,difficulty,option_a,option_b,option_c,option_d,correct_option,explanation,marks,is_active)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, v);
app.get("/api/admin/questions", A, async (req, res, next) => {
  try {
    const { s="",cat="",subject="",diff="" } = req.query;
    res.json(await many(`SELECT id,question_text AS text,category AS cat,subject,difficulty AS diff,
      option_a AS a,option_b AS b,option_c AS c,option_d AS d,correct_option AS correct,explanation,marks,is_active AS active
      FROM questions WHERE is_archived=FALSE AND question_text ILIKE $1 AND($2='' OR category=$2)
      AND($3='' OR subject=$3)AND($4='' OR difficulty=$4) ORDER BY id DESC`,
      ["%"+s+"%",cat,subject,diff]));
  } catch (e) { next(e); }
});
app.post("/api/admin/questions", A, async (req, res, next) => { try { const v=QF(req.body); if(!v)return bad(res,"Fill every field correctly."); await insertQuestion(v); res.json({ok:true}); } catch(e){next(e);} });
app.put("/api/admin/questions/:id", A, async (req, res, next) => {
  try {
    const v=QF(req.body); if(!v)return bad(res,"Fill every field correctly.");
    await query(`UPDATE questions SET question_text=$1,category=$2,subject=$3,difficulty=$4,option_a=$5,option_b=$6,option_c=$7,option_d=$8,correct_option=$9,explanation=$10,marks=$11,is_active=$12 WHERE id=$13`, [...v,req.params.id]);
    res.json({ok:true});
  } catch(e){next(e);}
});
app.delete("/api/admin/questions/:id", A, async (req,res,next)=>{
  try {
    const used=await one("SELECT 1 FROM attempt_questions WHERE question_id=$1 LIMIT 1",[req.params.id]);
    if(used) await query("UPDATE questions SET is_archived=TRUE,is_active=FALSE WHERE id=$1",[req.params.id]);
    else await query("DELETE FROM questions WHERE id=$1",[req.params.id]);
    res.json({ok:true,archived:!!used});
  } catch(e){next(e);}
});
app.post("/api/admin/import", A, async (req,res,next)=>{
  try {
    let ok=0,skipped=0;
    for(const line of String(req.body.text||"").split("\n")){
      if(!line.trim())continue;
      const [text,cat,subject,a,b,c,d,correct]=line.split("|").map(x=>x.trim());
      const v=QF({text,cat,subject,a,b,c,d,correct});
      if(v){await insertQuestion(v);ok++;}else skipped++;
    }
    res.json({ok,skipped});
  } catch(e){next(e);}
});
app.get("/api/admin/config", A, async (req,res,next)=>{try{res.json(await cfg());}catch(e){next(e);}});
app.put("/api/admin/config", A, async (req,res,next)=>{
  try {
    const values={};
    for(const k of Object.keys(DEF)){const v=Math.round(Number(req.body[k]));if(!Number.isFinite(v)||v<0)return bad(res,"Invalid value for "+k);values[k]=v;}
    const client=await pool.connect();
    try {await client.query("BEGIN");for(const [k,v] of Object.entries(values))await client.query(`INSERT INTO app_config(key,value)VALUES($1,$2)ON CONFLICT(key)DO UPDATE SET value=EXCLUDED.value`,[k,v]);await client.query("COMMIT");}
    catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    res.json({ok:true});
  } catch(e){next(e);}
});

// Vercel serves public files; this export is also used by the local development server.
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Server error. Please try again." }); });
module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`QUESTORA running at http://localhost:${port}`));
}
