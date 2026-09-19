require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    || p.startsWith('.env');
  if (blocked) return res.status(403).send('Forbidden');
  next();
});

app.use('/videos', express.static(path.join(DATA_DIR, 'videos')), express.static(path.join(__dirname, 'videos')));
app.use('/pdfs', express.static(path.join(DATA_DIR, 'pdfs')));
app.use('/images', express.static(path.join(DATA_DIR, 'images')));
app.use(express.static(__dirname));

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
// CORS Headers
// =============================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================================
// .php ROUTE ALIASES (for frontend compatibility)
// =============================================================
app.use((req, res, next) => {
  if (req.path.endsWith('.php')) {
    req.url = req.url.replace('.php', '');
  }
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

    res.json({
      status: 'ok',
      time: rows[0].time,
      user_count: userCount,
      course_count: courseCount,
      message: courseCount === 'table_missing' ? 'Run MYSQL_MIGRATION.sql in phpMyAdmin!' : 'All tables exist'
    });
  } catch (e) {
    console.error('[Health Check Failed]', e);
    res.status(500).json({ 
      status: 'error', 
      error: e.message,
      hint: 'Check DB environment variables'
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
    const [rows] = await pool.query('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    res.json({
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
    const [result] = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [full_name, email, password_hash, role || 'student']
    );
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
    const [user] = await pool.query('SELECT id, full_name, email, role, phone, department, institution, city, avatar_image, created_at FROM users WHERE id = ?', [req.params.id]);
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
    const [courses] = await pool.query('SELECT * FROM courses WHERE status = ? ORDER BY display_order ASC, id ASC', ['active']);
    
    if (courses.length > 0) {
      const courseIds = courses.map(c => c.id);
      const [subtopics] = await pool.query('SELECT * FROM subtopics WHERE course_id IN (?) ORDER BY display_order ASC, id ASC', [courseIds]);
      
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
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courses', detail: err.message });
  }
});

app.get('/api/courses/:id', async (req, res) => {
  try {
    const [courses] = await pool.query('SELECT * FROM courses WHERE id = ?', [req.params.id]);
    if (courses.length === 0) return res.status(404).json({ error: 'Course not found' });
    
    const [subtopics] = await pool.query('SELECT * FROM subtopics WHERE course_id = ? ORDER BY display_order ASC', [req.params.id]);
    courses[0].subtopics = subtopics;
    res.json(courses[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch course' });
  }
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
// SUBTOPICS
// =============================================================

app.post('/api/courses/:id/subtopics', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;
  if (!title) return res.status(400).json({error: 'title is required'});

  try {
    const [result] = await pool.query(
      'INSERT INTO subtopics (course_id, title, slug, dur, description, video_url, pdf_url, exercise, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, title, slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), dur || '15 min', description || '', video_url || '', pdf_url || '', exercise || '', display_order || 0]
    );
    const [sub] = await pool.query('SELECT * FROM subtopics WHERE id = ?', [result.insertId]);
    res.status(201).json(sub[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create subtopic' });
  }
});

app.put('/api/subtopics/:id', async (req, res) => {
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;
  try {
    await pool.query(
      'UPDATE subtopics SET title = COALESCE(?, title), slug = COALESCE(?, slug), dur = COALESCE(?, dur), description = COALESCE(?, description), video_url = COALESCE(?, video_url), pdf_url = COALESCE(?, pdf_url), exercise = COALESCE(?, exercise), display_order = COALESCE(?, display_order), updated_at = NOW() WHERE id = ?',
      [title, slug, dur, description, video_url, pdf_url, exercise, display_order, req.params.id]
    );
    const [sub] = await pool.query('SELECT * FROM subtopics WHERE id = ?', [req.params.id]);
    if (sub.length === 0) return res.status(404).json({ error: 'Subtopic not found' });
    res.json(sub[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subtopic' });
  }
});

app.delete('/api/subtopics/:id', async (req, res) => {
  try {
    const [sub] = await pool.query('SELECT id, title FROM subtopics WHERE id = ?', [req.params.id]);
    if (sub.length === 0) return res.status(404).json({ error: 'Subtopic not found' });
    await pool.query('DELETE FROM subtopics WHERE id = ?', [req.params.id]);
    res.json({ deleted: true, subtopic: sub[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subtopic' });
  }
});

// =============================================================
// QUIZZES
// =============================================================

app.get('/api/quizzes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM quizzes ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

app.get('/api/quizzes/:id', async (req, res) => {
  try {
    const [quizzes] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [req.params.id]);
    if (quizzes.length === 0) return res.status(404).json({ error: 'Quiz not found' });
    const [questions] = await pool.query('SELECT * FROM questions WHERE quiz_id = ? ORDER BY id ASC', [req.params.id]);
    quizzes[0].questions = questions;
    res.json(quizzes[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
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
  const { course_name, title } = req.body;
  try {
    const [result] = await pool.query('INSERT INTO quizzes (course_name, title) VALUES (?, ?)', [course_name, title]);
    const [quiz] = await pool.query('SELECT * FROM quizzes WHERE id = ?', [result.insertId]);
    res.status(201).json(quiz[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  try {
    const [quiz] = await pool.query('SELECT id, title FROM quizzes WHERE id = ?', [req.params.id]);
    if (quiz.length === 0) return res.status(404).json({ error: 'Quiz not found' });
    await pool.query('DELETE FROM quizzes WHERE id = ?', [req.params.id]);
    res.json({ deleted: true, quiz: quiz[0] });
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
    const [result] = await pool.query(
      'INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, question_text, option_a, option_b, option_c, option_d, correct_option]
    );
    const [q] = await pool.query('SELECT id, question_text, correct_option FROM questions WHERE id = ?', [result.insertId]);
    res.status(201).json(q[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create question' });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  try {
    await pool.query(
      'UPDATE questions SET question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, correct_option=? WHERE id=?',
      [question_text, option_a, option_b, option_c, option_d, correct_option, req.params.id]
    );
    res.json({ updated: true, id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update question' });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id = ?', [req.params.id]);
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
    const [questions] = await pool.query('SELECT id, correct_option FROM questions WHERE quiz_id = ?', [req.params.id]);
    if (questions.length === 0) return res.status(400).json({ error: 'Quiz has no questions' });

    let correctCount = 0;
    questions.forEach(q => {
      if (answers[q.id] && answers[q.id].toUpperCase() === q.correct_option.toUpperCase()) correctCount++;
    });
    const score = Math.round((correctCount / questions.length) * 100);

    const [result] = await pool.query(
      'INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score) VALUES (?, ?, ?, ?, ?, ?)',
      [student_id, student_name, req.params.id, quiz_title, JSON.stringify(answers), score]
    );
    res.json({ submission_id: result.insertId, score, correct_count: correctCount, total_count: questions.length });
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
const pickFolder = type => (type === 'video' ? 'videos' : type === 'pdf' ? 'pdfs' : 'images');

// Stream uploads straight to disk (no whole-file RAM buffering) —
// this is what makes multi-hundred-MB videos safe on shared hosting.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DATA_DIR, pickFolder(req.body.type));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safe || 'file'}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

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
    const filePath = `${pickFolder(req.body.type)}/${req.file.filename}`;
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
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Softmarc API running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health\n`);
  try { await ensureStepsTable(); console.log('[DB] lesson_steps table ready'); } catch (e) { console.warn('[DB] lesson_steps ensure failed (retries on first use):', e.message); }
});

module.exports = app;
