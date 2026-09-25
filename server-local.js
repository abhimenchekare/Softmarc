require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Only the site itself (and, in development, localhost) may call the API.
// '*' used to be sent here, which let any website's JavaScript hit these routes.
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGINS || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const originAllowed = (o, req) => {
  if (!o) return true;                                  // no Origin header: same-origin / curl
  const norm = o.replace(/\/+$/, '');
  if (norm === `${req.protocol}://${req.get('host')}`) return true;   // the site itself
  if (ALLOW_ORIGIN.includes(norm)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(norm); // local testing
};
app.use((req, res, next) => {
  const o = req.get('Origin');
  if (o && originAllowed(o, req)) { res.header('Access-Control-Allow-Origin', o); res.header('Vary', 'Origin'); }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-auth');
  res.header('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- response hardening (same rules as the production server) ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');                 // no click-jacking / iframe embedding
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (process.env.HTTPS !== '0' && (req.secure || req.get('X-Forwarded-Proto') === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Keep local behaviour aligned with production: lesson documents are public to the in-site
// viewer, but the /pdfs path is never a general file browser.
const LOCAL_ONE_DAY = 24 * 60 * 60 * 1000;
const LOCAL_PUBLIC_DOCUMENT_EXT = new Set(['.pdf', '.pptx']);
function localLessonDocumentOnly(req, res, next) {
  let ext = '';
  try { ext = path.extname(decodeURIComponent(req.path || '')).toLowerCase(); } catch (e) {}
  if (!LOCAL_PUBLIC_DOCUMENT_EXT.has(ext)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=' + (LOCAL_ONE_DAY / 1000));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
app.use('/pdfs', localLessonDocumentOnly, express.static(path.join(__dirname, 'pdfs'), { maxAge: LOCAL_ONE_DAY }));
app.use(express.static(__dirname));

// =============================================================
// SQLITE DATABASE (for local testing only)
// =============================================================

const dbPath = './softmarc.db';
let db = null, DB_ENGINE = '';
let DEMO_ADMIN_PW = '';

// node:sqlite logs an ExperimentalWarning on Node 22/23/24. This is the local test copy only,
// so keep that noise out of the console — every other warning still shows as usual.
try {
  const forward = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w && w.name === 'ExperimentalWarning' && /SQLite/i.test(String(w.message))) return;
    forward.forEach((f) => { try { f(w); } catch (e) { console.warn(String((w && w.message) || w)); } });
  });
} catch (e) { /* never let a console filter break the app */ }

// A better-sqlite3-shaped wrapper over the SQLite built into Node 22.5+ (node:sqlite).
// Used when the npm module can't load: newer Node ABI, blocked install script, no compiler.
function openNodeSqlite() {
  let mod;
  try { mod = require('node:sqlite'); } catch (e) { return null; }
  if (!mod || typeof mod.DatabaseSync !== 'function') return null;
  const raw = new mod.DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL');
  // node:sqlite is stricter than better-sqlite3 about bind values: no undefined, no booleans.
  // Normalising here keeps every existing call site (60+ of them) working unchanged.
  const nz = (v) => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const norm = (a) => ((a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(nz));
  return {
    prepare: (sql) => {
      const st = raw.prepare(sql);
      return { all: (...a) => st.all(...norm(a)), get: (...a) => st.get(...norm(a)), run: (...a) => st.run(...norm(a)) };
    },
    exec: (sql) => raw.exec(sql),
    pragma: (spec) => raw.exec('PRAGMA ' + spec),
    close: () => raw.close()
  };
}

try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  DB_ENGINE = 'better-sqlite3';
  console.log('[DB] SQLite connected (' + DB_ENGINE + '):', dbPath);
} catch (err) {
  const why = String((err && err.message) || err).split('\n')[0];
  try { db = openNodeSqlite(); } catch (e2) { db = null; }
  if (db) {
    DB_ENGINE = 'node:sqlite';
    console.log('[DB] better-sqlite3 not usable (' + why.slice(0, 96) + ')');
    console.log('[DB] Using the SQLite built into Node ' + process.versions.node + ' — the demo works exactly the same.');
  } else {
    console.error('\n[DB] The local demo cannot open a database, so it stopped instead of running half-broken.');
    console.error('     better-sqlite3 said: ' + why);
    console.error('     Node\'s own SQLite needs Node 22.5 or newer (you are on ' + process.versions.node + ').');
    console.error('   Fix it with ONE of these, then run: npm run local');
    console.error('     1) use Node 22.5+ / 24 LTS  (no install step at all — the demo will use node:sqlite)');
    console.error('     2) npm install-scripts approve better-sqlite3   then   npm install');
    console.error('     3) npm uninstall better-sqlite3   (forces the built-in SQLite path)\n');
    process.exit(1);
  }
}

// Create tables
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      phone TEXT,
      department TEXT,
      institution TEXT,
      city TEXT,
      country_code TEXT,
      country TEXT,
      state_region TEXT,
      learning_goal TEXT,
      avatar_image TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE,
      tag TEXT DEFAULT 'Course',
      short_description TEXT,
      description TEXT,
      duration_hours INTEGER DEFAULT 10,
      level TEXT DEFAULT 'Beginner',
      image TEXT,
      status TEXT DEFAULT 'active',
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS subtopics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER,
      parent_subtopic_id INTEGER DEFAULT NULL,
      title TEXT NOT NULL,
      slug TEXT,
      dur TEXT DEFAULT '15 min',
      description TEXT,
      video_url TEXT,
      pdf_url TEXT,
      exercise TEXT,
      display_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (course_id) REFERENCES courses(id)
    );
    
    CREATE TABLE IF NOT EXISTS subtopic_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtopic_id INTEGER NOT NULL,
      resource_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      file_url TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subtopic_id) REFERENCES subtopics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_subtopic_resources ON subtopic_resources(subtopic_id,display_order,id);

    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_name TEXT,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER,
      question_text TEXT NOT NULL,
      option_a TEXT,
      option_b TEXT,
      option_c TEXT,
      option_d TEXT,
      correct_option TEXT,
      FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
    );
    
    CREATE TABLE IF NOT EXISTS student_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      student_name TEXT,
      quiz_id INTEGER,
      quiz_title TEXT,
      answers TEXT,
      score INTEGER,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
    );
    
    CREATE TABLE IF NOT EXISTS lesson_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER,
      course_name TEXT,
      module_index INTEGER,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, course_name, module_index)
    );
    CREATE TABLE IF NOT EXISTS student_access (
      student_id INTEGER PRIMARY KEY, access_mode TEXT NOT NULL DEFAULT 'full', demo_course_id INTEGER,
      demo_topic_limit INTEGER NOT NULL DEFAULT 2, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, course_id INTEGER NOT NULL, trainer_id INTEGER NOT NULL,
      invite_code TEXT NOT NULL UNIQUE, start_date TEXT, end_date TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS batch_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
      enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL DEFAULT 'active', UNIQUE(batch_id, student_id)
    );
  `);
  
  // Existing local databases also receive the richer signup fields without recreation.
  const localProfileColumns=new Set(db.prepare('PRAGMA table_info(users)').all().map(c=>c.name));
  [['country_code','TEXT'],['country','TEXT'],['state_region','TEXT'],['learning_goal','TEXT']].forEach(([name,type])=>{ if(!localProfileColumns.has(name)) db.exec('ALTER TABLE users ADD COLUMN '+name+' '+type); });
  const localSubtopicColumns=new Set(db.prepare('PRAGMA table_info(subtopics)').all().map(c=>c.name));
  if(!localSubtopicColumns.has('parent_subtopic_id')) db.exec('ALTER TABLE subtopics ADD COLUMN parent_subtopic_id INTEGER DEFAULT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_subtopics_parent ON subtopics(course_id,parent_subtopic_id,display_order,id)');

  // Create admin user if not exists
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get('admin@softmarc.com');
  if (!existing) {
    // Local demo only. Set your own: ADMIN_PASSWORD=... npm run local  (nothing is published anywhere)
    const crypto = require('crypto');
    const demoPw = process.env.ADMIN_PASSWORD || (crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'demo' + Date.now());
    const hash = bcrypt.hashSync(demoPw, 10);
    db.prepare("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)").run('Admin', 'admin@softmarc.com', hash, 'admin');
    DEMO_ADMIN_PW = demoPw;
    console.log('[DB] Local demo admin row created (lives in softmarc.db on this PC only).');
  }
}

// =============================================================
// CORS Headers
// =============================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// ---------- signed session tokens (no extra npm package, no DB table) ----------
const crypto = require('crypto');
const AUTH_KEY_FILE = path.join(DATA_DIR, '.authkey');
function loadAuthSecret() {
  if (process.env.AUTH_SECRET) return { secret: process.env.AUTH_SECRET, ephemeral: false };
  try {
    if (!fs.existsSync(AUTH_KEY_FILE)) {
      fs.mkdirSync(path.dirname(AUTH_KEY_FILE), { recursive: true });
      fs.writeFileSync(AUTH_KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    return { secret: fs.readFileSync(AUTH_KEY_FILE, 'utf8').trim(), ephemeral: false };
  } catch (e) {
    // read-only DATA_DIR fallback: tokens simply die with the process
    return { secret: 'ephemeral-' + crypto.randomBytes(24).toString('hex'), ephemeral: true };
  }
}
const AUTH = loadAuthSecret();
const TOKEN_TTL_MS = (Number(process.env.TOKEN_TTL_HOURS) || 12) * 3600e3;
if (AUTH.ephemeral) console.warn('[Auth] Cannot persist signing key — sessions end when the app restarts');

// Local parity for the production demo/batch access model.
function localAccessFor(studentId){ return db.prepare('SELECT access_mode,demo_course_id,demo_topic_limit FROM student_access WHERE student_id=?').get(studentId)||{access_mode:'full',demo_course_id:null,demo_topic_limit:2}; }
function localPermittedCourseIds(auth){
  if(!auth||auth.role!=='student') return null; const access=localAccessFor(auth.uid);
  if(access.access_mode==='demo') return {access,ids:access.demo_course_id?[Number(access.demo_course_id)]:[]};
  if(access.access_mode==='batch') return {access,ids:db.prepare("SELECT DISTINCT b.course_id FROM batch_enrollments e JOIN batches b ON b.id=e.batch_id WHERE e.student_id=? AND e.status='active' AND b.status='active'").all(auth.uid).map(x=>Number(x.course_id))};
  return {access,ids:null};
}
function localDemoVisibleSubtopics(topics,limit){const rows=topics||[],roots=rows.filter(t=>t.parent_subtopic_id===null||t.parent_subtopic_id===undefined||t.parent_subtopic_id===''),chosen=new Set(roots.slice(0,Math.max(0,Number(limit)||2)).map(t=>Number(t.id)));return rows.filter(t=>{const parent=t.parent_subtopic_id;if(parent!==null&&parent!==undefined&&parent!=='')return chosen.has(Number(parent));return chosen.has(Number(t.id));});}
function localPlayableSubtopics(topics){const containers=new Set((topics||[]).filter(t=>t.parent_subtopic_id!==null&&t.parent_subtopic_id!==undefined&&t.parent_subtopic_id!=='').map(t=>Number(t.parent_subtopic_id)));return (topics||[]).filter(t=>!containers.has(Number(t.id)));}

function localMayStudy(auth,courseName,moduleIndex){
  if(!auth||auth.role!=='student')return true; const p=localPermittedCourseIds(auth); if(p.ids===null)return true;
  const course=db.prepare('SELECT id FROM courses WHERE title=? LIMIT 1').get(courseName); if(!course||!p.ids.includes(Number(course.id)))return false;
  if(p.access.access_mode!=='demo')return true;const topics=db.prepare('SELECT id,parent_subtopic_id,display_order FROM subtopics WHERE course_id=? ORDER BY display_order,id').all(course.id);return Number(moduleIndex)>=0&&Number(moduleIndex)<localPlayableSubtopics(localDemoVisibleSubtopics(topics,p.access.demo_topic_limit)).length;
}
function localPublicUser(user,access){return {id:user.id,full_name:user.full_name,email:user.email,role:user.role,phone:user.phone,country_code:user.country_code,country:user.country,state_region:user.state_region,city:user.city,department:user.department,institution:user.institution,learning_goal:user.learning_goal,avatar_image:user.avatar_image,access_mode:(access&&access.access_mode)||'full',demo_course_id:(access&&access.demo_course_id)||null};}
function localInviteCode(){return 'SM-'+crypto.randomBytes(4).toString('hex').toUpperCase();}
function localOwnBatch(auth,id){const b=db.prepare('SELECT * FROM batches WHERE id=?').get(id);if(!b)return null;if(auth.role!=='admin'&&Number(b.trainer_id)!==Number(auth.uid))return false;return b;}

function signToken(user) {
  const body = Buffer.from(JSON.stringify({
    uid: user.id, role: (user.role === 'admin' || user.role === 'trainer') ? user.role : 'student', exp: Date.now() + TOKEN_TTL_MS
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH.secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(t) {
  if (typeof t !== 'string' || t.length > 2000) return null;
  const i = t.lastIndexOf('.');
  if (i < 8) return null;
  const body = t.slice(0, i), sig = t.slice(i + 1);
  const want = crypto.createHmac('sha256', AUTH.secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || !p.uid || !p.exp || p.exp < Date.now()) return null;
  return p;
}
function authFrom(req) {
  const t = req.get('x-auth') || req.query.token || '';
  return t ? verifyToken(t) : null;
}
function needSignIn(req, res) {
  res.status(401).json({ error: 'Please sign in again.', code: 'auth_required' });
}
// who may touch what
const PUB = [[/^POST$/, /^\/(login|signup)$/], [/^GET$/, /^\/(health|config)$/]]; // course and quiz data require a signed account
const ADMIN = [[/^GET$/, /^\/(users|submissions|analytics\/summary)$/], [/^POST$/, /^\/(config|upload|users|courses|quizzes)$/],
  [/^GET$/, /^\/quizzes\/\d+\/questions$/],                       // correct answers: admin only
  [/^PUT$/, /^\/quizzes\/\d+\/assessment$/],                       // one-save quiz editor
  [/^(PUT|DELETE)$/, /^\/courses\/\d+$/], [/^(PUT|DELETE)$/, /^\/subtopics\/\d+$/], [/^POST$/, /^\/subtopics\/\d+\/resources$/],
  [/^(PUT|DELETE)$/, /^\/subtopic-resources\/\d+$/], [/^(PUT|DELETE)$/, /^\/quizzes\/\d+$/],
  [/^DELETE$/, /^\/users\/\d+$/]];
const SCOPED = [/^\/(progress|time|steps)/, /^\/users\/\d+/, /^\/quizzes\/\d+\/submit$/];
function claimedId(req) {
  const rp = req.path.replace(/\.php/gi, '');
  const m = rp.match(/^\/users\/(\d+)/);
  if (m) return Number(m[1]);
  const src = Object.assign({}, req.query, (req.body && typeof req.body === 'object') ? req.body : {});
  const n = Number(src.student_id != null ? src.student_id : src.id);
  return isFinite(n) && n > 0 ? n : 0;
}
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');   // content and progress must never be served from a cache

  const p = req.path.replace(/\.php/gi, '');  // the .php alias rewrite runs later — normalise here (also mid-path: /users.php/7/avatar)   // the .php alias rewrite runs later — normalise here
  // public to anonymous callers, but if a valid token rides along we remember who —
  // a couple of read routes show a little more to an admin than to a stranger
  if (PUB.some(r => r[0].test(req.method) && r[1].test(p))) { const pub = authFrom(req); if (pub) req.auth = pub; return next(); }
  const a = authFrom(req);
  if (!a) return needSignIn(req, res);
  req.auth = a;
  if (ADMIN.some(r => r[0].test(req.method) && r[1].test(p)) && a.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required.', code: 'admin_required' });
  if ((/^\/(trainer|batches)(?:\/|$)/.test(p)) && !['trainer','admin'].includes(a.role) && p !== '/batches/join')
    return res.status(403).json({ error: 'Trainer or admin access required.', code: 'trainer_required' });
  if (SCOPED.some(re => re.test(p))) {
    const cid = claimedId(req);
    if (cid && cid !== a.uid && a.role !== 'admin')
      return res.status(403).json({ error: 'That record belongs to another account.', code: 'forbidden' });
  }
  next();
});
app.get('/api/auth/verify', (req, res) => {
  const a = authFrom(req);
  if (!a) return needSignIn(req, res);
  res.json({ ok: true, id: a.uid, role: a.role, expires_at: new Date(a.exp).toISOString() });
});
app.post('/api/auth/logout', (req, res) => res.json({ ok: true, note: 'stateless token — discard it on the device' }));


// =============================================================
// .php ROUTE ALIASES
// =============================================================
app.use((req, res, next) => {
  // strip the .php suffix wherever it appears in the path: the client mixes
  // /api/users/7, /api/users.php/7 and /api/users.php/7/password — all must route the same.
  if (req.path.indexOf('.php') !== -1) req.url = req.url.replace(/\.php/g, '');
  next();
});

// =============================================================
// ROOT
// =============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================================
// HEALTH CHECK
// =============================================================
const healthHandler = async (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const courseCount = db.prepare('SELECT COUNT(*) as count FROM courses').get().count;

    res.json({
      status: 'ok',
      database: 'SQLite',
      time: new Date().toISOString(),
      user_count: userCount,
      course_count: courseCount,
      message: 'All tables exist'
    });
  } catch (e) {
    console.error('[Health Check Failed]', e);
    res.status(500).json({ 
      status: 'error', 
      error: e.message
    });
  }
};

app.get('/api/health', healthHandler);
app.get('/health', healthHandler);

// =============================================================
// USERS
// =============================================================

app.get('/api/users', async (req, res) => {
  try {
    const rows = db.prepare('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const row = db.prepare('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

const TRY_WINDOW = 10 * 60e3, TRY_MAX = 8;
const tries = new Map();
function throttled(key) { const now = Date.now(); const l = (tries.get(key) || []).filter(t => now - t < TRY_WINDOW); tries.set(key, l); return l.length >= TRY_MAX; }
function noteTry(key) { const now = Date.now(); const l = (tries.get(key) || []).filter(t => now - t < TRY_WINDOW); l.push(now); tries.set(key, l); }
const WEAK_PASSWORDS = ['admin123', 'password', 'password1', 'passw0rd', '12345678', '123456789', 'qwerty123', 'softmarc', 'admin1234', 'welcome1'];
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters';
  if (WEAK_PASSWORDS.includes(s.toLowerCase())) return 'That password is on the easily-guessed list — choose another';
  if (/^(.)\1+$/.test(s)) return 'Password must not be one repeated character';
  return '';
}
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const clientIp = req.get('cf-connecting-ip') || (req.ips && req.ips[0]) || req.ip || '';
  const tkey = String(email).toLowerCase() + '|' + clientIp;
  if (throttled(tkey))
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.', code: 'slow_down' });

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }
    tries.delete(tkey);
    const token = signToken(user);
    const access=user.role==='student'?localAccessFor(user.id):{access_mode:'full'};
    res.json(Object.assign({token,token_expires_at:new Date(Date.now()+TOKEN_TTL_MS).toISOString()},localPublicUser(user,access)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/signup', async (req,res)=>{
  const b=req.body||{},full_name=String(b.full_name||'').trim(),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||''),country_code=String(b.country_code||'').trim(),phone=String(b.phone||'').trim(),country=String(b.country||'').trim(),city=String(b.city||'').trim(),state_region=String(b.state_region||'').trim(),department=String(b.department||'').trim(),institution=String(b.institution||'').trim(),learning_goal=String(b.learning_goal||'').trim(),invite_code=String(b.invite_code||'').trim().toUpperCase();
  if(full_name.length<2||full_name.length>120)return res.status(400).json({error:'Enter your full name (2–120 characters).'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:'Enter a valid email address.'});
  if(!/^\+\d{1,4}$/.test(country_code)||!/^[0-9() .-]{6,20}$/.test(phone))return res.status(400).json({error:'Enter a valid mobile number with a country code.'});
  if(!country||country.length>100||!city||city.length>100||state_region.length>100||department.length>150||institution.length>255||learning_goal.length>255)return res.status(400).json({error:'Check your country, city and profile details.'});
  const pe=passwordProblem(password);if(pe)return res.status(400).json({error:pe});
  try{const hash=await bcrypt.hash(password,10);const created=db.prepare("INSERT INTO users (full_name,email,password_hash,role,phone,country_code,country,city,state_region,department,institution,learning_goal) VALUES (?,?,?,'student',?,?,?,?,?,?,?,?)").run(full_name,email,hash,country_code+' '+phone,country_code,country,city,state_region||null,department||null,institution||null,learning_goal||null);const studentId=Number(created.lastInsertRowid);let access={access_mode:'demo',demo_course_id:null,demo_topic_limit:2},joined=null;
    if(invite_code){const batch=db.prepare("SELECT * FROM batches WHERE invite_code=? AND status='active'").get(invite_code);if(!batch){db.prepare('DELETE FROM users WHERE id=?').run(studentId);return res.status(400).json({error:'That batch code is not active. You can leave it blank to start the demo.'});}joined=batch;db.prepare("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active')").run(batch.id,studentId);access={access_mode:'batch',demo_course_id:null,demo_topic_limit:2};}
    else {const c=db.prepare("SELECT id FROM courses WHERE status='active' ORDER BY display_order,id LIMIT 1").get();access.demo_course_id=c?c.id:null;}
    db.prepare("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,?,?,?)").run(studentId,access.access_mode,access.demo_course_id,2);
    const user={id:studentId,full_name,email,role:'student',phone:country_code+' '+phone,country_code,country,city,state_region,department,institution,learning_goal};res.status(201).json(Object.assign({token:signToken(user),token_expires_at:new Date(Date.now()+TOKEN_TTL_MS).toISOString(),joined_batch:joined?{id:joined.id,name:joined.name}:null},localPublicUser(user,access)));
  }catch(err){if(String(err.message).includes('UNIQUE'))return res.status(409).json({error:'An account already exists for this email. Please sign in instead.'});console.error('signup failed',err);res.status(500).json({error:'Could not create your account. Please try again.'});}
});

app.post('/api/users', async (req, res) => {
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  const safeRole=['student','trainer','admin'].includes(role) ? role : 'student';
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(full_name, email, password_hash, safeRole);
    if(safeRole==='student') db.prepare("INSERT INTO student_access (student_id,access_mode) VALUES (?,'full')").run(result.lastInsertRowid);
    const user = db.prepare('SELECT id, full_name, email, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/users/:id/profile', async (req, res) => {
  const { full_name, email, phone, department, institution, city, avatar_image } = req.body;
  try {
    db.prepare(
      'UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), phone = ?, department = ?, institution = ?, city = ?, avatar_image = COALESCE(?, avatar_image) WHERE id = ?'
    ).run(full_name, email, phone, department, institution, city, avatar_image, req.params.id);
    const user = db.prepare('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.put('/api/users/:id/avatar', async (req, res) => {
  try {
    db.prepare('UPDATE users SET avatar_image = ? WHERE id = ?').run(req.body.avatar_image, req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    delete user.password_hash;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

app.delete('/api/users/:id/avatar', async (req, res) => {
  try {
    db.prepare('UPDATE users SET avatar_image = NULL WHERE id = ?').run(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    delete user.password_hash;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

app.put('/api/users/:id/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const npwErr = passwordProblem(new_password);
  if (npwErr) return res.status(400).json({ error: npwErr });
  try {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    
    const match = await bcrypt.compare(current_password, row.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    
    const new_hash = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(new_hash, req.params.id);
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ deleted: true, id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Ordered video/document playlists attached to a single subtopic. Legacy fields stay supported.
function localAddResources(topics){const ids=(topics||[]).map(t=>Number(t.id)).filter(Boolean);const by=new Map();if(ids.length){const rows=db.prepare('SELECT * FROM subtopic_resources WHERE subtopic_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY display_order ASC,id ASC').all(...ids);rows.forEach(r=>{if(!by.has(Number(r.subtopic_id)))by.set(Number(r.subtopic_id),[]);by.get(Number(r.subtopic_id)).push(r);});}(topics||[]).forEach(t=>{t.resources=by.get(Number(t.id))||[];});return topics||[];}

// =============================================================
// COURSES
// =============================================================

app.get('/api/courses', async (req,res)=>{
  try{
    const permitted=localPermittedCourseIds(req.auth);if(permitted&&permitted.ids.length===0)return res.json([]);
    let sql="SELECT * FROM courses WHERE status='active'",args=[];if(permitted&&permitted.ids!==null){sql+=' AND id IN ('+permitted.ids.map(()=>'?').join(',')+')';args=permitted.ids;}sql+=' ORDER BY display_order ASC,id ASC';
    const courses=db.prepare(sql).all(...args);if(courses.length){const ids=courses.map(x=>x.id),topics=db.prepare('SELECT * FROM subtopics WHERE course_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY display_order ASC,id ASC').all(...ids),by=new Map();localAddResources(topics);topics.forEach(t=>{if(!by.has(t.course_id))by.set(t.course_id,[]);by.get(t.course_id).push(t);});courses.forEach(c=>{let ts=by.get(c.id)||[];if(permitted&&permitted.access.access_mode==='demo'&&Number(c.id)===Number(permitted.access.demo_course_id))ts=localDemoVisibleSubtopics(ts,permitted.access.demo_topic_limit);c.subtopics=ts;});}
    res.json(courses);
  }catch(err){console.error(err);res.status(500).json({error:'Failed to fetch courses',detail:err.message});}
});
app.get('/api/courses/:id', async(req,res)=>{
  try{const permitted=localPermittedCourseIds(req.auth);if(permitted&&permitted.ids!==null&&!permitted.ids.includes(Number(req.params.id)))return res.status(403).json({error:'This course is not included in your current access.',code:'course_locked'});const course=db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);if(!course)return res.status(404).json({error:'Course not found'});let topics=db.prepare('SELECT * FROM subtopics WHERE course_id=? ORDER BY display_order ASC,id ASC').all(req.params.id);localAddResources(topics);if(permitted&&permitted.access.access_mode==='demo')topics=localDemoVisibleSubtopics(topics,permitted.access.demo_topic_limit);course.subtopics=topics;res.json(course);}catch(err){res.status(500).json({error:'Failed to fetch course'});}
});

app.post('/api/courses', async (req, res) => {
  const { title, slug, tag, short_description, description, duration_hours, level, image, display_order } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const courseSlug = slug || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  try {
    const result = db.prepare(
      'INSERT INTO courses (title, slug, tag, short_description, description, duration_hours, level, image, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, courseSlug, tag || 'Course', short_description || '', description || '', duration_hours || 10, level || 'Beginner', image || '', display_order || 0);
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(result.lastInsertRowid);
    course.subtopics = [];
    res.status(201).json(course);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Slug already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create course' });
  }
});

app.put('/api/courses/:id', async (req, res) => {
  const { title, slug, tag, short_description, description, duration_hours, level, image, status, display_order } = req.body;
  try {
    db.prepare(
      "UPDATE courses SET title = COALESCE(?, title), slug = COALESCE(?, slug), tag = COALESCE(?, tag), short_description = COALESCE(?, short_description), description = COALESCE(?, description), duration_hours = COALESCE(?, duration_hours), level = COALESCE(?, level), image = COALESCE(?, image), status = COALESCE(?, status), display_order = COALESCE(?, display_order), updated_at = datetime('now') WHERE id = ?"
    ).run(title, slug, tag, short_description, description, duration_hours, level, image, status, display_order, req.params.id);
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update course' });
  }
});

app.delete('/api/courses/:id', async (req, res) => {
  try {
    const course = db.prepare('SELECT id, title FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, course });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete course' });
  }
});


// =============================================================
// TRAINER BATCHES & ENROLMENT (local parity)
// =============================================================
function localBatchRows(auth){
 const args=auth.role==='trainer'?[auth.uid]:[];const where=auth.role==='trainer'?'WHERE b.trainer_id=?':'';
 const rows=db.prepare(`SELECT b.*,c.title AS course_title,c.tag AS course_tag,u.full_name AS trainer_name,COUNT(DISTINCT e.student_id) AS enrolled_count
  FROM batches b JOIN courses c ON c.id=b.course_id JOIN users u ON u.id=b.trainer_id LEFT JOIN batch_enrollments e ON e.batch_id=b.id AND e.status='active' ${where} GROUP BY b.id ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END,b.created_at DESC`).all(...args);
 return rows.map(b=>{const total=(db.prepare('SELECT COUNT(*) AS n FROM subtopics WHERE course_id=?').get(b.course_id)||{}).n||0;const done=db.prepare(`SELECT COUNT(DISTINCT lp.module_index) AS n FROM lesson_progress lp JOIN batch_enrollments e ON e.student_id=lp.student_id WHERE e.batch_id=? AND e.status='active' AND lp.course_name=?`).get(b.id,b.course_title)||{n:0};return Object.assign(b,{enrolled_count:Number(b.enrolled_count)||0,average_progress:total&&Number(b.enrolled_count)?Math.round(Number(done.n)*100/(total*Number(b.enrolled_count))):0});});
}
app.get('/api/trainer/dashboard',(req,res)=>{try{const batches=localBatchRows(req.auth),students=batches.reduce((n,b)=>n+Number(b.enrolled_count),0),avg=batches.length?Math.round(batches.reduce((n,b)=>n+Number(b.average_progress),0)/batches.length):0;res.json({mode:req.auth.role==='admin'?'oversight':'trainer',batches,summary:{batches:batches.length,students,average_progress:avg}});}catch(e){console.error(e);res.status(500).json({error:'Could not load trainer dashboard'});}});
app.get('/api/trainer/trainers',(req,res)=>{if(req.auth.role!=='admin')return res.status(403).json({error:'Admin access required.',code:'admin_required'});try{res.json(db.prepare("SELECT id,full_name,email FROM users WHERE role='trainer' ORDER BY full_name").all());}catch(e){res.status(500).json({error:'Could not load trainers'});}});
app.get('/api/batches',(req,res)=>{try{res.json(localBatchRows(req.auth));}catch(e){res.status(500).json({error:'Could not load batches'});}});
app.post('/api/batches',(req,res)=>{const b=req.body||{},name=String(b.name||'').trim(),courseId=Number(b.course_id);if(name.length<2||name.length>255||!courseId)return res.status(400).json({error:'Give the batch a name and choose a course.'});let trainerId=req.auth.uid;if(req.auth.role==='admin')trainerId=Number(b.trainer_id);try{const trainer=db.prepare("SELECT id FROM users WHERE id=? AND role='trainer'").get(trainerId),course=db.prepare("SELECT id FROM courses WHERE id=? AND status='active'").get(courseId);if(!trainer)return res.status(400).json({error:'Choose a valid trainer account.'});if(!course)return res.status(400).json({error:'Choose an active course.'});let code=localInviteCode();while(db.prepare('SELECT id FROM batches WHERE invite_code=?').get(code))code=localInviteCode();const out=db.prepare('INSERT INTO batches (name,course_id,trainer_id,invite_code,start_date,end_date) VALUES (?,?,?,?,?,?)').run(name,courseId,trainerId,code,b.start_date||null,b.end_date||null);res.status(201).json(db.prepare('SELECT * FROM batches WHERE id=?').get(out.lastInsertRowid));}catch(e){console.error(e);res.status(500).json({error:'Could not create batch'});}});
app.get('/api/batches/:id/students',(req,res)=>{try{const batch=localOwnBatch(req.auth,Number(req.params.id));if(batch===false)return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'});if(!batch)return res.status(404).json({error:'Batch not found'});const course=db.prepare('SELECT title FROM courses WHERE id=?').get(batch.course_id)||{},total=(db.prepare('SELECT COUNT(*) AS n FROM subtopics WHERE course_id=?').get(batch.course_id)||{}).n||0;const students=db.prepare(`SELECT u.id,u.full_name,u.email,e.enrolled_at,e.status,COUNT(DISTINCT lp.module_index) AS completed_topics FROM batch_enrollments e JOIN users u ON u.id=e.student_id LEFT JOIN lesson_progress lp ON lp.student_id=u.id AND lp.course_name=? WHERE e.batch_id=? GROUP BY u.id,e.id ORDER BY u.full_name`).all(course.title||'',batch.id).map(x=>Object.assign(x,{completed_topics:Number(x.completed_topics)||0,progress:total?Math.min(100,Math.round(Number(x.completed_topics||0)*100/total)):0}));res.json({batch,course_title:course.title||'',topic_count:total,students});}catch(e){res.status(500).json({error:'Could not load batch students'});}});
app.post('/api/batches/:id/enrollments',(req,res)=>{const email=String((req.body||{}).student_email||'').trim().toLowerCase();if(!email)return res.status(400).json({error:'Enter the student email address.'});try{const batch=localOwnBatch(req.auth,Number(req.params.id));if(batch===false)return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'});if(!batch)return res.status(404).json({error:'Batch not found'});const student=db.prepare("SELECT id,full_name,email FROM users WHERE email=? AND role='student'").get(email);if(!student)return res.status(404).json({error:'No student account exists for that email. Ask them to create their demo account first.'});db.prepare("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active') ON CONFLICT(batch_id,student_id) DO UPDATE SET status='active'").run(batch.id,student.id);db.prepare("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'batch',NULL,2) ON CONFLICT(student_id) DO UPDATE SET access_mode='batch'").run(student.id);res.status(201).json({enrolled:true,student});}catch(e){console.error(e);res.status(500).json({error:'Could not enrol that student'});}});
app.delete('/api/batches/:id/enrollments/:studentId',(req,res)=>{try{const batch=localOwnBatch(req.auth,Number(req.params.id));if(batch===false)return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'});if(!batch)return res.status(404).json({error:'Batch not found'});const studentId=Number(req.params.studentId);db.prepare('DELETE FROM batch_enrollments WHERE batch_id=? AND student_id=?').run(batch.id,studentId);const more=db.prepare("SELECT 1 FROM batch_enrollments WHERE student_id=? AND status='active' LIMIT 1").get(studentId);if(!more){const first=db.prepare("SELECT id FROM courses WHERE status='active' ORDER BY display_order,id LIMIT 1").get();db.prepare("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'demo',?,2) ON CONFLICT(student_id) DO UPDATE SET access_mode='demo',demo_course_id=excluded.demo_course_id").run(studentId,first?first.id:null);}res.json({removed:true});}catch(e){res.status(500).json({error:'Could not remove student from batch'});}});
app.post('/api/batches/join',(req,res)=>{const code=String((req.body||{}).invite_code||'').trim().toUpperCase();if(req.auth.role!=='student')return res.status(403).json({error:'Only student accounts can join a batch.'});if(!code)return res.status(400).json({error:'Enter a batch code.'});try{const batch=db.prepare("SELECT id,name,course_id FROM batches WHERE invite_code=? AND status='active'").get(code);if(!batch)return res.status(404).json({error:'That batch code is invalid or no longer active.'});db.prepare("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active') ON CONFLICT(batch_id,student_id) DO UPDATE SET status='active'").run(batch.id,req.auth.uid);db.prepare("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'batch',NULL,2) ON CONFLICT(student_id) DO UPDATE SET access_mode='batch'").run(req.auth.uid);res.json({joined:true,batch:{id:batch.id,name:batch.name}});}catch(e){res.status(500).json({error:'Could not join this batch'});}});

// =============================================================
// SUBTOPICS
// =============================================================

app.post('/api/courses/:id/subtopics', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order, parent_subtopic_id } = req.body;
  if (!title) return res.status(400).json({error: 'title is required'});
  try {
    let parentId=null;
    if(parent_subtopic_id!==undefined&&parent_subtopic_id!==null&&parent_subtopic_id!==''){
      parentId=Number(parent_subtopic_id);const parent=db.prepare('SELECT id,course_id,parent_subtopic_id FROM subtopics WHERE id=?').get(parentId);
      if(!parent||Number(parent.course_id)!==Number(req.params.id)||parent.parent_subtopic_id!==null)return res.status(400).json({error:'Choose a main subtopic from this course.'});
    }
    const result=db.prepare('INSERT INTO subtopics (course_id,parent_subtopic_id,title,slug,dur,description,video_url,pdf_url,exercise,display_order) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.params.id,parentId,title,slug||title.toLowerCase().replace(/[^a-z0-9]+/g,'-'),dur||'15 min',description||'',video_url||'',pdf_url||'',exercise||'',display_order||0);
    const sub=db.prepare('SELECT * FROM subtopics WHERE id=?').get(result.lastInsertRowid);res.status(201).json(sub);
  } catch (err) {res.status(500).json({error:'Failed to create subtopic'});}
});

app.put('/api/subtopics/:id', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order, parent_subtopic_id } = req.body;
  try {
    const old=db.prepare('SELECT * FROM subtopics WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Subtopic not found'});
    let parentId=null;if(parent_subtopic_id!==undefined){if(parent_subtopic_id!==null&&parent_subtopic_id!==''){parentId=Number(parent_subtopic_id);const parent=db.prepare('SELECT id,course_id,parent_subtopic_id FROM subtopics WHERE id=?').get(parentId);if(!parent||Number(parent.course_id)!==Number(old.course_id)||parent.parent_subtopic_id!==null||Number(parentId)===Number(req.params.id))return res.status(400).json({error:'Choose a different main subtopic from this course.'});}else parentId=old.parent_subtopic_id;}
    db.prepare("UPDATE subtopics SET title=COALESCE(?,title),slug=COALESCE(?,slug),dur=COALESCE(?,dur),description=COALESCE(?,description),video_url=COALESCE(?,video_url),pdf_url=COALESCE(?,pdf_url),exercise=COALESCE(?,exercise),display_order=COALESCE(?,display_order),parent_subtopic_id=COALESCE(?,parent_subtopic_id),updated_at=datetime('now') WHERE id=?").run(title,slug,dur,description,video_url,pdf_url,exercise,display_order,parent_subtopic_id===undefined?null:parentId,req.params.id);
    res.json(db.prepare('SELECT * FROM subtopics WHERE id=?').get(req.params.id));
  } catch (err) {res.status(500).json({error:'Failed to update subtopic'});}
});

app.delete('/api/subtopics/:id', async (req, res) => {
  try {const sub=db.prepare('SELECT id,title FROM subtopics WHERE id=?').get(req.params.id);if(!sub)return res.status(404).json({error:'Subtopic not found'});const count=(db.prepare('SELECT COUNT(*) AS n FROM subtopics WHERE parent_subtopic_id=?').get(req.params.id)||{}).n||0;db.transaction(()=>{db.prepare('DELETE FROM subtopics WHERE parent_subtopic_id=?').run(req.params.id);db.prepare('DELETE FROM subtopics WHERE id=?').run(req.params.id);})();res.json({deleted:true,subtopic:sub,deleted_children:count});}
  catch(err){res.status(500).json({error:'Failed to delete subtopic'});}
});

// =============================================================
// SUBTOPIC RESOURCE PLAYLISTS — multiple videos and PDF/PPTX per subtopic
// =============================================================
function localResourceType(body){const t=String((body||{}).resource_type||'').trim().toLowerCase();return t==='video'||t==='document'?t:'';}
function localDocumentOk(file){return /\.(pdf|pptx)(?:[?#].*)?$/i.test(String(file||''));}
app.get('/api/subtopics/:id/resources',(req,res)=>{try{res.json(db.prepare('SELECT * FROM subtopic_resources WHERE subtopic_id=? ORDER BY display_order ASC,id ASC').all(req.params.id));}catch(e){res.status(500).json({error:'Failed to fetch subtopic resources'});}});
app.post('/api/subtopics/:id/resources',(req,res)=>{const b=req.body||{},type=localResourceType(b),file=String(b.file_url||'').trim();if(!type||!file)return res.status(400).json({error:'A resource type and file URL are required.'});if(type==='document'&&!localDocumentOk(file))return res.status(400).json({error:'Documents must be PDF or PPTX files.'});try{const topic=db.prepare('SELECT id FROM subtopics WHERE id=?').get(req.params.id);if(!topic)return res.status(404).json({error:'Subtopic not found'});const title=String(b.title||'').trim().slice(0,255)||file.split(/[/?#]/).filter(Boolean).pop()||'Learning material',order=Math.max(0,Number(b.display_order)||0);const out=db.prepare('INSERT INTO subtopic_resources (subtopic_id,resource_type,title,file_url,display_order) VALUES (?,?,?,?,?)').run(req.params.id,type,title,file,order);res.status(201).json(db.prepare('SELECT * FROM subtopic_resources WHERE id=?').get(out.lastInsertRowid));}catch(e){res.status(500).json({error:'Failed to add learning material'});}});
app.put('/api/subtopic-resources/:id',(req,res)=>{const b=req.body||{},file=b.file_url===undefined?null:String(b.file_url).trim();if(file!==null&&!file)return res.status(400).json({error:'File URL cannot be empty.'});try{db.prepare("UPDATE subtopic_resources SET title=COALESCE(?,title),file_url=COALESCE(?,file_url),display_order=COALESCE(?,display_order),updated_at=datetime('now') WHERE id=?").run(b.title===undefined?null:String(b.title).trim().slice(0,255),file,b.display_order===undefined?null:Math.max(0,Number(b.display_order)||0),req.params.id);const row=db.prepare('SELECT * FROM subtopic_resources WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'Learning material not found'});res.json(row);}catch(e){res.status(500).json({error:'Failed to update learning material'});}});
app.delete('/api/subtopic-resources/:id',(req,res)=>{try{const r=db.prepare('DELETE FROM subtopic_resources WHERE id=?').run(req.params.id);if(!r.changes)return res.status(404).json({error:'Learning material not found'});res.json({deleted:true,id:Number(req.params.id)});}catch(e){res.status(500).json({error:'Failed to delete learning material'});}});

// =============================================================
// QUIZZES
// =============================================================

app.get('/api/quizzes', async (req, res) => {
  try {
    ensureQuizColumnsLocal();
    const w = [], args = [];
    if (req.query.course_id) { w.push('course_id = ?'); args.push(Number(req.query.course_id)); }
    if (req.query.course_name) { w.push('course_name = ?'); args.push(String(req.query.course_name)); }
    if (req.query.module_index !== undefined && req.query.module_index !== '') { w.push('module_index = ?'); args.push(Number(req.query.module_index)); }
    const rows = db.prepare('SELECT * FROM quizzes' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY module_index ASC, id ASC').all(...args);
    const counts = q('SELECT quiz_id, COUNT(*) AS n FROM questions GROUP BY quiz_id');
    const n = {}; counts.forEach(r => { n[r.quiz_id] = +r.n; });
    rows.forEach(r => {
      r.question_count = n[r.id] || 0;
      if (r.pass_pct == null) r.pass_pct = 60;
      r.bound = (r.module_index === null || r.module_index === undefined) ? 'course' : 'subtopic';
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

app.get('/api/quizzes/:id', async (req, res) => {
  try {
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const questions = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC').all(req.params.id);
    // the answer key stays on the server: students use /quizzes/<id>/paper
    if (!(req.auth && req.auth.role === 'admin')) questions.forEach(x => { delete x.correct_option; });
    quiz.questions = questions;
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

app.get('/api/quizzes/:id/questions', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

app.post('/api/quizzes', async (req, res) => {
  const { course_name, title } = req.body || {};
  try {
    ensureQuizColumnsLocal();
    if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });
    const body = req.body || {};
    const mi = (body.module_index === null || body.module_index === undefined || body.module_index === '') ? null : Number(body.module_index);
    if (mi !== null && (!isFinite(mi) || mi < 0)) return res.status(400).json({ error: 'module_index must be 0 or more' });
    const pp = Math.max(1, Math.min(100, parseInt(body.pass_pct, 10) || 60));
    const cid = body.course_id ? Number(body.course_id) : null;
    const cname = body.course_name ? String(body.course_name) : (cid ? ((q('SELECT title FROM courses WHERE id = ?', [cid])[0] || {}).title || '') : '');
    const result = db.prepare('INSERT INTO quizzes (course_name, title, course_id, module_index, pass_pct) VALUES (?, ?, ?, ?, ?)')
      .run(cname, String(title).trim(), cid, mi, pp);
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(quiz);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  try {
    const quiz = db.prepare('SELECT id, title FROM quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    db.prepare('UPDATE student_submissions SET quiz_id = NULL WHERE quiz_id = ?').run(req.params.id);
    db.prepare('DELETE FROM questions WHERE quiz_id = ?').run(req.params.id);
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, quiz });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// (no single-question write routes: a quiz is written as a whole, see
// PUT /api/quizzes/:id/assessment below — one validation path, one save, both engines.)

// =============================================================
// QUIZ SUBMISSIONS
// =============================================================

app.post('/api/quizzes/:id/submit', async (req, res) => {
  const { student_id, student_name, quiz_title } = req.body || {};
  const answers = (req.body && req.body.answers) || {};
  try {
    const questions = db.prepare('SELECT id, question_text, correct_option FROM questions WHERE quiz_id = ? ORDER BY id ASC').all(req.params.id);
    if (questions.length === 0) return res.status(400).json({ error: 'Quiz has no questions' });

    let correctCount = 0;
    questions.forEach(q => {
      if (answers[q.id] && answers[q.id].toUpperCase() === q.correct_option.toUpperCase()) correctCount++;
    });
    const score = Math.round((correctCount / questions.length) * 100);

    const meta = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id) || {};
    const need = Math.max(1, Math.min(100, parseInt(meta.pass_pct, 10) || 60));
    const result = db.prepare(
      'INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(student_id, student_name, req.params.id, quiz_title || meta.title || '', JSON.stringify(answers), score);
    const review = questions.map(qq => ({ id: qq.id, correct_option: qq.correct_option, chosen: (answers && answers[qq.id] ? String(answers[qq.id]).toUpperCase() : '') }));
    res.json({ review, submission_id: result.lastInsertRowid, score, passed: score >= need, pass_pct: need,
      correct_count: correctCount, total_count: questions.length,
      quiz_id: meta.id || Number(req.params.id), quiz_title: meta.title || '', course_name: meta.course_name || '',
      course_id: meta.course_id ?? null, module_index: meta.module_index ?? null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM student_submissions ORDER BY submitted_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// =============================================================
// PROGRESS TRACKING
// =============================================================

app.get('/api/progress', async (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  try {
    const rows = db.prepare('SELECT * FROM lesson_progress WHERE student_id = ? ORDER BY course_name, module_index').all(student_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

app.get('/api/progress/course', async (req, res) => {
  const { student_id, course_name } = req.query;
  try {
    const rows = db.prepare('SELECT * FROM lesson_progress WHERE student_id = ? AND course_name = ? ORDER BY module_index').all(student_id, course_name);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch course progress' });
  }
});

app.post('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.body;
  try {
    if(!localMayStudy(req.auth,course_name,module_index)) return res.status(403).json({error:'This lesson is outside your current course access.',code:'course_locked'});
    db.prepare(
      "INSERT OR IGNORE INTO lesson_progress (student_id, course_name, module_index) VALUES (?, ?, ?)"
    ).run(student_id, course_name, module_index);
    const rows = db.prepare('SELECT * FROM lesson_progress WHERE student_id = ? AND course_name = ? ORDER BY module_index').all(student_id, course_name);
    res.status(201).json({ saved: true, progress: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

app.delete('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.query;
  try {
    if (course_name && module_index !== undefined) {
      db.prepare('DELETE FROM lesson_progress WHERE student_id=? AND course_name=? AND module_index=?').run(student_id, course_name, module_index);
    } else if (course_name) {
      db.prepare('DELETE FROM lesson_progress WHERE student_id=? AND course_name=?').run(student_id, course_name);
    } else {
      db.prepare('DELETE FROM lesson_progress WHERE student_id=?').run(student_id);
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete progress' });
  }
});

// =============================================================
// FILE UPLOAD
// =============================================================

const LOCAL_MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;
const LOCAL_UPLOAD_FOLDERS = { video: 'videos', pdf: 'pdfs', image: 'images' };
const localPickFolder = type => LOCAL_UPLOAD_FOLDERS[type] || null;
const LOCAL_ALLOW_EXT = {
  videos: ['.mp4', '.webm', '.m4v', '.mov'],
  pdfs: ['.pdf', '.pptx'],
  images: ['.png', '.jpg', '.jpeg', '.webp', '.gif']
};
function localUploadTypeOk(folder, file) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  if (!folder || !LOCAL_ALLOW_EXT[folder] || !LOCAL_ALLOW_EXT[folder].includes(ext)) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  if (folder === 'videos') return /^video\//.test(mime);
  if (folder === 'images') return /^image\/(png|jpe?g|webp|gif)$/.test(mime);
  return ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream', 'application/zip'].includes(mime);
}
function localDocumentLooksReal(filePath, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  let fd, b = Buffer.alloc(8), got = 0;
  try { fd = fs.openSync(filePath, 'r'); got = fs.readSync(fd, b, 0, b.length, 0); } catch (e) { return false; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) {} }
  if (ext === '.pdf') return got >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-';
  if (ext === '.pptx') return got >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08);
  return false;
}
// Disk storage mirrors production and does not hold a large training video in Node's memory.
const localUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = localPickFolder(req.body && req.body.type);
    if (!folder) return cb(Object.assign(new Error('Choose video, PDF/PPTX, or image before uploading'), { code: 'BAD_TYPE' }));
    const dir = path.join(__dirname, folder); fs.mkdirSync(dir, { recursive: true }); cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2,7)}_${safe || 'file'}`);
  }
});
const upload = multer({
  storage: localUploadStorage,
  limits: { fileSize: LOCAL_MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const folder = localPickFolder(req.body && req.body.type);
    if (!localUploadTypeOk(folder, file)) return cb(Object.assign(new Error('Only ' + ((folder && LOCAL_ALLOW_EXT[folder]) || ['.mp4', '.pdf', '.pptx', '.png']).join(', ') + ' files can be uploaded here'), { code: 'BAD_TYPE' }));
    cb(null, true);
  }
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File is larger than the ${LOCAL_MAX_UPLOAD_MB} MB limit.` : ('Upload failed: ' + (err.message || 'bad request')) });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const folder = localPickFolder(req.body && req.body.type);
    if (folder === 'pdfs' && !localDocumentLooksReal(req.file.path, req.file.originalname)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'This is not a readable PDF or PPTX file. Export/save it again and upload the .pdf or .pptx file.' });
    }
    const filePath = `${folder}/${req.file.filename}`;
    const url = `${req.protocol}://${req.get('host')}/${filePath}`;
    res.json({ url, path: filePath, size: req.file.size });
  });
});


// =============================================================
// LOCAL PARITY BLOCK — lesson locks, live time, config and admin
// analytics, so localhost behaves like the deployed server.
// Everything here is SQLite (better-sqlite3), local file only.
// =============================================================
const STEP_ORDER = ['video', 'pdf', 'mcq', 'ex'];
const LOCAL_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STEP_CONFIG_FILE = path.join(LOCAL_DATA_DIR, 'lesson_config.json');
for (const sub of ['videos', 'pdfs', 'images']) {
  try { fs.mkdirSync(path.join(LOCAL_DATA_DIR, sub), { recursive: true }); } catch (e) {}
}
try { app.use('/videos', express.static(path.join(LOCAL_DATA_DIR, 'videos'))); } catch (e) {}

function readStepConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(STEP_CONFIG_FILE, 'utf8')); } catch (e) {}
  const clamp = (v, d) => { v = parseInt(v, 10); return (isFinite(v) && v >= 50 && v <= 100) ? v : d; };
  return { video_req_pct: clamp(c.video_req_pct, 90), pdf_req_pct: clamp(c.pdf_req_pct, 90) };
}
if (db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lesson_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL, course_name TEXT NOT NULL, module_index INTEGER NOT NULL,
    step TEXT NOT NULL, pct INTEGER NOT NULL DEFAULT 100,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, course_name, module_index, step));`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_time (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, day));`);
}
const q = (sql, args) => { try { return db.prepare(sql).all(args || []); } catch (e) { if (/no such table/i.test(e.message)) return []; throw e; } };
const run = (sql, args) => { try { return db.prepare(sql).run(args || []); } catch (e) { if (/no such table/i.test(e.message)) return {}; throw e; } };
const localDay = (dt) => { const x = new Date(dt); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const daysAgo = (n) => localDay(new Date(Date.now() - n * 864e5));

app.get('/api/config', (req, res) => res.json(readStepConfig()));
app.post('/api/config', (req, res) => {
  try {
    const b = req.body || {};
    const clamp = (v, d) => { v = parseInt(v, 10); return (isFinite(v) && v >= 50 && v <= 100) ? v : d; };
    const cur = readStepConfig();
    const next = { video_req_pct: clamp(b.video_req_pct, cur.video_req_pct), pdf_req_pct: clamp(b.pdf_req_pct, cur.pdf_req_pct) };
    try { fs.writeFileSync(STEP_CONFIG_FILE, JSON.stringify(next, null, 2)); } catch (e) { console.warn('config persist failed:', e.message); }
    res.json({ saved: true, config: next });
  } catch (e) { res.status(500).json({ error: 'Failed to save config' }); }
});

app.get('/api/steps', (req, res) => {
  const student_id = parseInt(req.query.student_id, 10);
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  if(req.query.course_name && !localMayStudy(req.auth,req.query.course_name,0)) return res.status(403).json({error:'This course is outside your current access.',code:'course_locked'});
  let rows = q('SELECT module_index, step, pct, completed_at FROM lesson_steps WHERE student_id=?', [student_id]);
  if (req.query.course_name) rows = q('SELECT module_index, step, pct, completed_at FROM lesson_steps WHERE student_id=? AND course_name=? ORDER BY module_index, step', [student_id, req.query.course_name]);
  res.json(rows);
});

app.post('/api/steps', (req, res) => {
  try {
    const b = req.body || {};
    const student_id = parseInt(b.student_id, 10), module_index = parseInt(b.module_index, 10);
    const course_name = b.course_name, step = b.step;
    if (!student_id || !course_name || isNaN(module_index) || !STEP_ORDER.includes(step))
      return res.status(400).json({ error: 'student_id, course_name, module_index and a valid step (video|pdf|mcq|ex) are required' });
    if(!localMayStudy(req.auth,course_name,module_index)) return res.status(403).json({error:'This lesson is outside your current course access.',code:'course_locked'});
    const pct = Math.max(0, Math.min(100, parseInt(b.pct, 10) || 100));
    const cfg = readStepConfig();
    const have = {}; q('SELECT step, pct FROM lesson_steps WHERE student_id=? AND course_name=? AND module_index=?', [student_id, course_name, module_index]).forEach(r => { have[r.step] = r.pct; });
    const videoOk = (have.video || 0) >= cfg.video_req_pct, pdfOk = (have.pdf || 0) >= cfg.pdf_req_pct;
    if (step === 'video' && pct < cfg.video_req_pct)
      return res.status(403).json({ error: 'Watch at least ' + cfg.video_req_pct + '% of the video before it counts as complete' });
    if (step === 'pdf') {
      if (!videoOk) return res.status(403).json({ error: 'Complete the lesson video before recording PDF completion' });
      if (pct < cfg.pdf_req_pct) return res.status(403).json({ error: 'Read at least ' + cfg.pdf_req_pct + '% of the document (reach the last page)' });
    }
    if (step === 'mcq' && !pdfOk) return res.status(403).json({ error: 'Complete the PDF before recording an MCQ pass' });
    if (step === 'ex' && !(have.mcq != null)) return res.status(403).json({ error: 'Pass the MCQ before marking the exercise done' });
    run(`INSERT INTO lesson_steps (student_id, course_name, module_index, step, pct) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(student_id, course_name, module_index, step)
         DO UPDATE SET pct=MAX(pct, excluded.pct), completed_at=CURRENT_TIMESTAMP`,
        [student_id, course_name, module_index, step, pct]);
    res.status(201).json({ saved: true, steps: q('SELECT module_index, step, pct FROM lesson_steps WHERE student_id=? AND course_name=? AND module_index=?', [student_id, course_name, module_index]) });
  } catch (e) { console.error('steps save failed:', e); res.status(500).json({ error: 'Failed to save step' }); }
});

app.post('/api/time', (req, res) => {
  try {
    const b = req.body || {};
    const sid = Number(b.student_id);
    let secs = Math.round(Number(b.seconds));
    if (!sid || !isFinite(secs) || secs <= 0) return res.status(400).json({ error: 'student_id and positive seconds required' });
    secs = Math.min(secs, 7200);
    run(`INSERT INTO user_time (student_id, day, seconds) VALUES (?, ?, ?)
         ON CONFLICT(student_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`,
        [sid, localDay(new Date()), secs]);
    res.status(201).json({ ok: true, added_seconds: secs });
  } catch (e) { res.status(500).json({ error: 'Failed to log time' }); }
});

app.get('/api/time', (req, res) => {
  const sid = Number(req.query.student_id);
  if (!sid) return res.status(400).json({ error: 'student_id required' });
  const cutoff = daysAgo(6);
  const agg = q(`SELECT COALESCE(SUM(seconds),0) AS total_seconds,
                        COALESCE(SUM(CASE WHEN day >= ? THEN seconds ELSE 0 END),0) AS week_seconds
                 FROM user_time WHERE student_id = ?`, [cutoff, sid])[0] || { total_seconds: 0, week_seconds: 0 };
  const days = q('SELECT DISTINCT day AS d FROM user_time WHERE student_id=? AND seconds>0 ORDER BY d DESC LIMIT 45', [sid]);
  let streak = 0;
  if (days.length) {
    let expect = localDay(new Date());
    if (days[0].d !== expect && days[0].d === daysAgo(1)) expect = days[0].d;
    const set = new Set(days.map(r => r.d));
    while (set.has(expect)) { streak++; expect = localDay(new Date(Date.parse(expect + 'T12:00:00') - 864e5)); }
  }
  res.json({ total_seconds: +agg.total_seconds || 0, week_seconds: +agg.week_seconds || 0, streak_days: streak, recent_days: days.slice(0, 7).map(r => r.d) });
});

app.get('/api/analytics/summary', (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'SQLite unavailable' });
    const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
    const cutoff = daysAgo(days - 1), weekCut = daysAgo(6), streakCut = daysAgo(45);
    const studentsRaw = q("SELECT id, full_name, email, created_at FROM users WHERE role = 'student' ORDER BY created_at DESC");
    const timeRaw = q(`SELECT student_id, COALESCE(SUM(seconds),0) AS total_s, MAX(day) AS last_day,
                              COALESCE(SUM(CASE WHEN day >= ? THEN seconds ELSE 0 END),0) AS week_s
                       FROM user_time GROUP BY student_id`, [weekCut]);
    const progRaw = q('SELECT student_id, course_name, COUNT(DISTINCT module_index) AS done FROM lesson_progress GROUP BY student_id, course_name');
    const stepsRaw = q('SELECT course_name, module_index, step, COUNT(DISTINCT student_id) AS cnt FROM lesson_steps GROUP BY course_name, module_index, step');
    const enrollRaw = q('SELECT course_name, COUNT(DISTINCT student_id) AS enrolled FROM lesson_steps GROUP BY course_name');
    const courseStepRaw = q('SELECT course_name, step, COUNT(DISTINCT student_id) AS students FROM lesson_steps GROUP BY course_name, step');
    const touchedRaw = q('SELECT student_id, course_name, COUNT(DISTINCT module_index) AS touched, MAX(module_index) AS furthest FROM lesson_steps GROUP BY student_id, course_name');
    const coursesRaw = q("SELECT id, title FROM courses WHERE status = 'active' ORDER BY display_order ASC, id ASC")
      .map(c => ({ ...c, subtopic_count: q('SELECT COUNT(*) AS n FROM subtopics WHERE course_id=?', [c.id])[0].n }));
    const quizByStRaw = q('SELECT student_id, AVG(score) AS avg_score, COUNT(*) AS attempts FROM student_submissions GROUP BY student_id');
    const quizAllRaw = q('SELECT COUNT(*) AS n, COALESCE(AVG(score),0) AS avg_score FROM student_submissions');
    const seriesRaw = q('SELECT day AS d, student_id, seconds FROM user_time WHERE day >= ? ORDER BY d ASC', [cutoff]);
    const streakRaw = q('SELECT student_id, day AS d FROM user_time WHERE seconds > 0 AND day >= ? ORDER BY student_id ASC, d DESC LIMIT 20000', [streakCut]);

    const dstr = (x) => (x == null ? null : (typeof x === 'string' ? x.slice(0, 10) : String(x).slice(0, 10)));
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const DAY = 864e5;
    const streakMap = {};
    { const bySt = {}; streakRaw.forEach(r => { (bySt[r.student_id] = bySt[r.student_id] || new Set()).add(r.d); });
      Object.keys(bySt).forEach(sid => { const set = bySt[sid]; let expect = today.getTime(), st = 0;
        if (!set.has(new Date(expect).toISOString().slice(0, 10))) expect -= DAY;
        while (set.has(new Date(expect).toISOString().slice(0, 10))) { st++; expect -= DAY; }
        streakMap[sid] = st; }); }
    const timeMap = {}; timeRaw.forEach(r => { timeMap[r.student_id] = r; });
    const quizMap = {}; quizByStRaw.forEach(r => { quizMap[r.student_id] = { avg: Math.round((+r.avg_score) * 10) / 10, attempts: +r.attempts }; });
    const subByTitle = {}; coursesRaw.forEach(c => { subByTitle[c.title] = Number(c.subtopic_count) || 0; });
    const doneMap = {}, progCourses = {};
    progRaw.forEach(r => { (doneMap[r.student_id] = doneMap[r.student_id] || {})[r.course_name] = +r.done;
      (progCourses[r.course_name] = progCourses[r.course_name] || new Set()).add(r.student_id); });
    const touchMap = {}, touchCourses = {};
    touchedRaw.forEach(r => { const o = (touchMap[r.student_id] = touchMap[r.student_id] || {});
      o[r.course_name] = { touched: +r.touched, furthest: +r.furthest };
      (touchCourses[r.course_name] = touchCourses[r.course_name] || new Set()).add(r.student_id); });
    const enrollFromSteps = {}; enrollRaw.forEach(r => { enrollFromSteps[r.course_name] = +r.enrolled; });
    const funnelByCourse = {};
    courseStepRaw.forEach(r => { (funnelByCourse[r.course_name] = funnelByCourse[r.course_name] || {})[r.step] = +r.students; });
    const stepMatrix = {};
    stepsRaw.forEach(r => { const c = (stepMatrix[r.course_name] = stepMatrix[r.course_name] || {});
      const m = (c[r.module_index] = c[r.module_index] || {}); m[r.step] = +r.cnt; });
    function biggestStall(courseName) {
      const cm = stepMatrix[courseName]; if (!cm) return null;
      const mods = Object.keys(cm).map(Number).sort((a, b) => a - b);
      const finished = mods.map(m => { const o = cm[m]; return o.ex != null ? o.ex : (o.mcq != null ? o.mcq : (o.pdf != null ? o.pdf : (o.video || 0))); });
      let worst = 0, at = -1;
      for (let i = 1; i < mods.length; i++) { const loss = finished[i - 1] - finished[i]; if (loss > worst) { worst = loss; at = i; } }
      if (at < 0) return null;
      return { module: mods[at] + 1, lost: worst, label: 'Subtopic ' + (mods[at] + 1) };
    }
    const learners = studentsRaw.map(u => {
      const t = timeMap[u.id] || {}, dn = doneMap[u.id] || {}, tc = touchMap[u.id] || {};
      const courseNames = new Set([...Object.keys(dn), ...Object.keys(tc)]);
      let pctSum = 0, pctN = 0, certified = 0;
      courseNames.forEach(cn => { const subs = subByTitle[cn] != null ? subByTitle[cn] : 0;
        const p = subs > 0 ? Math.min(100, Math.round(((dn[cn] || 0) / subs) * 100)) : 0;
        pctSum += p; pctN++; if (p >= 100) certified++; });
      const avgPct = pctN ? Math.round(pctSum / pctN) : 0;
      const last = dstr(t.last_day);
      const idle = last ? Math.floor((today.getTime() - Date.parse(last + 'T12:00:00')) / DAY) : 999;
      const hours = Math.round(((+t.total_s || 0) / 3600) * 10) / 10;
      const weekH = Math.round(((+t.week_s || 0) / 3600) * 10) / 10;
      const qq = quizMap[u.id] || null;
      let status = 'not-started';
      if (courseNames.size > 0 || +t.total_s > 0) {
        if (!last) status = 'needs-nudge';
        else if (idle >= 7) status = 'at-risk';
        else if (idle >= 3 || (pctN > 0 && avgPct < 40)) status = 'needs-nudge';
        else status = 'on-track';
      }
      return { id: u.id, name: u.full_name || u.email || 'Learner #' + u.id, email: u.email || '',
        courses: courseNames.size, avg_pct: avgPct, certified, hours, week_hours: weekH,
        streak: streakMap[u.id] || 0, quiz_avg: qq ? qq.avg : null, quiz_attempts: qq ? qq.attempts : 0,
        last_active: last, idle_days: idle > 3650 ? null : idle, status };
    });
    const courses = coursesRaw.map(c => {
      const enrolledSet = new Set([...(progCourses[c.title] || []), ...(touchCourses[c.title] || [])]);
      const enrolled = Math.max(enrolledSet.size, enrollFromSteps[c.title] || 0);
      let pctSum = 0, pctN = 0, certs = 0;
      enrolledSet.forEach(sid => { const subs = Number(c.subtopic_count) || 0;
        const p = subs > 0 ? Math.min(100, Math.round(((doneMap[sid] && doneMap[sid][c.title]) || 0) / subs * 100)) : 0;
        pctSum += p; pctN++; if (p >= 100) certs++; });
      return { title: c.title, subtopics: Number(c.subtopic_count) || 0, enrolled,
        avg_pct: pctN ? Math.round(pctSum / pctN) : 0, certificates: certs,
        funnel: funnelByCourse[c.title] || {}, stall: biggestStall(c.title) };
    });
    const globalFunnel = {}; ['video', 'pdf', 'mcq', 'ex'].forEach(k => { globalFunnel[k] = courses.reduce((a, c) => a + (c.funnel[k] || 0), 0); });
    const nSub = learners.filter(l => l.status !== 'not-started').length;
    const byDay = {};
    seriesRaw.forEach(r => { const o = (byDay[r.d] = byDay[r.d] || { students: new Set(), seconds: 0 }); o.students.add(r.student_id); o.seconds += +r.seconds || 0; });
    const series = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(today.getTime() - i * DAY).toISOString().slice(0, 10);
      const row = byDay[d]; series.push({ d, active: row ? row.students.size : 0, minutes: row ? Math.round(row.seconds / 60) : 0 }); }
    const quizAll = quizAllRaw[0] || { n: 0, avg_score: 0 };
    res.json({
      ok: true, days, generated_at: new Date().toISOString(), local: true,
      totals: {
        learners: studentsRaw.length, engaged: nSub,
        active_7d: timeRaw.filter(r => (+r.week_s || 0) > 0).length,
        avg_completion: Math.round(learners.length ? learners.reduce((a, l) => a + l.avg_pct, 0) / Math.max(1, learners.length) : 0),
        hours: Math.round((timeRaw.reduce((a, r) => a + (+r.total_s || 0), 0) / 3600) * 10) / 10,
        certificates: learners.reduce((a, l) => a + l.certified, 0),
        quiz_avg: Math.round((+quizAll.avg_score || 0) * 10) / 10, quiz_submissions: +quizAll.n || 0
      },
      funnel: globalFunnel, series, courses,
      learners: learners.sort((a, b) => (a.idle_days - b.idle_days))
    });
  } catch (e) { console.error('local analytics failed:', e); res.status(500).json({ error: 'Analytics unavailable', detail: e.message }); }
});


// -------- per-subtopic assessments (SQLite mirror of the cloud routes) --------
function ensureQuizColumnsLocal() {
  if (!db) return;
  try {
    const cols = db.prepare('PRAGMA table_info(quizzes)').all().map(c => c.name);
    if (!cols.includes('course_id')) db.exec('ALTER TABLE quizzes ADD COLUMN course_id INTEGER');
    if (!cols.includes('module_index')) db.exec('ALTER TABLE quizzes ADD COLUMN module_index INTEGER');
    if (!cols.includes('pass_pct')) db.exec('ALTER TABLE quizzes ADD COLUMN pass_pct INTEGER DEFAULT 60');
  } catch (e) { console.warn('[DB] quizzes column check skipped:', e.message); }
}
ensureQuizColumnsLocal();

// ---- the quiz editor's single save: title + pass mark + the whole question set ----
function checkQuestionsLocal(questions) {
  const clean = [];
  for (const qq of questions) {
    const text = String(qq.question_text || '').trim();
    if (!text) continue;
    const opts = ['option_a', 'option_b', 'option_c', 'option_d'].map(k => String(qq[k] == null ? '' : qq[k]).trim().slice(0, 500));
    if (opts.filter(x => x).length < 2) return { error: 'Every question needs at least two answer options', question: text.slice(0, 60) };
    const correct = String(qq.correct_option || '').trim().toUpperCase().slice(0, 1);
    const ci = correct ? 'ABCD'.indexOf(correct) : -1;   // indexOf('') is 0 — guard the blank case
    if (ci < 0 || !opts[ci]) return { error: 'Mark which option is correct for: ' + text.slice(0, 60) };
    clean.push([text, opts[0], opts[1], opts[2], opts[3], correct]);
  }
  if (!clean.length) return { error: 'Add at least one question with text, two options and a marked answer.' };
  return { clean };
}

// keeps a question's id when its wording is unchanged, so past submissions still point at a live row
function writeQuizQuestionsLocal(quizId, clean) {
  const have = q('SELECT id, question_text FROM questions WHERE quiz_id = ? ORDER BY id ASC', [quizId]);
  const byText = {}; have.forEach(r => { const k = String(r.question_text); if (!(k in byText)) byText[k] = r.id; });
  const keep = [];
  for (const [text, a, b, c, d, correct] of clean) {
    const oldId = byText[text];
    if (oldId) { run('UPDATE questions SET option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_option = ? WHERE id = ?', [a, b, c, d, correct, oldId]); keep.push(oldId); }
    else keep.push(run('INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?)', [quizId, text, a, b, c, d, correct]).lastInsertRowid);
  }
  if (keep.length) run('DELETE FROM questions WHERE quiz_id = ? AND id NOT IN (' + keep.map(() => '?').join(',') + ')', [quizId].concat(keep));
  else run('DELETE FROM questions WHERE quiz_id = ?', [quizId]);
  return q('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [quizId]);
}

app.put('/api/quizzes/:id/assessment', (req, res) => {
  try {
    ensureQuizColumnsLocal();
    const id = Number(req.params.id);
    const found = q('SELECT * FROM quizzes WHERE id = ?', [id])[0];
    if (!found) return res.status(404).json({ error: 'Quiz not found' });
    const body = req.body || {};
    const upd = [], args = [];
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return res.status(400).json({ error: 'Give the quiz a title' });
      upd.push('title = ?'); args.push(t);
    }
    if (body.pass_pct !== undefined) { upd.push('pass_pct = ?'); args.push(Math.max(1, Math.min(100, parseInt(body.pass_pct, 10) || 60))); }
    if (upd.length) { args.push(id); run('UPDATE quizzes SET ' + upd.join(', ') + ' WHERE id = ?', args); }
    let questions;
    if (Array.isArray(body.questions)) {
      if (!body.questions.length) { run('DELETE FROM questions WHERE quiz_id = ?', [id]); questions = []; }
      else {
        const v = checkQuestionsLocal(body.questions);
        if (v.error) return res.status(400).json({ error: v.error, question: v.question });
        questions = writeQuizQuestionsLocal(id, v.clean);
      }
    } else {
      questions = q('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [id]);
    }
    res.json({ saved: true, quiz_id: id, quiz: q('SELECT * FROM quizzes WHERE id = ?', [id])[0], questions });
  } catch (e) { console.error('quiz save failed:', e); res.status(500).json({ error: 'Failed to save quiz' }); }
});

// questions without the answer key — what the student page is allowed to read
app.get('/api/quizzes/:id/paper', (req, res) => {
  res.json(q('SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]));
});

// =============================================================
// START SERVER
// =============================================================

const PORT = process.env.PORT || 3000;
function listenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('\n[Port] Port ' + PORT + ' is already in use, so this app did NOT start.');
    console.error('   → Usually it is already running in another window (or the demo is up).');
    console.error('     Windows:   netstat -ano | findstr :' + PORT + '   →  taskkill /PID <the number> /F');
    console.error('     macOS/Linux:  lsof -ti :' + PORT + ' | xargs kill');
    console.error('   → Or put this one on another port:  Windows: set PORT=4100 && npm start   ·   Mac/Linux: PORT=4100 npm start\n');
    process.exit(1);
  }
  console.error('\n[Port] Could not listen on ' + PORT + ':', (err && err.message) || err);
  process.exit(1);
}
const SERVER = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Softmarc API running on port ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`\n👤 Admin (local demo only — not the cloud site):`);
  console.log(`   Email: admin@softmarc.com`);
  console.log(DEMO_ADMIN_PW
    ? `   Password: ${DEMO_ADMIN_PW}  (shown once, because softmarc.db was just created)`
    : `   Password: the one you chose earlier (softmarc.db already existed)`);
  console.log(`   Set it yourself instead: ADMIN_PASSWORD=yourchoice npm run local\n`);
});
SERVER.on('error', listenError);

module.exports = app;
