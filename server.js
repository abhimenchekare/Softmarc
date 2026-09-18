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

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const type = req.body.type || 'image';
  const folder = type === 'video' ? 'videos' : type === 'pdf' ? 'pdfs' : 'images';
  const timestamp = Date.now();
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${folder}/${timestamp}_${safeName}`;
  const fullPath = path.join(DATA_DIR, filePath);
  
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, req.file.buffer);
  
  const url = `${req.protocol}://${req.get('host')}/${filePath}`;
  res.json({ url, path: filePath, size: req.file.size });
});

// =============================================================
// START SERVER
// =============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Softmarc API running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health\n`);
});

module.exports = app;
