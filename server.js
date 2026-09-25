// path must exist before dotenv uses it (the later `const path` was merged into this one)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);   // Cloudflare/Hostinger forward the real client IP; needed for sane rate limiting and HSTS
let __compression = null;
try { __compression = require('compression'); } catch (e) { console.warn('[Perf] compression package missing — responses sent uncompressed (run npm install)'); }
if (__compression) app.use(__compression());
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

// ---------- response hardening ----------
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


// =============================================================
// PERSISTENT FILE STORAGE (survives redeploys!)
// Hostinger "hbuilds" runs the app from versions/<uuid>/nodejs --
// that folder is replaced on every deploy. So uploads are stored
// OUTSIDE it at domains/<site>/data/ (auto-detected; overridable
// with DATA_DIR env var). Locally it just uses ./data
// =============================================================
const isHBuild = __dirname.includes(path.sep + 'hbuilds' + path.sep);
const DATA_DIR = process.env.DATA_DIR || (isHBuild
  ? path.resolve(__dirname, '../../../../data')
  : path.join(__dirname, 'data'));
for (const sub of ['videos','pdfs','images']) {
  try { fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true }); } catch(e){ console.error('[Storage] mkdir failed:', e.message); }
}
console.log('[Storage] Persistent file dir:', DATA_DIR);

// =============================================================
// SECURITY — never serve backend/config files over HTTP
// (express.static would happily expose server.js, *.sql, .env…)
// =============================================================
app.use((req, res, next) => {
  const p = (req.path || '').split('/').pop().toLowerCase();
  const blocked =
    ['server.js','server-local.js','seed.js','index.js','package.json','package-lock.json','.gitignore','.npmrc','.htaccess']
      .includes(p)
    || p.endsWith('.sql') || p.endsWith('.log') || p.endsWith('.sh') || p.endsWith('.bat')
    || p.endsWith('.md')            // setup guides mention default admin credentials
    || /\.(db|db-wal|db-shm|sqlite3?|key|pem|authkey|conf|ini|bak|old)$/i.test(p)
    || p.endsWith('.json')         // package.json, tsconfig, stray dumps
    || p.startsWith('.env');
  if (blocked) return res.status(403).send('Forbidden');
  next();
});

const ONE_DAY = 24 * 60 * 60 * 1000;
// Documents are intentionally public to lesson viewers, but this is not a general public file
// folder. Serve only the two formats the in-lesson reader understands — never a stray HTML,
// script, archive or backup someone placed in data/pdfs by mistake.
const PUBLIC_DOCUMENT_EXT = new Set(['.pdf', '.pptx']);
function lessonDocumentOnly(req, res, next) {
  let ext = '';
  try { ext = path.extname(decodeURIComponent(req.path || '')).toLowerCase(); } catch (e) {}
  if (!PUBLIC_DOCUMENT_EXT.has(ext)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=' + (ONE_DAY / 1000));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
app.use('/videos', express.static(path.join(DATA_DIR, 'videos'), { maxAge: ONE_DAY }), express.static(path.join(__dirname, 'videos'), { maxAge: ONE_DAY }));
app.use('/pdfs', lessonDocumentOnly, express.static(path.join(DATA_DIR, 'pdfs'), { maxAge: ONE_DAY }));
app.use('/images', express.static(path.join(DATA_DIR, 'images'), { maxAge: ONE_DAY }));
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // HTML + JS + CSS: always revalidate (304 is free) so an upload is live instantly, no stale-cache surprises
    if (['.html', '.js', '.css', '.mjs'].includes(ext)) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    else if (['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.woff2', '.woff'].includes(ext)) res.setHeader('Cache-Control', 'public, max-age=' + (ONE_DAY / 1000));
  }
}));
// browsers auto-request /favicon.ico on every page — serve the logo instead of a 404
app.get('/favicon.ico', (req, res) => {
  const ico = path.join(__dirname, 'favicon.png');
  if (fs.existsSync(ico)) { res.type('png'); res.sendFile(ico); } else res.status(404).end();
});

// =============================================================
// MYSQL CONNECTION
// Set these in Environment Variables
// =============================================================

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || 'softmarc',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// Warm up pool
pool.query('SELECT 1').then(() => console.log('[DB] MySQL connected')).catch(e => console.error('[DB] Connection failed:', e.message));

// =============================================================
// DB CONFIG CHECK — never silently fall back to root@localhost
// =============================================================
const DB_CFG = {
  host: process.env.DB_HOST || '',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || '',
  user: process.env.DB_USER || ''
};
const DB_MISSING = ['DB_HOST', 'DB_NAME', 'DB_USER'].filter(k => !process.env[k]);
const ENV_FILE = path.join(__dirname, '.env');
if (DB_MISSING.length) {
  console.warn('[DB] NOT configured — missing env var(s): ' + DB_MISSING.join(', ') +
    (fs.existsSync(ENV_FILE)
      ? ` (a .env file WAS found at ${ENV_FILE} — it is there but does not define these keys; note that .env.local is NOT read)`
      : ` (no .env file at ${ENV_FILE}; .env.local is ignored on purpose)`));
} else {
  console.log(`[DB] target ${DB_CFG.user}@${DB_CFG.host}:${DB_CFG.port}/${DB_CFG.database}`);
}

// =============================================================
// Demo access + trainer batch enrolment
// =============================================================
let accessTablesReady = null;
function ensureAccessTables() {
  if (!accessTablesReady) accessTablesReady = Promise.all([
    pool.query(`CREATE TABLE IF NOT EXISTS student_access (
      student_id INT NOT NULL PRIMARY KEY, access_mode VARCHAR(20) NOT NULL DEFAULT 'full',
      demo_course_id INT DEFAULT NULL, demo_topic_limit INT NOT NULL DEFAULT 2,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_access_mode (access_mode)
    )`),
    pool.query(`CREATE TABLE IF NOT EXISTS batches (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, course_id INT NOT NULL,
      trainer_id INT NOT NULL, invite_code VARCHAR(32) NOT NULL UNIQUE,
      start_date DATE DEFAULT NULL, end_date DATE DEFAULT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_batches_trainer (trainer_id), INDEX idx_batches_course (course_id)
    )`),
    pool.query(`CREATE TABLE IF NOT EXISTS batch_enrollments (
      id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, student_id INT NOT NULL,
      enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status VARCHAR(20) NOT NULL DEFAULT 'active',
      UNIQUE KEY unique_batch_student (batch_id, student_id), INDEX idx_enrolment_student (student_id)
    )`)
  ]).catch(err => { accessTablesReady = null; throw err; });
  return accessTablesReady;
}
// Existing Hostinger databases may predate the detailed self-enrolment fields.
// The server adds them safely as soon as the updated app starts; the SQL migration mirrors this.
let studentProfileColumnsReady=null;
function ensureStudentProfileColumns(){
  if(!studentProfileColumnsReady) studentProfileColumnsReady=(async()=>{
    const [columns]=await pool.query(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`);
    const have=new Set(columns.map(c=>c.n));
    const wanted=[['country_code','VARCHAR(12) DEFAULT NULL'],['country','VARCHAR(100) DEFAULT NULL'],['state_region','VARCHAR(100) DEFAULT NULL'],['learning_goal','VARCHAR(255) DEFAULT NULL']];
    for(const [name,definition] of wanted) if(!have.has(name)) await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  })().catch(err=>{studentProfileColumnsReady=null;throw err;});
  return studentProfileColumnsReady;
}


// A course has main subtopics, and each main subtopic can organise child subtopics.
// Existing rows remain main subtopics (parent_subtopic_id is NULL).
let subtopicHierarchyReady=null;
function ensureSubtopicHierarchyColumn(){
  if(!subtopicHierarchyReady) subtopicHierarchyReady=(async()=>{
    const [cols]=await pool.query(`SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subtopics'`);
    const have=new Set(cols.map(c=>c.n));
    if(!have.has('parent_subtopic_id')) await pool.query('ALTER TABLE subtopics ADD COLUMN parent_subtopic_id INT NULL AFTER course_id');
    const [indexes]=await pool.query(`SELECT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subtopics' AND INDEX_NAME='idx_subtopics_parent'`);
    if(!indexes.length) await pool.query('CREATE INDEX idx_subtopics_parent ON subtopics (course_id,parent_subtopic_id,display_order,id)');
  })().catch(err=>{subtopicHierarchyReady=null;throw err;});
  return subtopicHierarchyReady;
}
async function validateSubtopicParent(courseId,parentId){
  if(parentId===undefined||parentId===null||parentId==='') return null;
  const id=Number(parentId);if(!Number.isInteger(id)||id<1) throw Object.assign(new Error('Choose a valid main subtopic.'),{status:400});
  const [rows]=await pool.query('SELECT id,course_id,parent_subtopic_id FROM subtopics WHERE id=?',[id]);
  if(!rows.length||Number(rows[0].course_id)!==Number(courseId)||rows[0].parent_subtopic_id!==null) throw Object.assign(new Error('Choose a main subtopic from this course.'),{status:400});
  return id;
}


// Demo access is two main subtopics, including all child subtopics inside those two groups.
function demoVisibleSubtopics(topics,limit){
  const rows=topics||[], roots=rows.filter(t=>t.parent_subtopic_id===null||t.parent_subtopic_id===undefined||t.parent_subtopic_id==='');
  const chosen=new Set(roots.slice(0,Math.max(0,Number(limit)||2)).map(t=>Number(t.id)));
  const hasChild=new Set(rows.filter(t=>t.parent_subtopic_id!==null&&t.parent_subtopic_id!==undefined&&t.parent_subtopic_id!=='').map(t=>Number(t.parent_subtopic_id)));
  return rows.filter(t=>{
    const parent=t.parent_subtopic_id;
    if(parent!==null&&parent!==undefined&&parent!=='') return chosen.has(Number(parent));
    return chosen.has(Number(t.id)) && !hasChild.has(Number(t.id));
  });
}

// A subtopic can hold a playlist of videos and a library of PDF/PPTX documents.
// The legacy video_url/pdf_url columns remain supported for existing courses.
let subtopicResourcesReady=null;
function ensureSubtopicResourcesTable(){
  if(!subtopicResourcesReady) subtopicResourcesReady=pool.query(`CREATE TABLE IF NOT EXISTS subtopic_resources (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subtopic_id INT NOT NULL,
    resource_type VARCHAR(16) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT '',
    file_url TEXT NOT NULL,
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_subtopic_resources (subtopic_id, display_order, id),
    CONSTRAINT fk_subtopic_resources_subtopic FOREIGN KEY (subtopic_id) REFERENCES subtopics(id) ON DELETE CASCADE
  )`).catch(err=>{subtopicResourcesReady=null;throw err;});
  return subtopicResourcesReady;
}
async function addResourcesToSubtopics(topics){
  await ensureSubtopicResourcesTable();
  if(!topics || !topics.length) return topics||[];
  const ids=topics.map(t=>Number(t.id)).filter(Boolean);
  const [rows]=ids.length ? await pool.query('SELECT * FROM subtopic_resources WHERE subtopic_id IN (?) ORDER BY display_order ASC,id ASC',[ids]) : [[]];
  const byId=new Map(); (rows||[]).forEach(row=>{if(!byId.has(Number(row.subtopic_id)))byId.set(Number(row.subtopic_id),[]);byId.get(Number(row.subtopic_id)).push(row);});
  topics.forEach(topic=>{topic.resources=byId.get(Number(topic.id))||[];});
  return topics;
}

function publicUser(user, access) {
  return { id:user.id, full_name:user.full_name, email:user.email, role:user.role, phone:user.phone,
    country_code:user.country_code, country:user.country, state_region:user.state_region, city:user.city,
    department:user.department, institution:user.institution, learning_goal:user.learning_goal, avatar_image:user.avatar_image,
    access_mode:(access && access.access_mode) || 'full', demo_course_id:(access && access.demo_course_id) || null };
}
async function accessForStudent(studentId) {
  await ensureAccessTables();
  const [rows] = await pool.query('SELECT access_mode, demo_course_id, demo_topic_limit FROM student_access WHERE student_id=?', [studentId]);
  return rows[0] || { access_mode:'full', demo_course_id:null, demo_topic_limit:2 };
}
async function permittedCourseIds(auth) {
  if (!auth || auth.role !== 'student') return null;
  const access = await accessForStudent(auth.uid);
  if (access.access_mode === 'demo') return { access, ids:access.demo_course_id ? [Number(access.demo_course_id)] : [] };
  if (access.access_mode === 'batch') {
    const [rows] = await pool.query(`SELECT DISTINCT b.course_id FROM batch_enrollments e
      JOIN batches b ON b.id=e.batch_id WHERE e.student_id=? AND e.status='active' AND b.status='active'`, [auth.uid]);
    return { access, ids:rows.map(r=>Number(r.course_id)) };
  }
  return { access, ids:null };
}
async function mayStudy(auth, courseName, moduleIndex) {
  if (!auth || auth.role !== 'student') return true;
  const permitted = await permittedCourseIds(auth);
  if (permitted.ids === null) return true;
  const [rows] = await pool.query('SELECT id FROM courses WHERE title=? LIMIT 1', [courseName]);
  if (!rows.length || !permitted.ids.includes(Number(rows[0].id))) return false;
  if(permitted.access.access_mode!=='demo') return true;
  await ensureSubtopicHierarchyColumn();
  const [topics]=await pool.query('SELECT id,parent_subtopic_id,display_order FROM subtopics WHERE course_id=? ORDER BY display_order ASC,id ASC',[rows[0].id]);
  return Number(moduleIndex)>=0 && Number(moduleIndex)<demoVisibleSubtopics(topics,permitted.access.demo_topic_limit).length;
}
function inviteCode() { return 'SM-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
async function ownBatchOrAdmin(auth, batchId) {
  const [rows] = await pool.query('SELECT * FROM batches WHERE id=?', [batchId]);
  const batch=rows[0];
  if (!batch) return null;
  if (auth.role !== 'admin' && Number(batch.trainer_id) !== Number(auth.uid)) return false;
  return batch;
}

// =============================================================
// CORS Headers
// =============================================================
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
  const cid = claimedId(req);
  // a learner may always act on their own /users/<id> row (profile, avatar, password, closing their account)
  const selfRow = /^\/users\/\d+$/.test(p) && cid === a.uid;
  if (ADMIN.some(r => r[0].test(req.method) && r[1].test(p)) && a.role !== 'admin' && !selfRow)
    return res.status(403).json({ error: 'Admin access required.', code: 'admin_required' });
  if ((/^\/(trainer|batches)(?:\/|$)/.test(p)) && !['trainer','admin'].includes(a.role) && p !== '/batches/join')
    return res.status(403).json({ error: 'Trainer or admin access required.', code: 'trainer_required' });
  if (SCOPED.some(re => re.test(p)) && !selfRow) {
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
// .php ROUTE ALIASES (for frontend compatibility)
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
    const [rows] = await pool.query('SELECT NOW() as time');
    let userCount = 'N/A';
    try {
      const [result] = await pool.query('SELECT COUNT(*) as count FROM users');
      userCount = result[0].count;
    } catch (e) { userCount = 'table_missing'; }
    
    let courseCount = 'N/A';
    try {
      const [result] = await pool.query('SELECT COUNT(*) as count FROM courses');
      courseCount = result[0].count;
    } catch (e) { courseCount = 'table_missing'; }

    if (!authFrom(req) && process.env.HEALTH_VERBOSE !== '1') delete rows[0].time;
    res.json({
      status: 'ok',
      time: rows[0].time,
      user_count: userCount,
      course_count: courseCount,
      message: courseCount === 'table_missing' ? 'Run MYSQL_MIGRATION.sql in phpMyAdmin!' : 'All tables exist'
    });
  } catch (e) {
    console.error('[Health Check Failed]', e);
    const verbose = !!authFrom(req) || process.env.HEALTH_VERBOSE === '1';
    let hint;
    if (DB_MISSING.length) {
      hint = `Database settings are not loaded by the Node app — missing: ${DB_MISSING.join(', ')} (DB_PASS optional). Fix: hPanel → Websites → Node.js configuration → Environment Variables, add them, press SAVE, then RESTART APP (a redeploy is not needed). Or create a file named exactly .env next to server.js with one KEY=value per line. Note: .env and .env* are gitignored, so a .env committed to GitHub will never reach the server.`;
    } else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/.test(e.message || '')) {
      hint = `Reached the database host but the connection failed. Expected target: ${DB_CFG.user}@${DB_CFG.host}:${DB_CFG.port}/${DB_CFG.database}. On Hostinger DB_HOST must be 127.0.0.1 (not localhost) and the MySQL user must be granted that database in hPanel → MySQL.`;
    } else {
      hint = `Connecting as ${DB_CFG.user || 'root'}@${DB_CFG.host || 'localhost'} to database ${DB_CFG.database || '(none)'}. ${e.message}`;
    }
    res.status(500).json({
      status: 'error',
      ...(verbose ? { error: e.message || e.sqlMessage || String(e) } : {}),
      ...(verbose ? {
        db_target: `${DB_CFG.user || 'root'}@${DB_CFG.host || 'localhost'}:${DB_CFG.port}/${DB_CFG.database || '(none)'}`,
        missing_env: DB_MISSING,
        hint
      } : { hint: 'Database settings are not loaded by this app. On the hosting panel add DB_HOST, DB_NAME, DB_USER, DB_PASS to Environment Variables, Save, then Restart App. Set HEALTH_VERBOSE=1 temporarily for the full diagnostic.' })
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
    const [rows] = await pool.query('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// sign-in throttling: 8 tries per 10 minutes per email+IP
const TRY_WINDOW = 10 * 60e3, TRY_MAX = 8;
const tries = new Map();
function throttled(key) {
  const now = Date.now();
  const list = (tries.get(key) || []).filter(t => now - t < TRY_WINDOW);
  tries.set(key, list);
  return list.length >= TRY_MAX;
}
function noteTry(key) {
  const now = Date.now();
  const list = (tries.get(key) || []).filter(t => now - t < TRY_WINDOW);
  list.push(now);
  tries.set(key, list);
  if (tries.size > 20000) tries.clear();
}
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
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }
    tries.delete(tkey);
    const token = signToken(user);
    const access = user.role === 'student' ? await accessForStudent(user.id) : { access_mode:'full' };

    res.json(Object.assign({ token, token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString() }, publicUser(user, access)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Public registration is intentionally student-only. It can never accept a role from the browser.
app.post('/api/signup', async (req, res) => {
  const full_name=String((req.body||{}).full_name||'').trim();
  const email=String((req.body||{}).email||'').trim().toLowerCase();
  const password=String((req.body||{}).password||'');
  const country_code=String((req.body||{}).country_code||'').trim();
  const phone=String((req.body||{}).phone||'').trim();
  const country=String((req.body||{}).country||'').trim();
  const city=String((req.body||{}).city||'').trim();
  const state_region=String((req.body||{}).state_region||'').trim();
  const department=String((req.body||{}).department||'').trim();
  const institution=String((req.body||{}).institution||'').trim();
  const learning_goal=String((req.body||{}).learning_goal||'').trim();
  const invite_code=String((req.body||{}).invite_code||'').trim().toUpperCase();
  if (full_name.length < 2 || full_name.length > 120) return res.status(400).json({ error:'Enter your full name (2–120 characters).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error:'Enter a valid email address.' });
  if (!/^\+\d{1,4}$/.test(country_code) || !/^[0-9() .-]{6,20}$/.test(phone)) return res.status(400).json({ error:'Enter a valid mobile number with a country code.' });
  if (!country || country.length>100 || !city || city.length>100 || state_region.length>100 || department.length>150 || institution.length>255 || learning_goal.length>255) return res.status(400).json({ error:'Check your country, city and profile details.' });
  const pwErr=passwordProblem(password); if (pwErr) return res.status(400).json({ error:pwErr });
  try {
    await Promise.all([ensureAccessTables(),ensureStudentProfileColumns()]);
    const password_hash=await bcrypt.hash(password, 10);
    const [created]=await pool.query(`INSERT INTO users (full_name,email,password_hash,role,phone,country_code,country,city,state_region,department,institution,learning_goal)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[full_name,email,password_hash,'student',country_code+' '+phone,country_code,country,city,state_region||null,department||null,institution||null,learning_goal||null]);
    const student_id=created.insertId;
    let access={access_mode:'demo',demo_course_id:null,demo_topic_limit:2}, joinedBatch=null;
    if(invite_code){
      const [batches]=await pool.query("SELECT * FROM batches WHERE invite_code=? AND status='active'",[invite_code]);
      if(!batches.length) { await pool.query('DELETE FROM users WHERE id=?',[student_id]); return res.status(400).json({error:'That batch code is not active. You can leave it blank to start the demo.'}); }
      joinedBatch=batches[0];
      await pool.query("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active')",[joinedBatch.id,student_id]);
      access={access_mode:'batch',demo_course_id:null,demo_topic_limit:2};
    } else {
      const [courses]=await pool.query("SELECT id FROM courses WHERE status='active' ORDER BY display_order ASC,id ASC LIMIT 1");
      access.demo_course_id=courses.length?courses[0].id:null;
    }
    await pool.query(`INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE access_mode=VALUES(access_mode),demo_course_id=VALUES(demo_course_id),demo_topic_limit=VALUES(demo_topic_limit)`,
      [student_id,access.access_mode,access.demo_course_id,2]);
    const user={id:student_id,full_name,email,role:'student',phone:country_code+' '+phone,country_code,country,city,state_region,department,institution,learning_goal};
    res.status(201).json(Object.assign({token:signToken(user), token_expires_at:new Date(Date.now()+TOKEN_TTL_MS).toISOString(), joined_batch:joinedBatch?{id:joinedBatch.id,name:joinedBatch.name}:null},publicUser(user,access)));
  } catch(err) {
    if(err.code==='ER_DUP_ENTRY') return res.status(409).json({error:'An account already exists for this email. Please sign in instead.'});
    console.error('signup failed:',err); res.status(500).json({error:'Could not create your account. Please try again.'});
  }
});

app.post('/api/users', async (req, res) => {
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  const safeRole=['student','trainer','admin'].includes(role) ? role : 'student';
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [full_name, email, password_hash, safeRole]
    );
    if(safeRole==='student') { await ensureAccessTables(); await pool.query("INSERT INTO student_access (student_id,access_mode) VALUES (?,'full')", [result.insertId]); }
    const [user] = await pool.query('SELECT id, full_name, email, role, created_at FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json(user[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/users/:id/profile', async (req, res) => {
  const { full_name, email, phone, department, institution, city, avatar_image } = req.body;
  try {
    await pool.query(
      'UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), phone = ?, department = ?, institution = ?, city = ?, avatar_image = COALESCE(?, avatar_image) WHERE id = ?',
      [full_name, email, phone, department, institution, city, avatar_image, req.params.id]
    );
    const [user] = await pool.query('SELECT id, full_name, email, role, phone, country_code, country, state_region, department, institution, city, learning_goal, avatar_image, created_at FROM users WHERE id = ?', [req.params.id]);
    if (user.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(user[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already in use' });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.put('/api/users/:id/avatar', async (req, res) => {
  try {
    await pool.query('UPDATE users SET avatar_image = ? WHERE id = ?', [req.body.avatar_image, req.params.id]);
    const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (user.length === 0) return res.status(404).json({ error: 'User not found' });
    delete user[0].password_hash;
    res.json(user[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

app.delete('/api/users/:id/avatar', async (req, res) => {
  try {
    await pool.query('UPDATE users SET avatar_image = NULL WHERE id = ?', [req.params.id]);
    const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    delete user[0].password_hash;
    res.json(user[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

app.put('/api/users/:id/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const npwErr = passwordProblem(new_password);
  if (npwErr) return res.status(400).json({ error: npwErr });
  try {
    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    
    const new_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [new_hash, req.params.id]);
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ deleted: true, id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// =============================================================
// COURSES
// =============================================================

app.get('/api/courses', async (req, res) => {
  try {
    await ensureSubtopicHierarchyColumn();
    // A signed demo/batch student receives only server-authorised courses and topics.
    const permitted=await permittedCourseIds(req.auth);
    if(permitted && permitted.ids.length===0) return res.json([]);
    let sql="SELECT * FROM courses WHERE status='active'"; const args=[];
    if(permitted && permitted.ids!==null){ sql+=' AND id IN (?)'; args.push(permitted.ids); }
    sql+=' ORDER BY display_order ASC,id ASC';
    const [courses]=await pool.query(sql,args);
    if(courses.length){
      const ids=courses.map(c=>c.id);
      const [allTopics]=await pool.query('SELECT * FROM subtopics WHERE course_id IN (?) ORDER BY display_order ASC,id ASC',[ids]);
      await addResourcesToSubtopics(allTopics);
      const byCourse=new Map(); allTopics.forEach(topic=>{ if(!byCourse.has(topic.course_id)) byCourse.set(topic.course_id,[]); byCourse.get(topic.course_id).push(topic); });
      courses.forEach(course=>{
        let topics=byCourse.get(course.id)||[];
        if(permitted && permitted.access.access_mode==='demo' && Number(course.id)===Number(permitted.access.demo_course_id)) topics=demoVisibleSubtopics(topics,permitted.access.demo_topic_limit);
        course.subtopics=topics;
      });
    }
    res.json(courses);
  } catch(err){
    if(err.code==='ER_NO_SUCH_TABLE') return res.json([]);
    console.error(err); res.status(500).json({error:'Failed to fetch courses',detail:err.message});
  }
});

app.get('/api/courses/:id', async (req,res)=>{
  try{
    await ensureSubtopicHierarchyColumn();
    const permitted=await permittedCourseIds(req.auth);
    if(permitted && permitted.ids!==null && !permitted.ids.includes(Number(req.params.id))) return res.status(403).json({error:'This course is not included in your current access.',code:'course_locked'});
    const [courses]=await pool.query('SELECT * FROM courses WHERE id=?',[req.params.id]);
    if(!courses.length) return res.status(404).json({error:'Course not found'});
    const [topics]=await pool.query('SELECT * FROM subtopics WHERE course_id=? ORDER BY display_order ASC,id ASC',[req.params.id]);
    await addResourcesToSubtopics(topics);
    courses[0].subtopics=(permitted && permitted.access.access_mode==='demo') ? demoVisibleSubtopics(topics,permitted.access.demo_topic_limit) : topics;
    res.json(courses[0]);
  }catch(err){res.status(500).json({error:'Failed to fetch course'});}
});

app.post('/api/courses', async (req, res) => {
  const { title, slug, tag, short_description, description, duration_hours, level, image, display_order } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const courseSlug = slug || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  try {
    const [result] = await pool.query(
      'INSERT INTO courses (title, slug, tag, short_description, description, duration_hours, level, image, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, courseSlug, tag || 'Course', short_description || '', description || '', duration_hours || 10, level || 'Beginner', image || '', display_order || 0]
    );
    const [course] = await pool.query('SELECT * FROM courses WHERE id = ?', [result.insertId]);
    course[0].subtopics = [];
    res.status(201).json(course[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Slug already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create course' });
  }
});

app.put('/api/courses/:id', async (req, res) => {
  const { title, slug, tag, short_description, description, duration_hours, level, image, status, display_order } = req.body;
  try {
    await pool.query(
      'UPDATE courses SET title = COALESCE(?, title), slug = COALESCE(?, slug), tag = COALESCE(?, tag), short_description = COALESCE(?, short_description), description = COALESCE(?, description), duration_hours = COALESCE(?, duration_hours), level = COALESCE(?, level), image = COALESCE(?, image), status = COALESCE(?, status), display_order = COALESCE(?, display_order), updated_at = NOW() WHERE id = ?',
      [title, slug, tag, short_description, description, duration_hours, level, image, status, display_order, req.params.id]
    );
    const [course] = await pool.query('SELECT * FROM courses WHERE id = ?', [req.params.id]);
    if (course.length === 0) return res.status(404).json({ error: 'Course not found' });
    res.json(course[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update course' });
  }
});

app.delete('/api/courses/:id', async (req, res) => {
  try {
    const [course] = await pool.query('SELECT id, title FROM courses WHERE id = ?', [req.params.id]);
    if (course.length === 0) return res.status(404).json({ error: 'Course not found' });
    await pool.query('DELETE FROM courses WHERE id = ?', [req.params.id]);
    res.json({ deleted: true, course: course[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete course' });
  }
});


// =============================================================
// TRAINER BATCHES & ENROLMENT
// =============================================================
async function batchRowsFor(auth) {
  await ensureAccessTables();
  const own=auth.role==='trainer';
  const where=own ? 'WHERE b.trainer_id=?' : '';
  const args=own?[auth.uid]:[];
  const [rows]=await pool.query(`SELECT b.*, c.title AS course_title, c.tag AS course_tag,
      u.full_name AS trainer_name, COUNT(DISTINCT e.student_id) AS enrolled_count,
      COALESCE(ROUND(AVG(CASE WHEN topics.topic_count>0 THEN COALESCE(done.done_count,0)*100/topics.topic_count ELSE 0 END)),0) AS average_progress
    FROM batches b JOIN courses c ON c.id=b.course_id JOIN users u ON u.id=b.trainer_id
    LEFT JOIN batch_enrollments e ON e.batch_id=b.id AND e.status='active'
    LEFT JOIN (SELECT course_id,COUNT(*) AS topic_count FROM subtopics GROUP BY course_id) topics ON topics.course_id=c.id
    LEFT JOIN (SELECT lp.student_id,lp.course_name,COUNT(DISTINCT lp.module_index) AS done_count FROM lesson_progress lp GROUP BY lp.student_id,lp.course_name) done ON done.student_id=e.student_id AND done.course_name=c.title
    ${where} GROUP BY b.id ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END,b.created_at DESC`,args);
  return rows.map(r=>Object.assign(r,{enrolled_count:Number(r.enrolled_count)||0,average_progress:Number(r.average_progress)||0}));
}
app.get('/api/trainer/dashboard', async (req,res)=>{
  try{
    const batches=await batchRowsFor(req.auth);
    const students=batches.reduce((sum,b)=>sum+b.enrolled_count,0);
    const avg=batches.length?Math.round(batches.reduce((sum,b)=>sum+b.average_progress,0)/batches.length):0;
    res.json({mode:req.auth.role==='admin'?'oversight':'trainer',batches,summary:{batches:batches.length,students,average_progress:avg}});
  }catch(err){console.error('trainer dashboard:',err);res.status(500).json({error:'Could not load trainer dashboard'});}
});
app.get('/api/trainer/trainers', async (req,res)=>{
  if(req.auth.role!=='admin') return res.status(403).json({error:'Admin access required.',code:'admin_required'});
  try{ await ensureAccessTables(); const [rows]=await pool.query("SELECT id,full_name,email FROM users WHERE role='trainer' ORDER BY full_name");res.json(rows); }
  catch(err){res.status(500).json({error:'Could not load trainers'});}
});
app.get('/api/batches', async (req,res)=>{
  try{res.json(await batchRowsFor(req.auth));}catch(err){res.status(500).json({error:'Could not load batches'});}
});
app.post('/api/batches', async (req,res)=>{
  const b=req.body||{}, name=String(b.name||'').trim(), courseId=Number(b.course_id), startDate=b.start_date||null,endDate=b.end_date||null;
  if(name.length<2||name.length>255||!courseId) return res.status(400).json({error:'Give the batch a name and choose a course.'});
  let trainerId=req.auth.uid;
  if(req.auth.role==='admin') trainerId=Number(b.trainer_id);
  if(!trainerId) return res.status(400).json({error:'Choose the trainer who owns this batch.'});
  try{
    await ensureAccessTables();
    const [[trainer],[course]] = await Promise.all([
      pool.query("SELECT id FROM users WHERE id=? AND role='trainer'",[trainerId]), pool.query("SELECT id FROM courses WHERE id=? AND status='active'",[courseId])
    ]);
    if(!trainer.length) return res.status(400).json({error:'Choose a valid trainer account.'});
    if(!course.length) return res.status(400).json({error:'Choose an active course.'});
    let code=inviteCode();
    for(let i=0;i<4;i++){ const [taken]=await pool.query('SELECT id FROM batches WHERE invite_code=?',[code]); if(!taken.length) break; code=inviteCode(); }
    const [created]=await pool.query('INSERT INTO batches (name,course_id,trainer_id,invite_code,start_date,end_date) VALUES (?,?,?,?,?,?)',[name,courseId,trainerId,code,startDate,endDate]);
    const [rows]=await pool.query('SELECT * FROM batches WHERE id=?',[created.insertId]); res.status(201).json(rows[0]);
  }catch(err){console.error('batch create:',err);res.status(500).json({error:'Could not create batch'});}
});
app.get('/api/batches/:id/students', async (req,res)=>{
  try{
    await ensureAccessTables(); const batch=await ownBatchOrAdmin(req.auth,Number(req.params.id));
    if(batch===false) return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'}); if(!batch) return res.status(404).json({error:'Batch not found'});
    const [[course],[topicRows]] = await Promise.all([pool.query('SELECT title FROM courses WHERE id=?',[batch.course_id]),pool.query('SELECT COUNT(*) AS total FROM subtopics WHERE course_id=?',[batch.course_id])]);
    const [students]=await pool.query(`SELECT u.id,u.full_name,u.email,e.enrolled_at,e.status,COUNT(DISTINCT lp.module_index) AS completed_topics
      FROM batch_enrollments e JOIN users u ON u.id=e.student_id LEFT JOIN lesson_progress lp ON lp.student_id=u.id AND lp.course_name=?
      WHERE e.batch_id=? GROUP BY u.id,e.id ORDER BY u.full_name`,[course[0]&&course[0].title||'',batch.id]);
    const total=Number(topicRows[0].total)||0;
    res.json({batch,course_title:course[0]&&course[0].title||'',topic_count:total,students:students.map(x=>Object.assign(x,{completed_topics:Number(x.completed_topics)||0,progress:total?Math.min(100,Math.round((Number(x.completed_topics)||0)*100/total)):0}))});
  }catch(err){console.error('batch students:',err);res.status(500).json({error:'Could not load batch students'});}
});
app.post('/api/batches/:id/enrollments', async (req,res)=>{
  const email=String((req.body||{}).student_email||'').trim().toLowerCase();
  if(!email) return res.status(400).json({error:'Enter the student email address.'});
  try{
    await ensureAccessTables();const batch=await ownBatchOrAdmin(req.auth,Number(req.params.id));
    if(batch===false) return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'});if(!batch) return res.status(404).json({error:'Batch not found'});
    const [users]=await pool.query("SELECT id,full_name,email FROM users WHERE email=? AND role='student'",[email]);
    if(!users.length) return res.status(404).json({error:'No student account exists for that email. Ask them to create their demo account first.'});
    const student=users[0];
    await pool.query("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active') ON DUPLICATE KEY UPDATE status='active'",[batch.id,student.id]);
    await pool.query("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'batch',NULL,2) ON DUPLICATE KEY UPDATE access_mode='batch'",[student.id]);
    res.status(201).json({enrolled:true,student});
  }catch(err){console.error('enrol student:',err);res.status(500).json({error:'Could not enrol that student'});}
});
app.delete('/api/batches/:id/enrollments/:studentId', async (req,res)=>{
  try{
    await ensureAccessTables();const batch=await ownBatchOrAdmin(req.auth,Number(req.params.id));
    if(batch===false) return res.status(403).json({error:'This batch belongs to another trainer.',code:'batch_forbidden'});if(!batch)return res.status(404).json({error:'Batch not found'});
    const studentId=Number(req.params.studentId);await pool.query('DELETE FROM batch_enrollments WHERE batch_id=? AND student_id=?',[batch.id,studentId]);
    const [still]=await pool.query("SELECT 1 FROM batch_enrollments WHERE student_id=? AND status='active' LIMIT 1",[studentId]);
    if(!still.length){const [first]=await pool.query("SELECT id FROM courses WHERE status='active' ORDER BY display_order,id LIMIT 1");await pool.query("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'demo',?,2) ON DUPLICATE KEY UPDATE access_mode='demo',demo_course_id=VALUES(demo_course_id)",[studentId,first.length?first[0].id:null]);}
    res.json({removed:true});
  }catch(err){res.status(500).json({error:'Could not remove student from batch'});}
});
// A student may self-enrol using a trainer's current invite code. The access change is server-owned.
app.post('/api/batches/join', async (req,res)=>{
  const code=String((req.body||{}).invite_code||'').trim().toUpperCase();
  if(req.auth.role!=='student') return res.status(403).json({error:'Only student accounts can join a batch.'}); if(!code) return res.status(400).json({error:'Enter a batch code.'});
  try{await ensureAccessTables();const [batches]=await pool.query("SELECT id,name,course_id FROM batches WHERE invite_code=? AND status='active'",[code]);if(!batches.length)return res.status(404).json({error:'That batch code is invalid or no longer active.'});const batch=batches[0];
    await pool.query("INSERT INTO batch_enrollments (batch_id,student_id,status) VALUES (?,?,'active') ON DUPLICATE KEY UPDATE status='active'",[batch.id,req.auth.uid]);
    await pool.query("INSERT INTO student_access (student_id,access_mode,demo_course_id,demo_topic_limit) VALUES (?,'batch',NULL,2) ON DUPLICATE KEY UPDATE access_mode='batch'",[req.auth.uid]);res.json({joined:true,batch:{id:batch.id,name:batch.name}});
  }catch(err){res.status(500).json({error:'Could not join this batch'});}
});

// =============================================================
// SUBTOPICS
// =============================================================

app.post('/api/courses/:id/subtopics', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order, parent_subtopic_id } = req.body;
  if (!title) return res.status(400).json({error: 'title is required'});
  try {
    await ensureSubtopicHierarchyColumn();
    const parentId=await validateSubtopicParent(req.params.id,parent_subtopic_id);
    const [result] = await pool.query(
      'INSERT INTO subtopics (course_id, parent_subtopic_id, title, slug, dur, description, video_url, pdf_url, exercise, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id,parentId,title,slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),dur || '15 min',description || '',video_url || '',pdf_url || '',exercise || '',display_order || 0]
    );
    const [sub] = await pool.query('SELECT * FROM subtopics WHERE id = ?', [result.insertId]);
    res.status(201).json(sub[0]);
  } catch (err) {
    res.status(err.status||500).json({ error: err.status ? err.message : 'Failed to create subtopic' });
  }
});

app.put('/api/subtopics/:id', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order, parent_subtopic_id } = req.body;
  try {
    await ensureSubtopicHierarchyColumn();
    const [old]=await pool.query('SELECT * FROM subtopics WHERE id=?',[req.params.id]);
    if(!old.length) return res.status(404).json({ error: 'Subtopic not found' });
    const parentId=parent_subtopic_id===undefined?undefined:await validateSubtopicParent(old[0].course_id,parent_subtopic_id);
    if(parentId&&Number(parentId)===Number(req.params.id)) return res.status(400).json({error:'A subtopic cannot be its own parent.'});
    await pool.query(
      'UPDATE subtopics SET title = COALESCE(?, title), slug = COALESCE(?, slug), dur = COALESCE(?, dur), description = COALESCE(?, description), video_url = COALESCE(?, video_url), pdf_url = COALESCE(?, pdf_url), exercise = COALESCE(?, exercise), display_order = COALESCE(?, display_order), parent_subtopic_id = COALESCE(?, parent_subtopic_id), updated_at = NOW() WHERE id = ?',
      [title,slug,dur,description,video_url,pdf_url,exercise,display_order,parentId===undefined?null:parentId,req.params.id]
    );
    const [sub] = await pool.query('SELECT * FROM subtopics WHERE id = ?', [req.params.id]);
    res.json(sub[0]);
  } catch (err) {
    res.status(err.status||500).json({ error: err.status ? err.message : 'Failed to update subtopic' });
  }
});

app.delete('/api/subtopics/:id', async (req, res) => {
  try {
    await ensureSubtopicHierarchyColumn();
    const [sub] = await pool.query('SELECT id, title FROM subtopics WHERE id = ?', [req.params.id]);
    if (sub.length === 0) return res.status(404).json({ error: 'Subtopic not found' });
    const [children]=await pool.query('SELECT id FROM subtopics WHERE parent_subtopic_id=?',[req.params.id]);
    if(children.length) await pool.query('DELETE FROM subtopics WHERE parent_subtopic_id=?',[req.params.id]);
    await pool.query('DELETE FROM subtopics WHERE id = ?', [req.params.id]);
    res.json({ deleted: true, subtopic: sub[0], deleted_children:children.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subtopic' });
  }
});

// =============================================================
// SUBTOPIC RESOURCE PLAYLISTS — multiple videos and PDF/PPTX per subtopic
// =============================================================
function resourceType(body){
  const t=String((body||{}).resource_type||'').trim().toLowerCase();
  return t==='video'||t==='document'?t:'';
}
function resourceFile(body){ return String((body||{}).file_url||'').trim(); }
function resourceTitle(body,file){ return String((body||{}).title||'').trim().slice(0,255) || path.basename(String(file||'').split(/[?#]/)[0]) || 'Learning material'; }
function isSupportedDocument(file){ return /\.(pdf|pptx)(?:[?#].*)?$/i.test(String(file||'')); }
app.get('/api/subtopics/:id/resources', async (req,res)=>{
  try{await ensureSubtopicResourcesTable();const [rows]=await pool.query('SELECT * FROM subtopic_resources WHERE subtopic_id=? ORDER BY display_order ASC,id ASC',[req.params.id]);res.json(rows);}
  catch(err){res.status(500).json({error:'Failed to fetch subtopic resources'});}
});
app.post('/api/subtopics/:id/resources', async (req,res)=>{
  const type=resourceType(req.body),file=resourceFile(req.body);
  if(!type||!file) return res.status(400).json({error:'A resource type and file URL are required.'});
  if(type==='document'&&!isSupportedDocument(file)) return res.status(400).json({error:'Documents must be PDF or PPTX files.'});
  try{await ensureSubtopicResourcesTable();const [topic]=await pool.query('SELECT id FROM subtopics WHERE id=?',[req.params.id]);if(!topic.length)return res.status(404).json({error:'Subtopic not found'});
    const order=Math.max(0,Number(req.body.display_order)||0),title=resourceTitle(req.body,file);
    const [created]=await pool.query('INSERT INTO subtopic_resources (subtopic_id,resource_type,title,file_url,display_order) VALUES (?,?,?,?,?)',[req.params.id,type,title,file,order]);
    const [rows]=await pool.query('SELECT * FROM subtopic_resources WHERE id=?',[created.insertId]);res.status(201).json(rows[0]);
  }catch(err){console.error('resource create:',err);res.status(500).json({error:'Failed to add learning material'});}
});
app.put('/api/subtopic-resources/:id', async (req,res)=>{
  const body=req.body||{},file=body.file_url===undefined?null:resourceFile(body);
  if(file!==null&&!file) return res.status(400).json({error:'File URL cannot be empty.'});
  if(file!==null&&body.resource_type==='document'&&!isSupportedDocument(file)) return res.status(400).json({error:'Documents must be PDF or PPTX files.'});
  try{await ensureSubtopicResourcesTable();await pool.query('UPDATE subtopic_resources SET title=COALESCE(?,title),file_url=COALESCE(?,file_url),display_order=COALESCE(?,display_order),updated_at=NOW() WHERE id=?',[body.title===undefined?null:String(body.title).trim().slice(0,255),file,body.display_order===undefined?null:Math.max(0,Number(body.display_order)||0),req.params.id]);const [rows]=await pool.query('SELECT * FROM subtopic_resources WHERE id=?',[req.params.id]);if(!rows.length)return res.status(404).json({error:'Learning material not found'});res.json(rows[0]);}
  catch(err){res.status(500).json({error:'Failed to update learning material'});}
});
app.delete('/api/subtopic-resources/:id', async (req,res)=>{
  try{await ensureSubtopicResourcesTable();const [result]=await pool.query('DELETE FROM subtopic_resources WHERE id=?',[req.params.id]);if(!result.affectedRows)return res.status(404).json({error:'Learning material not found'});res.json({deleted:true,id:Number(req.params.id)});}
  catch(err){res.status(500).json({error:'Failed to delete learning material'});}
});

// =============================================================
// QUIZZES
// =============================================================

// quizzes used to be course-wide only; these columns attach one quiz to ONE subtopic
async function ensureQuizColumns() {
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quizzes'`);
    const have = new Set(cols.map(c => c.n || c.N));
    const needed = [['course_id', 'INT NULL'], ['module_index', 'INT NULL'], ['pass_pct', "INT NOT NULL DEFAULT 60"]];
    for (const [name, def] of needed) if (!have.has(name)) await pool.query(`ALTER TABLE quizzes ADD COLUMN ${name} ${def}`);
  } catch (e) { console.warn('[DB] quizzes column check skipped:', e.message); }
}

async function quizWhere(req) {
  const w = [], args = [];
  await ensureQuizColumns();
  if (req.query.course_id) { w.push('course_id = ?'); args.push(Number(req.query.course_id)); }
  if (req.query.course_name) { w.push('course_name = ?'); args.push(String(req.query.course_name)); }
  if (req.query.module_index !== undefined && req.query.module_index !== '') { w.push('module_index = ?'); args.push(Number(req.query.module_index)); }
  return { sql: w.length ? ' WHERE ' + w.join(' AND ') : '', args };
}

app.get('/api/quizzes', async (req, res) => {
  try {
    const { sql, args } = await quizWhere(req);
    const [rows] = await pool.query(`SELECT * FROM quizzes${sql} ORDER BY module_index ASC, id ASC`, args);
    const [counts] = await pool.query('SELECT quiz_id, COUNT(*) AS n FROM questions GROUP BY quiz_id').catch(() => [[]]);
    const n = {}; (counts || []).forEach(r => { n[r.quiz_id] = +r.n; });
    rows.forEach(q => {
      q.question_count = n[q.id] || 0;
      if (q.pass_pct == null) q.pass_pct = 60;
      q.bound = (q.module_index === null || q.module_index === undefined) ? 'course' : 'subtopic';
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  try {
    const [found] = await pool.query('SELECT id, title FROM quizzes WHERE id = ?', [req.params.id]);
    if (!found.length) return res.status(404).json({ error: 'Quiz not found' });
    await pool.query('UPDATE student_submissions SET quiz_id = NULL WHERE quiz_id = ?', [req.params.id]);
    await pool.query('DELETE FROM questions WHERE quiz_id = ?', [req.params.id]);
    await pool.query('DELETE FROM quizzes WHERE id = ?', [req.params.id]);
    res.json({ deleted: true, quiz: found[0] });
  } catch (err) { console.error('quiz delete failed:', err); res.status(500).json({ error: 'Failed to delete quiz' }); }
});

app.get('/api/quizzes/:id', async (req, res) => {
  try {
    const [quizzes] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [req.params.id]);
    if (quizzes.length === 0) return res.status(404).json({ error: 'Quiz not found' });
    const [questions] = await pool.query('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]);
    // the answer key stays on the server: students use /quizzes/<id>/paper
    if (!(req.auth && req.auth.role === 'admin')) questions.forEach(x => { delete x.correct_option; });
    quizzes[0].questions = questions;
    res.json(quizzes[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
});

// ---- the quiz editor's single save: title + pass mark + the whole question set ----
function checkQuestions(questions) {
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
async function writeQuizQuestions(quizId, clean) {
  const [have] = await pool.query('SELECT id, question_text FROM questions WHERE quiz_id = ? ORDER BY id ASC', [quizId]);
  const byText = {}; have.forEach(r => { const k = String(r.question_text); if (!(k in byText)) byText[k] = r.id; });
  const keep = [];
  for (const [text, a, b, c, d, correct] of clean) {
    const oldId = byText[text];
    if (oldId) {
      await pool.query('UPDATE questions SET option_a=?, option_b=?, option_c=?, option_d=?, correct_option=? WHERE id=?', [a, b, c, d, correct, oldId]);
      keep.push(oldId);
    } else {
      const [r] = await pool.query('INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [quizId, text, a, b, c, d, correct]);
      keep.push(r.insertId);
    }
  }
  if (keep.length) await pool.query('DELETE FROM questions WHERE quiz_id = ? AND id NOT IN (?)', [quizId, keep]);
  else await pool.query('DELETE FROM questions WHERE quiz_id = ?', [quizId]);
  const [after] = await pool.query('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [quizId]);
  return after;
}

// one save for the whole quiz: the Manage Quizzes editor calls this with every question at once
app.put('/api/quizzes/:id/assessment', async (req, res) => {
  try {
    await ensureQuizColumns();
    const id = Number(req.params.id);
    const [found] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [id]);
    if (!found.length) return res.status(404).json({ error: 'Quiz not found' });
    const body = req.body || {};
    const upd = [], args = [];
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return res.status(400).json({ error: 'Give the quiz a title' });
      upd.push('title = ?'); args.push(t);
    }
    if (body.pass_pct !== undefined) { upd.push('pass_pct = ?'); args.push(Math.max(1, Math.min(100, parseInt(body.pass_pct, 10) || 60))); }
    if (upd.length) { args.push(id); await pool.query('UPDATE quizzes SET ' + upd.join(', ') + ' WHERE id = ?', args); }
    let questions;
    if (Array.isArray(body.questions)) {
      if (!body.questions.length) { await pool.query('DELETE FROM questions WHERE quiz_id = ?', [id]); questions = []; }
      else {
        const v = checkQuestions(body.questions);
        if (v.error) return res.status(400).json({ error: v.error, question: v.question });
        questions = await writeQuizQuestions(id, v.clean);
      }
    } else {
      const [cur] = await pool.query('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [id]);
      questions = cur;
    }
    const [quiz] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [id]);
    res.json({ saved: true, quiz_id: id, quiz: quiz[0], questions });
  } catch (e) { console.error('quiz save failed:', e); res.status(500).json({ error: 'Failed to save quiz' }); }
});

// questions without the answer key — what the student page is allowed to read
app.get('/api/quizzes/:id/paper', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch quiz' }); }
});

app.get('/api/quizzes/:id/questions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

app.post('/api/quizzes', async (req, res) => {
  const { course_name, title, course_id, module_index, pass_pct } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Quiz title is required' });
  const mi = (module_index === null || module_index === undefined || module_index === '') ? null : Number(module_index);
  if (mi !== null && (!isFinite(mi) || mi < 0)) return res.status(400).json({ error: 'module_index must be a non-negative number' });
  const pp = Math.max(1, Math.min(100, parseInt(pass_pct, 10) || 60));
  try {
    await ensureQuizColumns();
    const [result] = await pool.query(
      'INSERT INTO quizzes (course_name, title, course_id, module_index, pass_pct) VALUES (?, ?, ?, ?, ?)',
      [course_name || '', String(title).trim(), course_id ? Number(course_id) : null, mi, pp]);
    const [quiz] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [result.insertId]);
    res.status(201).json(quiz[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

app.post('/api/quizzes/:id/submit', async (req, res) => {
  const { student_id, student_name, quiz_title } = req.body || {};
  const answers = (req.body && req.body.answers) || {};
  try {
    await ensureQuizColumns();
    const [questions] = await pool.query('SELECT id, question_text, correct_option FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]);
    if (questions.length === 0) return res.status(400).json({ error: 'Quiz has no questions' });
    const [qmeta] = await pool.query('SELECT id, title, course_name, course_id, module_index, pass_pct FROM quizzes WHERE id = ?', [req.params.id]);

    let correctCount = 0;
    questions.forEach(q => {
      if (answers[q.id] && answers[q.id].toUpperCase() === q.correct_option.toUpperCase()) correctCount++;
    });
    const score = Math.round((correctCount / questions.length) * 100);

    const [result] = await pool.query(
      'INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score) VALUES (?, ?, ?, ?, ?, ?)',
      [student_id, student_name, req.params.id, quiz_title, JSON.stringify(answers), score]
    );
    const meta = qmeta[0] || {};
    const need = Math.max(1, Math.min(100, parseInt(meta.pass_pct, 10) || 60));
    const review = questions.map(qq => ({ id: qq.id, correct_option: qq.correct_option, chosen: (answers && answers[qq.id] ? String(answers[qq.id]).toUpperCase() : '') }));
    res.json({
      review,
      submission_id: result.insertId, score, passed: score >= need, pass_pct: need,
      correct_count: correctCount, total_count: questions.length,
      quiz_id: meta.id || Number(req.params.id), quiz_title: meta.title || '',
      course_name: meta.course_name || '', course_id: meta.course_id ?? null, module_index: meta.module_index ?? null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM student_submissions ORDER BY submitted_at DESC');
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
    const [rows] = await pool.query('SELECT * FROM lesson_progress WHERE student_id = ? ORDER BY course_name, module_index', [student_id]);
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

app.get('/api/progress/course', async (req, res) => {
  const { student_id, course_name } = req.query;
  try {
    const [rows] = await pool.query('SELECT * FROM lesson_progress WHERE student_id = ? AND course_name = ? ORDER BY module_index', [student_id, course_name]);
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    res.status(500).json({ error: 'Failed to fetch course progress' });
  }
});

app.post('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.body;
  try {
    if(!(await mayStudy(req.auth,course_name,module_index))) return res.status(403).json({error:'This lesson is outside your current course access.',code:'course_locked'});
    await pool.query(
      'INSERT IGNORE INTO lesson_progress (student_id, course_name, module_index) VALUES (?, ?, ?)',
      [student_id, course_name, module_index]
    );
    const [rows] = await pool.query('SELECT * FROM lesson_progress WHERE student_id = ? AND course_name = ? ORDER BY module_index', [student_id, course_name]);
    res.status(201).json({ saved: true, progress: rows });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ error: 'lesson_progress table missing. Run MYSQL_MIGRATION.sql' });
    }
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

app.delete('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.query;
  try {
    if (course_name && module_index !== undefined) {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=? AND course_name=? AND module_index=?', [student_id, course_name, module_index]);
    } else if (course_name) {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=? AND course_name=?', [student_id, course_name]);
    } else {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=?', [student_id]);
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete progress' });
  }
});

// =============================================================
// FILE UPLOAD
// =============================================================

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024; // default 1 GB
const UPLOAD_FOLDERS = { video: 'videos', pdf: 'pdfs', image: 'images' };
const pickFolder = type => UPLOAD_FOLDERS[type] || null;

// Stream uploads straight to disk (no whole-file RAM buffering) —
// this is what makes multi-hundred-MB videos safe on shared hosting.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = pickFolder(req.body && req.body.type);
    if (!folder) return cb(Object.assign(new Error('Choose video, PDF/PPTX, or image before uploading'), { code: 'BAD_TYPE' }));
    const dir = path.join(DATA_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe || 'file'}`);
  }
});
const ALLOW_EXT = {
  videos: ['.mp4', '.webm', '.m4v', '.mov'],
  // Old binary .ppt is deliberately not accepted: it is unreliable in modern embedded viewers.
  // PPTX keeps animations/video in the in-lesson PowerPoint viewer.
  pdfs:   ['.pdf', '.pptx'],
  images: ['.png', '.jpg', '.jpeg', '.webp', '.gif']
};
function uploadTypeOk(folder, file) {
  const name = (file.originalname || '').toLowerCase();
  const ext = path.extname(name);
  if (!folder || !ALLOW_EXT[folder] || !ALLOW_EXT[folder].includes(ext)) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  if (folder === 'videos') return /^video\//.test(mime);
  if (folder === 'images') return /^image\/(png|jpe?g|webp|gif)$/.test(mime);
  // Some browsers label a genuine PPTX as application/octet-stream. The extension is not trusted
  // by itself: uploadDocumentLooksReal() checks its first bytes after it reaches disk.
  return ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream', 'application/zip'].includes(mime);
}
function uploadDocumentLooksReal(filePath, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  let fd, b = Buffer.alloc(8), got = 0;
  try { fd = fs.openSync(filePath, 'r'); got = fs.readSync(fd, b, 0, b.length, 0); } catch (e) { return false; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch (e) {} }
  if (ext === '.pdf') return got >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-';
  if (ext === '.pptx') return got >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08);
  return false;
}
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const folder = pickFolder(req.body && req.body.type);
    if (!uploadTypeOk(folder, file)) return cb(Object.assign(new Error('Only ' + ((folder && ALLOW_EXT[folder]) || ['.mp4', '.pdf', '.pptx', '.png']).join(', ') + ' files can be uploaded here'), { code: 'BAD_TYPE' }));
    cb(null, true);
  }
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      // never leave partial files behind on failed uploads
      try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig
          ? `File is larger than the ${MAX_UPLOAD_MB} MB limit. Tip: compress it (HandBrake) or place it via File Manager in data/videos/, then type the path here.`
          : ('Upload failed: ' + (err.message || 'bad request'))
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const folder = pickFolder(req.body && req.body.type);
    if (!folder) return res.status(400).json({ error: 'Choose video, PDF/PPTX, or image before uploading' });
    if (folder === 'pdfs' && !uploadDocumentLooksReal(req.file.path, req.file.originalname)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'This is not a readable PDF or PPTX file. Export/save it again and upload the .pdf or .pptx file.' });
    }
    const filePath = `${folder}/${req.file.filename}`;
    const url = `${req.protocol}://${req.get('host')}/${filePath}`;
    res.json({ url, path: filePath, size: req.file.size });
  });
});

// =============================================================
// LESSON STEPS — sequential unlock (video → pdf → mcq → ex)
// Enforces the learning order server-side, not just in CSS.
// =============================================================
const STEP_ORDER = ['video', 'pdf', 'mcq', 'ex'];
const STEP_CONFIG_FILE = path.join(DATA_DIR, 'lesson_config.json');

function readStepConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(STEP_CONFIG_FILE, 'utf8')); } catch (e) {}
  const clamp = (v, d) => { v = parseInt(v, 10); return (isFinite(v) && v >= 50 && v <= 100) ? v : d; };
  return { video_req_pct: clamp(c.video_req_pct, 90), pdf_req_pct: clamp(c.pdf_req_pct, 90) };
}

async function ensureStepsTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS lesson_steps (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    student_id    INT NOT NULL,
    course_name   VARCHAR(500) NOT NULL,
    module_index  INT NOT NULL,
    step          VARCHAR(16) NOT NULL,
    pct           INT NOT NULL DEFAULT 100,
    completed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_step (student_id, course_name, module_index, step)
  )`);
}

async function ensureTimeTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS user_time (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    day        DATE NOT NULL,
    seconds    INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_day (student_id, day)
  )`);
}

// ---- Live time tracking: active seconds per student per day (powers dashboard "Hours logged") ----
app.post('/api/time', async (req, res) => {
  try {
    const b = req.body || {};
    const sid = Number(b.student_id);
    let secs = Math.round(Number(b.seconds));
    if (!sid || !isFinite(secs) || secs <= 0) return res.status(400).json({ error: 'student_id and positive seconds required' });
    secs = Math.min(secs, 7200);
    const sql = 'INSERT INTO user_time (student_id, day, seconds) VALUES (?, CURDATE(), ?) ON DUPLICATE KEY UPDATE seconds = seconds + VALUES(seconds)';
    try { await pool.query(sql, [sid, secs]); }
    catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') { await ensureTimeTable(); await pool.query(sql, [sid, secs]); }
      else throw err;
    }
    res.status(201).json({ ok: true, added_seconds: secs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log time' });
  }
});

app.get('/api/time', async (req, res) => {
  const sid = Number(req.query.student_id);
  if (!sid) return res.status(400).json({ error: 'student_id required' });
  try {
    const [agg] = await pool.query(
      `SELECT COALESCE(SUM(seconds),0) AS total_seconds,
              COALESCE(SUM(CASE WHEN day >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) THEN seconds ELSE 0 END),0) AS week_seconds
       FROM user_time WHERE student_id = ?`, [sid]);
    const [days] = await pool.query(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d FROM user_time
       WHERE student_id = ? AND seconds > 0 ORDER BY day DESC LIMIT 40`, [sid]);
    let streak = 0;
    if (days.length) {
      const today = new Date(); today.setHours(12, 0, 0, 0);
      let expect = today.getTime();
      const first = new Date(days[0].d + 'T12:00:00').getTime();
      if (first === expect - 86400000) expect = first; // no time logged yet today: yesterday starts a valid streak
      for (const r of days) {
        const d = new Date(r.d + 'T12:00:00').getTime();
        if (d === expect) { streak++; expect -= 86400000; }
        else if (d < expect) break;
      }
    }
    res.json({
      total_seconds: Number(agg[0] && agg[0].total_seconds) || 0,
      week_seconds: Number(agg[0] && agg[0].week_seconds) || 0,
      streak_days: streak,
      recent_days: days.slice(0, 7).map(r => r.d)
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ total_seconds: 0, week_seconds: 0, streak_days: 0, recent_days: [] });
    console.error(err);
    res.status(500).json({ error: 'Failed to read time' });
  }
});

// =============================================================
// ADMIN ANALYTICS — learner intelligence for the training team.
// All rollups are computed server-side; missing tables degrade to zeros.
// =============================================================
async function qa(sql, args) {
  try { const [rows] = await pool.query(sql, args || []); return rows; }
  catch (e) { if (e && e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
}

app.get('/api/analytics/summary', async (req, res) => {
  try {
    const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
    const R = await Promise.all([
      qa(`SELECT id, full_name, email, created_at FROM users WHERE role = 'student' ORDER BY created_at DESC`),
      qa(`SELECT student_id,
                 COALESCE(SUM(seconds),0) AS total_s,
                 MAX(day) AS last_day,
                 COALESCE(SUM(CASE WHEN day >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) THEN seconds ELSE 0 END),0) AS week_s
          FROM user_time GROUP BY student_id`),
      qa(`SELECT student_id, course_name, COUNT(DISTINCT module_index) AS done
          FROM lesson_progress GROUP BY student_id, course_name`),
      qa(`SELECT course_name, module_index, step, COUNT(DISTINCT student_id) AS cnt
          FROM lesson_steps GROUP BY course_name, module_index, step`),
      qa(`SELECT course_name, COUNT(DISTINCT student_id) AS enrolled
          FROM lesson_steps GROUP BY course_name`),
      qa(`SELECT course_name, step, COUNT(DISTINCT student_id) AS students
          FROM lesson_steps GROUP BY course_name, step`),
      qa(`SELECT student_id, course_name, COUNT(DISTINCT module_index) AS touched, MAX(module_index) AS furthest
          FROM lesson_steps GROUP BY student_id, course_name`),
      qa(`SELECT c.id, c.title,
                 (SELECT COUNT(*) FROM subtopics s WHERE s.course_id = c.id) AS subtopic_count
          FROM courses c WHERE c.status = 'active' ORDER BY c.display_order ASC, c.id ASC`),
      qa(`SELECT student_id, AVG(score) AS avg_score, COUNT(*) AS attempts
          FROM student_submissions GROUP BY student_id`),
      qa(`SELECT COUNT(*) AS n, COALESCE(AVG(score),0) AS avg_score FROM student_submissions`),
      qa(`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, COUNT(DISTINCT student_id) AS active_students, SUM(seconds) AS seconds
          FROM user_time WHERE day >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY) GROUP BY d ORDER BY d ASC`),
      qa(`SELECT student_id, DATE_FORMAT(day, '%Y-%m-%d') AS d
          FROM user_time WHERE seconds > 0 AND day >= DATE_SUB(CURDATE(), INTERVAL 45 DAY)
          ORDER BY student_id ASC, day DESC LIMIT 20000`)
    ]);
    const [studentsRaw, timeRaw, progRaw, stepsRaw, enrollRaw, courseStepRaw, touchedRaw, coursesRaw, quizByStRaw, quizAllRaw, seriesRaw, streakRaw] = R;

    const dstr = (x) => { if (!x) return null; const t = typeof x; if (t === 'string') return x.slice(0, 10); if (x instanceof Date || t === 'object') { try { return new Date(x).toISOString().slice(0, 10); } catch (e) { return String(x).slice(0, 10); } } return String(x).slice(0, 10); };
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const DAY = 864e5;

    // per-student current streak from day list
    const streakMap = {};
    { const bySt = {};
      streakRaw.forEach(r => { (bySt[r.student_id] = bySt[r.student_id] || new Set()).add(r.d); });
      Object.keys(bySt).forEach(sid => {
        const set = bySt[sid]; let expect = today.getTime(); let st = 0;
        if (!set.has(new Date(expect).toISOString().slice(0, 10))) expect -= DAY;
        while (set.has(new Date(expect).toISOString().slice(0, 10))) { st++; expect -= DAY; }
        streakMap[sid] = st;
      });
    }

    const timeMap = {}; timeRaw.forEach(r => { timeMap[r.student_id] = r; });
    const quizMap = {}; quizByStRaw.forEach(r => { quizMap[r.student_id] = { avg: Math.round((+r.avg_score) * 10) / 10, attempts: +r.attempts }; });

    const subByTitle = {}; coursesRaw.forEach(c => { subByTitle[c.title] = Number(c.subtopic_count) || 0; });

    // progress map (fully-completed modules per student per course) + engagement from steps
    const doneMap = {}; const progCourses = {};
    progRaw.forEach(r => {
      (doneMap[r.student_id] = doneMap[r.student_id] || {})[r.course_name] = +r.done;
      (progCourses[r.course_name] = progCourses[r.course_name] || new Set()).add(r.student_id);
    });
    const touchMap = {}; const touchCourses = {};
    touchedRaw.forEach(r => {
      const o = (touchMap[r.student_id] = touchMap[r.student_id] || {});
      o[r.course_name] = { touched: +r.touched, furthest: +r.furthest };
      (touchCourses[r.course_name] = touchCourses[r.course_name] || new Set()).add(r.student_id);
    });
    const enrollFromSteps = {}; enrollRaw.forEach(r => { enrollFromSteps[r.course_name] = +r.enrolled; });
    const funnelByCourse = {};
    courseStepRaw.forEach(r => { (funnelByCourse[r.course_name] = funnelByCourse[r.course_name] || {})[r.step] = +r.students; });

    // per-module step matrix for stall detection
    const stepMatrix = {};
    stepsRaw.forEach(r => {
      const c = (stepMatrix[r.course_name] = stepMatrix[r.course_name] || {});
      const m = (c[r.module_index] = c[r.module_index] || {}); m[r.step] = +r.cnt;
    });
    function biggestStall(courseName, subCount) {
      const cm = stepMatrix[courseName]; if (!cm) return null;
      const mods = Object.keys(cm).map(Number).sort((a, b) => a - b);
      const finished = mods.map(m => { const o = cm[m]; return o.ex != null ? o.ex : (o.mcq != null ? o.mcq : (o.pdf != null ? o.pdf : (o.video || 0))); });
      let worst = 0, at = -1;
      for (let i = 1; i < mods.length; i++) { const loss = finished[i - 1] - finished[i]; if (loss > worst) { worst = loss; at = i; } }
      if (at < 0) return null;
      return { module: mods[at] + 1, lost: worst, label: 'Subtopic ' + (mods[at] + 1) };
    }

    // learners rollup
    const learners = studentsRaw.map(u => {
      const t = timeMap[u.id] || {}; const dn = doneMap[u.id] || {}; const tc = touchMap[u.id] || {};
      const courseNames = new Set([...Object.keys(dn), ...Object.keys(tc)]);
      let pctSum = 0, pctN = 0, certified = 0;
      courseNames.forEach(cn => {
        const subs = subByTitle[cn] != null ? subByTitle[cn] : 0;
        const p = subs > 0 ? Math.min(100, Math.round(((dn[cn] || 0) / subs) * 100)) : 0;
        pctSum += p; pctN++; if (p >= 100) certified++;
      });
      const avgPct = pctN ? Math.round(pctSum / pctN) : 0;
      const last = dstr(t.last_day);
      const idle = last ? Math.floor((today.getTime() - Date.parse(last + 'T12:00:00')) / DAY) : 999;
      const hours = Math.round(((+t.total_s || 0) / 3600) * 10) / 10;
      const weekH = Math.round(((+t.week_s || 0) / 3600) * 10) / 10;
      const q = quizMap[u.id] || null;
      let status = 'not-started';
      if (courseNames.size > 0 || +t.total_s > 0) {
        if (!last) status = 'needs-nudge'; /* engaged but no time data yet — don't cry wolf */
        else if (idle >= 7) status = 'at-risk';
        else if (idle >= 3 || (pctN > 0 && avgPct < 40)) status = 'needs-nudge';
        else status = 'on-track';
      }
      return { id: u.id, name: u.full_name || u.email || 'Learner #' + u.id, email: u.email || '',
        courses: courseNames.size, avg_pct: avgPct, certified, hours, week_hours: weekH,
        streak: streakMap[u.id] || 0, quiz_avg: q ? q.avg : null, quiz_attempts: q ? q.attempts : 0,
        last_active: last, idle_days: idle > 3650 ? null : idle, status };
    });

    // courses rollup
    const courses = coursesRaw.map(c => {
      const enrolledSet = new Set([...(progCourses[c.title] || []), ...(touchCourses[c.title] || [])]);
      let enrolled = Math.max(enrolledSet.size, enrollFromSteps[c.title] || 0);
      let pctSum = 0, pctN = 0, certs = 0;
      enrolledSet.forEach(sid => {
        const subs = Number(c.subtopic_count) || 0;
        const p = subs > 0 ? Math.min(100, Math.round(((doneMap[sid] && doneMap[sid][c.title]) || 0) / subs * 100)) : 0;
        pctSum += p; pctN++; if (p >= 100) certs++;
      });
      return { title: c.title, subtopics: Number(c.subtopic_count) || 0, enrolled,
        avg_pct: pctN ? Math.round(pctSum / pctN) : 0, certificates: certs,
        funnel: funnelByCourse[c.title] || {}, stall: biggestStall(c.title, Number(c.subtopic_count) || 0) };
    });

    const globalFunnel = {}; ['video', 'pdf', 'mcq', 'ex'].forEach(k => { globalFunnel[k] = courses.reduce((a, c) => a + (c.funnel[k] || 0), 0); });
    const nSub = learners.filter(l => l.status !== 'not-started').length;
    const series = []; {
      const byDay = {}; seriesRaw.forEach(r => { byDay[r.d] = r; });
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * DAY).toISOString().slice(0, 10);
        const row = byDay[d];
        series.push({ d, active: row ? +row.active_students : 0, minutes: row ? Math.round((+row.seconds) / 60) : 0 });
      }
    }
    const quizAll = quizAllRaw[0] || { n: 0, avg_score: 0 };
    res.json({
      ok: true, days, generated_at: new Date().toISOString(),
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
  } catch (e) {
    console.error('analytics failed:', e);
    res.status(500).json({ error: 'Analytics unavailable', detail: e.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json(readStepConfig());
});

app.post('/api/config', (req, res) => {
  try {
    const b = req.body || {};
    const clamp = (v, d) => { v = parseInt(v, 10); return (isFinite(v) && v >= 50 && v <= 100) ? v : d; };
    const cur = readStepConfig();
    const next = {
      video_req_pct: clamp(b.video_req_pct, cur.video_req_pct),
      pdf_req_pct:   clamp(b.pdf_req_pct,   cur.pdf_req_pct),
    };
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STEP_CONFIG_FILE, JSON.stringify(next, null, 2)); } catch (e) { console.warn('config persist failed:', e.message); }
    res.json({ saved: true, config: next });
  } catch (e) {
    console.error('config save failed:', e);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

app.get('/api/steps', async (req, res) => {
  try {
    const student_id = parseInt(req.query.student_id, 10);
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    if(req.query.course_name && !(await mayStudy(req.auth,req.query.course_name,0))) return res.status(403).json({error:'This course is outside your current access.',code:'course_locked'});
    await ensureStepsTable();
    let sql = 'SELECT module_index, step, pct, completed_at FROM lesson_steps WHERE student_id=?';
    const args = [student_id];
    if (req.query.course_name) { sql += ' AND course_name=?'; args.push(req.query.course_name); }
    sql += ' ORDER BY module_index, step';
    const [rows] = await pool.query(sql, args);
    res.json(rows);
  } catch (e) {
    console.error('steps fetch failed:', e);
    res.status(500).json({ error: 'Failed to fetch steps' });
  }
});

app.post('/api/steps', async (req, res) => {
  try {
    const b = req.body || {};
    const student_id = parseInt(b.student_id, 10);
    const module_index = parseInt(b.module_index, 10);
    const course_name = b.course_name, step = b.step;
    if (!student_id || !course_name || isNaN(module_index) || !STEP_ORDER.includes(step)) {
      return res.status(400).json({ error: 'student_id, course_name, module_index and a valid step (video|pdf|mcq|ex) are required' });
    }
    if (!(await mayStudy(req.auth,course_name,module_index))) return res.status(403).json({error:'This lesson is outside your current course access.',code:'course_locked'});
    const pct = Math.max(0, Math.min(100, parseInt(b.pct, 10) || 100));
    await ensureStepsTable();
    const cfg = readStepConfig();
    const [rows] = await pool.query(
      'SELECT step, pct FROM lesson_steps WHERE student_id=? AND course_name=? AND module_index=?',
      [student_id, course_name, module_index]
    );
    const have = {}; rows.forEach(r => { have[r.step] = r.pct; });
    const videoOk = (have.video || 0) >= cfg.video_req_pct;
    const pdfOk   = (have.pdf   || 0) >= cfg.pdf_req_pct;
    if (step === 'video' && pct < cfg.video_req_pct)
      return res.status(403).json({ error: 'Watch at least ' + cfg.video_req_pct + '% of the video before it counts as complete' });
    if (step === 'pdf') {
      if (!videoOk) return res.status(403).json({ error: 'Complete the lesson video before recording PDF completion' });
      if (pct < cfg.pdf_req_pct) return res.status(403).json({ error: 'Read at least ' + cfg.pdf_req_pct + '% of the document (reach the last page)' });
    }
    if (step === 'mcq' && !pdfOk)
      return res.status(403).json({ error: 'Complete the PDF before recording an MCQ pass' });
    if (step === 'ex' && !(have.mcq != null))
      return res.status(403).json({ error: 'Pass the MCQ before marking the exercise done' });
    await pool.query(
      `INSERT INTO lesson_steps (student_id, course_name, module_index, step, pct)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE pct=GREATEST(pct, VALUES(pct)), completed_at=NOW()`,
      [student_id, course_name, module_index, step, pct]
    );
    const [after] = await pool.query(
      'SELECT module_index, step, pct FROM lesson_steps WHERE student_id=? AND course_name=? AND module_index=?',
      [student_id, course_name, module_index]
    );
    res.status(201).json({ saved: true, steps: after });
  } catch (e) {
    console.error('steps save failed:', e);
    res.status(500).json({ error: 'Failed to save step' });
  }
});

// =============================================================
// START SERVER
// =============================================================

const PORT = process.env.PORT || 3000;
if (DB_MISSING.length && require.main === module) {
  console.error('\n[DB] Cannot start: ' + DB_MISSING.join(', ') + ' are not set.\n' +
                '     → On your own PC, create this exact file: ' + ENV_FILE + '\n' +
                '       with these lines (fill in YOUR local MySQL password), then start again:\n' +
                '         DB_HOST=127.0.0.1\n         DB_PORT=3306\n         DB_NAME=softmarc\n         DB_USER=root\n         DB_PASS=yourmysqlpassword\n' +
                '       (server.js reads only .env — your .env.local / DB_TYPE=sqlite / server-local.js options do NOT apply to it)\n' +
                '     → No local MySQL at all? Use the built-in demo instead: npm run local\n' +
                '     → Hosting (Hostinger): hPanel → Node.js app → Environment Variables → add them → Save → Restart App.\n' +
                '     Stopped here on purpose: a server without a database would answer every page with errors.\n');
  process.exit(1);
}
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
const SERVER = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Softmarc API running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health\n`);
  try { await ensureStepsTable(); console.log('[DB] lesson_steps table ready'); } catch (e) { console.warn('[DB] lesson_steps ensure failed (retries on first use):', e.message); }
  try { await ensureTimeTable(); console.log('[DB] user_time table ready'); } catch (e) { console.warn('[DB] user_time ensure failed (retries on first use):', e.message); }
  try { await ensureAccessTables(); console.log('[DB] trainer/batch tables ready'); } catch (e) { console.warn('[DB] trainer/batch ensure failed (retries on first use):', e.message); }
  try { await ensureStudentProfileColumns(); console.log('[DB] student profile columns ready'); } catch (e) { console.warn('[DB] student profile ensure failed (retries on signup):', e.message); }
  try { await ensureSubtopicResourcesTable(); console.log('[DB] subtopic resource playlists ready'); } catch (e) { console.warn('[DB] resource playlist ensure failed (retries on first course read):', e.message); }
  try { await ensureSubtopicHierarchyColumn(); console.log('[DB] nested subtopics ready'); } catch (e) { console.warn('[DB] nested subtopics ensure failed (retries on course read):', e.message); }
});
SERVER.on('error', listenError);

module.exports = app;
