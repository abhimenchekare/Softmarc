require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');

// =============================================================
// SUPABASE CLIENT — For Storage (file uploads)
// Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel env vars
// =============================================================
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    console.log('[Supabase] Storage client initialized');
  } else {
    console.log('[Supabase] No SUPABASE_URL/SUPABASE_SERVICE_KEY set — file uploads will use fallback');
  }
} catch (e) {
  console.log('[Supabase] @supabase/supabase-js not installed — run: npm install @supabase/supabase-js');
}

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/avi',
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp', 'image/gif'
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed: ' + file.mimetype), false);
  }
});

const app = express();
app.use(cors());
// Increase limit to allow base64 avatar (Supabase TEXT field). 10mb safe for Vercel
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from the current directory
app.use(express.static(__dirname));

// Root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// -------------------- DB CONNECTION (Supabase + Local compatible) --------------------
/**
 * Supabase gives you a DATABASE_URL like:
 * postgres://postgres.xxx:password@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
 * For Vercel, set DATABASE_URL in Environment Variables.
 * For local dev, you can still use PGHOST / PGUSER etc from .env
 */
let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // Optimized for Vercel serverless - faster login
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
  };
  console.log('[DB] Using DATABASE_URL (Supabase) connection string');
} else {
  poolConfig = {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE || 'postgres',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
  };
  console.log('[DB] Using individual PG* env vars');
}

const pool = new Pool(poolConfig);
// Warm up pool on startup - makes first login faster
pool.query('SELECT 1').then(()=>console.log('[DB] Pool warmed up')).catch(()=>{});

// Reduce bcrypt cost for faster login on serverless (10 = ~80ms vs 12 = ~250ms)
// Existing 12-round hashes will still work, just slower. New users will be faster.
const SALT_ROUNDS = 10;

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err);
});

// Quick health check - helps debug Vercel <-> Supabase linking
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as time, COUNT(*) as user_count FROM users');
    let course_count = 'N/A';
    try {
      const cr = await pool.query('SELECT COUNT(*) as count FROM courses');
      course_count = cr.rows[0].count;
    } catch(e) { course_count = 'table_missing'; }
    let subtopic_count = 'N/A';
    try {
      const sr = await pool.query('SELECT COUNT(*) as count FROM subtopics');
      subtopic_count = sr.rows[0].count;
    } catch(e) { subtopic_count = 'table_missing'; }
    res.json({
      status: 'ok',
      time: r.rows[0].time,
      user_count: r.rows[0].user_count,
      course_count,
      subtopic_count,
      using_url: !!process.env.DATABASE_URL,
      message: course_count === 'table_missing' ? 'Run COURSE_CONTENT_MIGRATION.sql in Supabase SQL Editor!' : 'Course content tables exist'
    });
  } catch (e) {
    console.error('[Health Check Failed]', e);
    res.status(500).json({ status: 'error', error: e.message, hint: 'Check DATABASE_URL or PGHOST env vars in Vercel' });
  }
});

// Columns we expose (never expose password_hash)
const USER_PUBLIC_COLS = `
  id, full_name, email, role,
  phone, department, institution, city, avatar_image,
  created_at
`;

// ---------- GET /api/users — list all users ----------
app.get('/api/users', async (req, res) => {
  console.log(`\n[Backend API] GET /api/users`);
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT ${USER_PUBLIC_COLS} FROM users ORDER BY created_at DESC`
      );
    } catch (colErr) {
      console.warn('[GET /api/users] Falling back to old cols:', colErr.message);
      result = await pool.query(
        `SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC`
      );
    }
    console.log(`[OK] Returned ${result.rowCount} users`);
    res.json(result.rows);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to fetch users.', detail: err.message });
  }
});

// ---------- GET /api/users/:id — single profile (CRITICAL FOR PROFILE PAGE) ----------
app.get('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });
  console.log(`\n[Backend API] GET /api/users/${id}`);
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT ${USER_PUBLIC_COLS} FROM users WHERE id = $1`,
        [id]
      );
    } catch (colErr) {
      console.warn('[GET /api/users/:id] Fallback:', colErr.message);
      result = await pool.query(
        `SELECT id, full_name, email, role, created_at FROM users WHERE id = $1`,
        [id]
      );
    }
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user', detail: err.message });
  }
});

// ---------- POST /api/login - RESILIENT VERSION (works even if profile columns missing) ----------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  console.log(`\n[Backend API] POST /api/login - ${email}`);
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    // Try new schema first, fallback to old schema if columns missing
    let result;
    try {
      result = await pool.query(
        `SELECT id, full_name, email, password_hash, role, phone, department, institution, city, avatar_image FROM users WHERE email = $1`,
        [email]
      );
    } catch (colErr) {
      console.warn('[Login] New columns missing, falling back to old schema:', colErr.message);
      result = await pool.query(
        `SELECT id, full_name, email, password_hash, role FROM users WHERE email = $1`,
        [email]
      );
    }

    if (result.rowCount === 0) return res.status(401).json({ error: 'Invalid email or password.' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    console.log(`[OK] Login success: ${user.full_name}`);
    res.json({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      phone: user.phone || null,
      department: user.department || null,
      institution: user.institution || null,
      city: user.city || null,
      avatar_image: user.avatar_image || null,
    });
  } catch (err) {
    console.error('[Login Error]', err);
    res.status(500).json({ error: 'Login failed. Check /api/health', detail: err.message });
  }
});

// ---------- POST /api/users — add new user ----------
app.post('/api/users', async (req, res) => {
  const { full_name, email, password, role, phone, department, institution, city } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'full_name, email, and password are required.' });
  if (role && !['student', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be student or admin' });
  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    let result;
    try {
      result = await pool.query(
        `INSERT INTO users (full_name, email, password_hash, role, phone, department, institution, city)
         VALUES ($1, $2, $3, COALESCE($4, 'student'), $5, $6, $7, $8)
         RETURNING ${USER_PUBLIC_COLS}`,
        [full_name, email, password_hash, role, phone || null, department || null, institution || null, city || null]
      );
    } catch (colErr) {
      console.warn('Fallback to old schema for create user:', colErr.message);
      result = await pool.query(
        `INSERT INTO users (full_name, email, password_hash, role)
         VALUES ($1, $2, $3, COALESCE($4, 'student'))
         RETURNING id, full_name, email, role, created_at`,
        [full_name, email, password_hash, role]
      );
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create user.', detail: err.message });
  }
});

// ---------- PUT /api/users/:id/profile — UPDATE PROFILE (FIX FOR YOUR ISSUE) ----------
app.put('/api/users/:id/profile', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });

  const { full_name, email, phone, department, institution, city, avatar_image } = req.body;
  console.log(`\n[Backend API] PUT /api/users/${id}/profile`, { full_name, email, phone, department, institution, city, hasAvatar: !!avatar_image });

  if (full_name !== undefined && full_name.trim() === '') return res.status(400).json({ error: 'full_name cannot be empty' });
  if (email !== undefined && email.trim() === '') return res.status(400).json({ error: 'email cannot be empty' });
  if (avatar_image && avatar_image.length > 4_000_000) {
    return res.status(400).json({ error: 'Avatar image too large. Please use < 2MB image.' });
  }

  try {
    let result;
    try {
      result = await pool.query(
        `UPDATE users SET
           full_name = COALESCE($1, full_name),
           email = COALESCE($2, email),
           phone = $3,
           department = $4,
           institution = $5,
           city = $6,
           avatar_image = COALESCE($7, avatar_image)
         WHERE id = $8
         RETURNING ${USER_PUBLIC_COLS}`,
        [full_name || null, email || null, phone || null, department || null, institution || null, city || null, avatar_image || null, id]
      );
    } catch (colErr) {
      // If profile columns don't exist yet, fallback to only name+email and tell user to run migration
      if (colErr.message.includes('column') && colErr.message.includes('does not exist')) {
        console.warn('[Profile Update] Columns missing, running fallback. Error:', colErr.message);
        const fallback = await pool.query(
          `UPDATE users SET full_name = COALESCE($1, full_name), email = COALESCE($2, email) WHERE id = $3 RETURNING id, full_name, email, role, created_at`,
          [full_name || null, email || null, id]
        );
        if (fallback.rowCount === 0) return res.status(404).json({ error: 'User not found' });
        return res.status(200).json({
          ...fallback.rows[0],
          warning: 'Profile columns (phone, department, institution, city, avatar_image) do not exist in Supabase yet. Please run ALTER TABLE migration from final_supabase_schema.sql',
        });
      }
      throw colErr;
    }
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    console.log(`[OK] Profile updated for user ${id}`);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile', detail: err.message, hint: 'Did you run ALTER TABLE to add phone/department/institution/city/avatar_image columns?' });
  }
});

// ---------- PUT /api/users/:id/avatar — dedicated avatar endpoint (optional) ----------
app.put('/api/users/:id/avatar', async (req, res) => {
  const { id } = req.params;
  const { avatar_image } = req.body;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });
  if (!avatar_image) return res.status(400).json({ error: 'avatar_image required (base64)' });
  if (avatar_image.length > 4_000_000) return res.status(400).json({ error: 'Image too large, use <2MB' });
  try {
    const result = await pool.query(
      `UPDATE users SET avatar_image = $1 WHERE id = $2 RETURNING ${USER_PUBLIC_COLS}`,
      [avatar_image, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

// DELETE avatar
app.delete('/api/users/:id/avatar', async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const result = await pool.query(
      `UPDATE users SET avatar_image = NULL WHERE id = $1 RETURNING ${USER_PUBLIC_COLS}`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

// ---------- PUT /api/users/:id/password — CHANGE PASSWORD ----------
app.put('/api/users/:id/password', async (req, res) => {
  const { id } = req.params;
  const { current_password, new_password } = req.body;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id' });
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const new_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [new_hash, id]);
    console.log(`[OK] Password changed for user ${id}`);
    res.json({ updated: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change password', detail: err.message });
  }
});

// ---------- DELETE /api/users/:id ----------
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\\d+$/.test(id)) return res.status(400).json({ error: 'Invalid user id.' });
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ deleted: true, id: Number(id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// ---------- Quizzes (unchanged, but keep) ----------
app.get('/api/quizzes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM quizzes ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

app.get('/api/quizzes/:id/questions', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY id ASC', [id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch questions.' });
  }
});

app.post('/api/quizzes/:id/submit', async (req, res) => {
  const { id } = req.params;
  const { student_id, student_name, quiz_title, answers } = req.body;
  try {
    const questionsResult = await pool.query('SELECT id, correct_option FROM questions WHERE quiz_id = $1', [id]);
    const questions = questionsResult.rows;
    if (questions.length === 0) return res.status(400).json({ error: 'This quiz has no questions yet.' });
    let correctCount = 0;
    questions.forEach(q => {
      const studentAnswer = answers[q.id];
      if (studentAnswer && studentAnswer.toUpperCase() === q.correct_option.toUpperCase()) correctCount++;
    });
    const score = Math.round((correctCount / questions.length) * 100);
    const result = await pool.query(
      `INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, score, submitted_at`,
      [student_id, student_name, id, quiz_title, JSON.stringify(answers), score]
    );
    res.json({ submission_id: result.rows[0].id, score, correct_count: correctCount, total_count: questions.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit quiz.' });
  }
});

app.get('/api/submissions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM student_submissions ORDER BY submitted_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

app.post('/api/quizzes', async (req, res) => {
  const { course_name, title } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO quizzes (course_name, title) VALUES ($1, $2) RETURNING id, course_name, title, created_at',
      [course_name, title]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create quiz.' });
  }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^\\d+$/.test(id)) return res.status(400).json({ error: 'Invalid quiz id.' });
  try {
    const result = await pool.query('DELETE FROM quizzes WHERE id = $1 RETURNING id, title', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Quiz not found.' });
    res.json({ deleted: true, quiz: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete quiz.' });
  }
});

app.post('/api/quizzes/:id/questions', async (req, res) => {
  const { id } = req.params;
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, question_text, correct_option`,
      [id, question_text, option_a, option_b, option_c, option_d, correct_option]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create question.' });
  }
});

app.put('/api/questions/:id', async (req, res) => {
  const { id } = req.params;
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  try {
    const result = await pool.query(
      `UPDATE questions SET question_text=$1, option_a=$2, option_b=$3, option_c=$4, option_d=$5, correct_option=$6 WHERE id=$7 RETURNING id`,
      [question_text, option_a, option_b, option_c, option_d, correct_option, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Question not found.' });
    res.json({ updated: true, id: Number(id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update question.' });
  }
});

app.delete('/api/questions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM questions WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Question not found.' });
    res.json({ deleted: true, id: Number(id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete question.' });
  }
});

// =============================================================
// FILE UPLOAD — Videos & PDFs to Supabase Storage
// Admin uploads → stored in Supabase Storage → URL saved to DB
// Students fetch URL from DB → play/view the file
// =============================================================

// ---------- POST /api/upload — Upload file (video, pdf, image) ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { subtopic_id, type } = req.body; // type: 'video', 'pdf', 'image'
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  console.log(`\n[Upload] ${type} file: ${file.originalname} (${(file.size/1024/1024).toFixed(2)} MB)`);

  // If no Supabase Storage, return error
  if (!supabase) {
    return res.status(500).json({
      error: 'Supabase Storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel environment variables.',
      hint: 'Go to Vercel → Settings → Environment Variables → Add SUPABASE_URL and SUPABASE_SERVICE_KEY'
    });
  }

  try {
    // Ensure bucket exists
    const bucketName = 'course-media';
    try {
      const { data: buckets } = await supabase.storage.listBuckets();
      const exists = buckets?.some(b => b.name === bucketName);
      if (!exists) {
        const { error: createErr } = await supabase.storage.createBucket(bucketName, {
          public: true,
          fileSizeLimit: 200 * 1024 * 1024,
          allowedMimeTypes: ['video/*', 'application/pdf', 'image/*']
        });
        if (createErr) console.warn('[Upload] Bucket create warning:', createErr.message);
        else console.log('[Upload] Created bucket: course-media');
      }
    } catch (e) {
      console.warn('[Upload] Bucket check:', e.message);
    }

    // Generate file path
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const folder = type === 'video' ? 'videos' : type === 'pdf' ? 'pdfs' : 'images';
    const filePath = `${folder}/${subtopic_id || 'general'}/${timestamp}_${safeName}`;

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) {
      console.error('[Upload] Storage error:', error);
      return res.status(500).json({ error: 'Upload to storage failed', detail: error.message });
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    // Update subtopic in database if subtopic_id provided
    if (subtopic_id && !isNaN(subtopic_id)) {
      const urlField = type === 'video' ? 'video_url' : type === 'pdf' ? 'pdf_url' : 'image';
      try {
        await pool.query(`UPDATE subtopics SET ${urlField} = $1, updated_at = NOW() WHERE id = $2`, [publicUrl, subtopic_id]);
        console.log(`[Upload] Updated subtopic ${subtopic_id} with ${urlField}`);
      } catch (dbErr) {
        console.warn('[Upload] DB update failed:', dbErr.message);
      }
    }

    console.log(`[OK] File uploaded: ${publicUrl}`);
    res.json({
      url: publicUrl,
      path: filePath,
      size: file.size,
      type: file.mimetype,
      originalName: file.originalname
    });

  } catch (err) {
    console.error('[Upload Error]', err);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

// ---------- POST /api/upload/course-image — Upload course preview image ----------
app.post('/api/upload/course-image', upload.single('file'), async (req, res) => {
  const { course_id } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!supabase) return res.status(500).json({ error: 'Supabase Storage not configured' });

  try {
    const filePath = `courses/${course_id || 'general'}/preview_${Date.now()}.${file.originalname.split('.').pop()}`;

    const { error } = await supabase.storage.from('course-media').upload(filePath, file.buffer, {
      contentType: file.mimetype, upsert: true
    });
    if (error) throw error;

    const { data: urlData } = supabase.storage.from('course-media').getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    // Update course image in DB
    if (course_id && !isNaN(course_id)) {
      try {
        await pool.query('UPDATE courses SET image = $1, updated_at = NOW() WHERE id = $2', [publicUrl, course_id]);
      } catch (e) {}
    }

    res.json({ url: publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

// =============================================================
// COURSES & SUBTOPICS — Admin-managed content (Supabase)
// This is the KEY fix: admin content now lives in Supabase
// so ALL students see it from ANY browser/device.
// =============================================================

// ---------- GET /api/courses — list all courses with subtopics ----------
app.get('/api/courses', async (req, res) => {
  console.log('\n[Backend API] GET /api/courses');
  try {
    const coursesResult = await pool.query(
      'SELECT * FROM courses WHERE status = $1 ORDER BY display_order ASC, id ASC',
      ['active']
    );
    const courses = coursesResult.rows;

    // Fetch all subtopics for these courses in one query
    if (courses.length > 0) {
      const courseIds = courses.map(c => c.id);
      const subResult = await pool.query(
        'SELECT * FROM subtopics WHERE course_id = ANY($1) ORDER BY display_order ASC, id ASC',
        [courseIds]
      );

      // Attach subtopics to their courses
      const subMap = new Map();
      subResult.rows.forEach(s => {
        if (!subMap.has(s.course_id)) subMap.set(s.course_id, []);
        subMap.get(s.course_id).push(s);
      });

      courses.forEach(c => {
        c.subtopics = subMap.get(c.id) || [];
      });
    }

    console.log(`[OK] Returned ${courses.length} courses with subtopics`);
    res.json(courses);
  } catch (err) {
    // If tables don't exist yet, return empty array (frontend falls back to hardcoded)
    if (err.message.includes('does not exist')) {
      console.warn('[Courses] Tables not created yet. Run COURSE_CONTENT_MIGRATION.sql');
      return res.json([]);
    }
    console.error('[Courses Error]', err);
    res.status(500).json({ error: 'Failed to fetch courses', detail: err.message });
  }
});

// ---------- GET /api/courses/:id — single course with subtopics ----------
app.get('/api/courses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const courseResult = await pool.query('SELECT * FROM courses WHERE id = $1', [id]);
    if (courseResult.rowCount === 0) return res.status(404).json({ error: 'Course not found' });

    const course = courseResult.rows[0];
    const subResult = await pool.query(
      'SELECT * FROM subtopics WHERE course_id = $1 ORDER BY display_order ASC, id ASC',
      [id]
    );
    course.subtopics = subResult.rows;
    res.json(course);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch course' });
  }
});

// ---------- POST /api/courses — create new course ----------
app.post('/api/courses', async (req, res) => {
  const { title, slug, tag, short_description, description, duration_hours, level, image, display_order } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const courseSlug = slug || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  try {
    const result = await pool.query(
      `INSERT INTO courses (title, slug, tag, short_description, description, duration_hours, level, image, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title, courseSlug, tag || 'Course', short_description || '', description || '', duration_hours || 10, level || 'Beginner', image || '', display_order || 0]
    );
    console.log(`[OK] Course created: ${title}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A course with that slug already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create course', detail: err.message });
  }
});

// ---------- PUT /api/courses/:id — update course ----------
app.put('/api/courses/:id', async (req, res) => {
  const { id } = req.params;
  const { title, slug, tag, short_description, description, duration_hours, level, image, status, display_order } = req.body;

  try {
    const result = await pool.query(
      `UPDATE courses SET
         title = COALESCE($1, title),
         slug = COALESCE($2, slug),
         tag = COALESCE($3, tag),
         short_description = COALESCE($4, short_description),
         description = COALESCE($5, description),
         duration_hours = COALESCE($6, duration_hours),
         level = COALESCE($7, level),
         image = COALESCE($8, image),
         status = COALESCE($9, status),
         display_order = COALESCE($10, display_order),
         updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [title, slug, tag, short_description, description, duration_hours, level, image, status, display_order, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Course not found' });
    console.log(`[OK] Course updated: ${id}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update course', detail: err.message });
  }
});

// ---------- DELETE /api/courses/:id — delete course (cascades to subtopics) ----------
app.delete('/api/courses/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM courses WHERE id = $1 RETURNING id, title', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Course not found' });
    console.log(`[OK] Course deleted: ${result.rows[0].title}`);
    res.json({ deleted: true, course: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

// ---------- POST /api/courses/:id/subtopics — add subtopic ----------
app.post('/api/courses/:id/subtopics', async (req, res) => {
  const courseId = req.params.id;
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const subtopicSlug = slug || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  try {
    const result = await pool.query(
      `INSERT INTO subtopics (course_id, title, slug, dur, description, video_url, pdf_url, exercise, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [courseId, title, subtopicSlug, dur || '15 min', description || '', video_url || '', pdf_url || '', exercise || '', display_order || 0]
    );
    console.log(`[OK] Subtopic created: ${title} (course ${courseId})`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create subtopic', detail: err.message });
  }
});

// ---------- PUT /api/subtopics/:id — update subtopic ----------
app.put('/api/subtopics/:id', async (req, res) => {
  const { id } = req.params;
  const { title, slug, dur, description, video_url, pdf_url, exercise, display_order } = req.body;

  try {
    const result = await pool.query(
      `UPDATE subtopics SET
         title = COALESCE($1, title),
         slug = COALESCE($2, slug),
         dur = COALESCE($3, dur),
         description = COALESCE($4, description),
         video_url = COALESCE($5, video_url),
         pdf_url = COALESCE($6, pdf_url),
         exercise = COALESCE($7, exercise),
         display_order = COALESCE($8, display_order),
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [title, slug, dur, description, video_url, pdf_url, exercise, display_order, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Subtopic not found' });
    console.log(`[OK] Subtopic updated: ${id}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update subtopic', detail: err.message });
  }
});

// ---------- DELETE /api/subtopics/:id — delete subtopic ----------
app.delete('/api/subtopics/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM subtopics WHERE id = $1 RETURNING id, title', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Subtopic not found' });
    console.log(`[OK] Subtopic deleted: ${result.rows[0].title}`);
    res.json({ deleted: true, subtopic: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete subtopic' });
  }
});

// ---------- REAL PROGRESS TRACKING - lesson_progress ----------
app.get('/api/progress', async (req, res) => {
  const { student_id } = req.query;
  if (!student_id || !/^\d+$/.test(student_id)) return res.status(400).json({ error: 'student_id required' });
  try {
    const result = await pool.query(
      'SELECT * FROM lesson_progress WHERE student_id = $1 ORDER BY course_name ASC, module_index ASC',
      [student_id]
    );
    res.json(result.rows);
  } catch (err) {
    // If table doesn't exist yet, return empty (so frontend doesn't break) and hint to run migration
    if (err.message.includes('does not exist')) {
      console.warn('[Progress] Table missing, returning empty. Run lesson_progress_migration.sql');
      return res.json([]);
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch progress', detail: err.message });
  }
});

app.get('/api/progress/course', async (req, res) => {
  const { student_id, course_name } = req.query;
  if (!student_id || !course_name) return res.status(400).json({ error: 'student_id and course_name required' });
  try {
    const result = await pool.query(
      'SELECT * FROM lesson_progress WHERE student_id = $1 AND course_name = $2 ORDER BY module_index ASC',
      [student_id, course_name]
    );
    res.json(result.rows);
  } catch (err) {
    if (err.message.includes('does not exist')) return res.json([]);
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch course progress' });
  }
});

app.post('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.body;
  console.log(`[Progress] Mark done: student ${student_id}, course "${course_name}", module ${module_index}`);
  if (!student_id || !course_name || module_index === undefined) return res.status(400).json({ error: 'student_id, course_name, module_index required' });
  if (!/^\d+$/.test(String(student_id)) || !/^\d+$/.test(String(module_index))) return res.status(400).json({ error: 'Invalid ids' });
  try {
    const result = await pool.query(
      `INSERT INTO lesson_progress (student_id, course_name, module_index)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id, course_name, module_index) DO NOTHING
       RETURNING id, student_id, course_name, module_index, completed_at`,
      [student_id, course_name, module_index]
    );
    // Return all progress for this course to update UI quickly
    const all = await pool.query(
      'SELECT * FROM lesson_progress WHERE student_id = $1 AND course_name = $2 ORDER BY module_index ASC',
      [student_id, course_name]
    );
    res.status(201).json({ saved: result.rowCount > 0, progress: all.rows });
  } catch (err) {
    if (err.message.includes('does not exist')) {
      return res.status(500).json({ error: 'lesson_progress table missing. Run lesson_progress_migration.sql in Supabase SQL Editor', detail: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to save progress', detail: err.message });
  }
});

app.delete('/api/progress', async (req, res) => {
  const { student_id, course_name, module_index } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });
  try {
    if (course_name && module_index !== undefined) {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=$1 AND course_name=$2 AND module_index=$3', [student_id, course_name, module_index]);
    } else if (course_name) {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=$1 AND course_name=$2', [student_id, course_name]);
    } else {
      await pool.query('DELETE FROM lesson_progress WHERE student_id=$1', [student_id]);
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete progress' });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Softmarc API running on http://localhost:${PORT}`);
    console.log(`Check health: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
