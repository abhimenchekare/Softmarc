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

app.use(express.static(__dirname));

// =============================================================
// SQLITE DATABASE (for local testing only)
// =============================================================

const Database = require('better-sqlite3');
const dbPath = './softmarc.db';
let db;

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log('[DB] SQLite connected:', dbPath);
} catch (err) {
  console.error('[DB] SQLite error:', err.message);
  console.log('[DB] Trying sql.js fallback...');
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
  `);
  
  // Create admin user if not exists
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get('admin@softmarc.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)").run('Admin', 'admin@softmarc.com', hash, 'admin');
    console.log('[DB] Admin created: admin@softmarc.com / admin123');
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

function signToken(user) {
  const body = Buffer.from(JSON.stringify({
    uid: user.id, role: user.role === 'admin' ? 'admin' : 'student', exp: Date.now() + TOKEN_TTL_MS
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
const PUB = [[/^POST$/, /^\/login$/], [/^GET$/, /^\/(health|config)$/], [/^GET$/, /^\/courses(\/\d+)?$/], [/^GET$/, /^\/quizzes(\/\d+)(\/questions)?$/]];
const ADMIN = [[/^GET$/, /^\/(users|submissions|analytics\/summary)$/], [/^POST$/, /^\/(config|upload|users|courses|quizzes)$/],
  [/^(PUT|DELETE)$/, /^\/courses\/\d+$/], [/^(PUT|DELETE)$/, /^\/subtopics\/\d+$/], [/^(PUT|DELETE)$/, /^\/quizzes\/\d+$/],
  [/^POST$/, /^\/quizzes\/\d+\/questions$/], [/^(PUT|DELETE)$/, /^\/questions\/\d+$/], [/^DELETE$/, /^\/users\/\d+$/]];
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
  const p = req.path.replace(/\.php/gi, '');  // the .php alias rewrite runs later — normalise here (also mid-path: /users.php/7/avatar)   // the .php alias rewrite runs later — normalise here
  if (PUB.some(r => r[0].test(req.method) && r[1].test(p))) return next();
  const a = authFrom(req);
  if (!a) return needSignIn(req, res);
  req.auth = a;
  if (ADMIN.some(r => r[0].test(req.method) && r[1].test(p)) && a.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required.', code: 'admin_required' });
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
    const rows = db.prepare('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const row = db.prepare('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users WHERE id = ?').get(req.params.id);
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
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const tkey = String(email).toLowerCase() + '|' + (req.ip || '');
  if (throttled(tkey))
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.', code: 'slow_down' });

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) { noteTry(tkey); return res.status(401).json({ error: 'Invalid email or password' }); }
    tries.delete(tkey);
    const token = signToken(user);

    res.json({
      token,
      token_expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      department: user.department,
      institution: user.institution,
      city: user.city,
      avatar_image: user.avatar_image
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/users', async (req, res) => {
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(full_name, email, password_hash, role || 'student');
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
    const user = db.prepare('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users WHERE id = ?').get(req.params.id);
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

// =============================================================
// COURSES
// =============================================================

app.get('/api/courses', async (req, res) => {
  try {
    const courses = db.prepare('SELECT * FROM courses WHERE status = ? ORDER BY display_order ASC, id ASC').all('active');
    
    if (courses.length > 0) {
      const courseIds = courses.map(c => c.id);
      const placeholders = courseIds.map(() => '?').join(',');
      const subtopics = db.prepare(`SELECT * FROM subtopics WHERE course_id IN (${placeholders}) ORDER BY display_order ASC, id ASC`).all(...courseIds);
      
      const subMap = new Map();
      subtopics.forEach(s => {
        if (!subMap.has(s.course_id)) subMap.set(s.course_id, []);
        subMap.get(s.course_id).push(s);
      });
      
      courses.forEach(c => {
        c.subtopics = subMap.get(c.id) || [];
      });
    }
    
    res.json(courses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courses', detail: err.message });
  }
});

app.get('/api/courses/:id', async (req, res) => {
  try {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    
    const subtopics = db.prepare('SELECT * FROM subtopics WHERE course_id = ? ORDER BY display_order ASC').all(req.params.id);
    course.subtopics = subtopics;
    res.json(course);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch course' });
  }
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
// SUBTOPICS
// =============================================================

app.post('/api/courses/:id/subtopics', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;
  if (!title) return res.status(400).json({error: 'title is required'});

  try {
    const result = db.prepare(
      'INSERT INTO subtopics (course_id, title, slug, dur, description, video_url, pdf_url, exercise, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, title, slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), dur || '15 min', description || '', video_url || '', pdf_url || '', exercise || '', display_order || 0);
    const sub = db.prepare('SELECT * FROM subtopics WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(sub);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create subtopic' });
  }
});

app.put('/api/subtopics/:id', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;
  try {
    db.prepare(
      "UPDATE subtopics SET title = COALESCE(?, title), slug = COALESCE(?, slug), dur = COALESCE(?, dur), description = COALESCE(?, description), video_url = COALESCE(?, video_url), pdf_url = COALESCE(?, pdf_url), exercise = COALESCE(?, exercise), display_order = COALESCE(?, display_order), updated_at = datetime('now') WHERE id = ?"
    ).run(title, slug, dur, description, video_url, pdf_url, exercise, display_order, req.params.id);
    const sub = db.prepare('SELECT * FROM subtopics WHERE id = ?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subtopic not found' });
    res.json(sub);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subtopic' });
  }
});

app.delete('/api/subtopics/:id', async (req, res) => {
  try {
    const sub = db.prepare('SELECT id, title FROM subtopics WHERE id = ?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subtopic not found' });
    db.prepare('DELETE FROM subtopics WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, subtopic: sub });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subtopic' });
  }
});

// =============================================================
// QUIZZES
// =============================================================

app.get('/api/quizzes', async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM quizzes ORDER BY id ASC').all();
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
  const { course_name, title } = req.body;
  try {
    const result = db.prepare('INSERT INTO quizzes (course_name, title) VALUES (?, ?)').run(course_name, title);
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
    db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, quiz });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// =============================================================
// QUESTIONS
// =============================================================

app.post('/api/quizzes/:id/questions', async (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  try {
    const result = db.prepare(
      'INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, question_text, option_a, option_b, option_c, option_d, correct_option);
    const q = db.prepare('SELECT id, question_text, correct_option FROM questions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(q);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create question' });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  try {
    db.prepare(
      'UPDATE questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=? WHERE id=?'
    ).run(question_text, option_a, option_b, option_c, option_d, correct_option, req.params.id);
    res.json({ updated: true, id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update question' });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  try {
    db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
    res.json({ deleted: true, id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// =============================================================
// QUIZ SUBMISSIONS
// =============================================================

app.post('/api/quizzes/:id/submit', async (req, res) => {
  const { student_id, student_name, quiz_title, answers } = req.body;
  try {
    const questions = db.prepare('SELECT id, correct_option FROM questions WHERE quiz_id = ?').all(req.params.id);
    if (questions.length === 0) return res.status(400).json({ error: 'Quiz has no questions' });

    let correctCount = 0;
    questions.forEach(q => {
      if (answers[q.id] && answers[q.id].toUpperCase() === q.correct_option.toUpperCase()) correctCount++;
    });
    const score = Math.round((correctCount / questions.length) * 100);

    const result = db.prepare(
      'INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(student_id, student_name, req.params.id, quiz_title, JSON.stringify(answers), score);
    res.json({ submission_id: result.lastInsertRowid, score, correct_count: correctCount, total_count: questions.length });
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

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const type = req.body.type || 'image';
  const folder = type === 'video' ? 'videos' : type === 'pdf' ? 'pdfs' : 'images';
  const timestamp = Date.now();
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${folder}/${timestamp}_${safeName}`;
  const fullPath = path.join(__dirname, filePath);
  
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, req.file.buffer);
  
  const url = `${req.protocol}://${req.get('host')}/${filePath}`;
  res.json({ url, path: filePath, size: req.file.size });
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

// =============================================================
// START SERVER
// =============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Softmarc API running on port ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`\n👤 Admin Login:`);
  console.log(`   Email: admin@softmarc.com`);
  console.log(`   Password: admin123\n`);
});

module.exports = app;
