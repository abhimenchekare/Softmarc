require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================================
// .php ROUTE ALIASES
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

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

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
