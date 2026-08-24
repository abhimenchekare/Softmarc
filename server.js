require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

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
    res.json({ status: 'ok', time: r.rows[0].time, user_count: r.rows[0].user_count, using_url: !!process.env.DATABASE_URL });
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

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Softmarc API running on http://localhost:${PORT}`);
    console.log(`Check health: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
