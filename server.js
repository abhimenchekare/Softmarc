require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the current directory
app.use(express.static(__dirname));

// Redirect root to Softmarc_Login.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Softmarc_Login.html'));
});

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  // Most hosted Postgres providers require TLS. Keep local development
  // compatible with a standard local Postgres installation.
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

const SALT_ROUNDS = 12;

// ---------- GET /api/users — list all users (no password hashes) ----------
app.get('/api/users', async (req, res) => {
  console.log(`\n[Backend API] GET /api/users - Fetching user list.`);
  console.log(`[SQL Query] SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC;`);
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, role, created_at FROM users ORDER BY created_at DESC'
    );
    console.log(`[Backend Success] Returned ${result.rowCount} user records from PostgreSQL.`);
    res.json(result.rows);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ---------- POST /api/login — verify email/password, return user info ----------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  console.log(`\n[Backend API] POST /api/login - Login attempt for email: "${email}"`);

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  console.log(`[SQL Query] SELECT id, full_name, email, password_hash, role FROM users WHERE email = '${email}';`);
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, password_hash, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rowCount === 0) {
      console.log(`[Backend Fail] Login failed: User "${email}" not found.`);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      console.log(`[Backend Fail] Login failed: Incorrect password for "${email}".`);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    console.log(`[Backend Success] Login successful for user: "${user.full_name}" (Role: ${user.role})`);
    res.json({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Login failed.' });
  }
});



// ---------- POST /api/users — add a new user ----------
app.post('/api/users', async (req, res) => {
  const { full_name, email, password, role } = req.body;
  console.log(`\n[Backend API] POST /api/users - Registering user: "${full_name}" (${email}) with role: "${role || 'student'}"`);

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'full_name, email, and password are required.' });
  }

  if (role && !['student', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be "student" or "admin".' });
  }

  console.log(`[SQL Query] INSERT INTO users (full_name, email, password_hash, role) VALUES ('${full_name}', '${email}', '<bcrypt_hash>', '${role || 'student'}');`);
  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, COALESCE($4, 'student'))
       RETURNING id, full_name, email, role, created_at`,
      [full_name, email, password_hash, role]
    );

    console.log(`[Backend Success] Registered user ID: ${result.rows[0].id} in PostgreSQL.`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      console.log(`[Backend Fail] Registration failed: Email "${email}" already exists.`);
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to create user.' });
  }
});

// ---------- DELETE /api/users/:id — remove a user ----------
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n[Backend API] DELETE /api/users/${id} - Request to delete user account.`);

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  console.log(`[SQL Query] DELETE FROM users WHERE id = ${id};`);
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rowCount === 0) {
      console.log(`[Backend Fail] Deletion failed: User ID ${id} not found.`);
      return res.status(404).json({ error: 'User not found.' });
    }

    console.log(`[Backend Success] Deleted user ID: ${id} from PostgreSQL database.`);
    res.json({ deleted: true, id: Number(id) });
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// ---------- GET /api/quizzes — list all quizzes ----------
app.get('/api/quizzes', async (req, res) => {
  console.log(`\n[Backend API] GET /api/quizzes - Fetching all quizzes.`);
  try {
    const result = await pool.query('SELECT * FROM quizzes ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

// ---------- GET /api/quizzes/:id/questions — list questions for quiz ----------
app.get('/api/quizzes/:id/questions', async (req, res) => {
  const { id } = req.params;
  console.log(`\n[Backend API] GET /api/quizzes/${id}/questions - Fetching questions.`);
  try {
    const result = await pool.query('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY id ASC', [id]);
    res.json(result.rows);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to fetch questions.' });
  }
});

// ---------- POST /api/quizzes/:id/submit — submit student answers ----------
app.post('/api/quizzes/:id/submit', async (req, res) => {
  const { id } = req.params;
  const { student_id, student_name, quiz_title, answers } = req.body; // answers is like { "question_id_1": "A", ... }
  console.log(`\n[Backend API] POST /api/quizzes/${id}/submit - Student "${student_name}" (ID: ${student_id}) submitting answers.`);
  
  try {
    // 1. Fetch correct answers from DB
    const questionsResult = await pool.query('SELECT id, correct_option FROM questions WHERE quiz_id = $1', [id]);
    const questions = questionsResult.rows;
    
    if (questions.length === 0) {
      return res.status(400).json({ error: 'This quiz has no questions yet.' });
    }
    
    // 2. Calculate score
    let correctCount = 0;
    questions.forEach(q => {
      const studentAnswer = answers[q.id];
      if (studentAnswer && studentAnswer.toUpperCase() === q.correct_option.toUpperCase()) {
        correctCount++;
      }
    });
    
    const score = Math.round((correctCount / questions.length) * 100);
    
    // 3. Save submission
    const result = await pool.query(
      `INSERT INTO student_submissions (student_id, student_name, quiz_id, quiz_title, answers, score)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, score, submitted_at`,
      [student_id, student_name, id, quiz_title, JSON.stringify(answers), score]
    );
    
    console.log(`[Backend Success] Saved submission ID: ${result.rows[0].id} with score: ${score}%`);
    res.json({ submission_id: result.rows[0].id, score, correct_count: correctCount, total_count: questions.length });
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to submit quiz.' });
  }
});

// ---------- GET /api/submissions — list all student submissions (for admin) ----------
app.get('/api/submissions', async (req, res) => {
  console.log(`\n[Backend API] GET /api/submissions - Fetching student scores.`);
  try {
    const result = await pool.query('SELECT * FROM student_submissions ORDER BY submitted_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

// ---------- POST /api/quizzes — create a new quiz (admin) ----------
app.post('/api/quizzes', async (req, res) => {
  const { course_name, title } = req.body;
  console.log(`\n[Backend API] POST /api/quizzes - Admin creating quiz: "${title}" for "${course_name}"`);
  try {
    const result = await pool.query(
      'INSERT INTO quizzes (course_name, title) VALUES ($1, $2) RETURNING id, course_name, title, created_at',
      [course_name, title]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to create quiz.' });
  }
});

// ---------- POST /api/quizzes/:id/questions — add a question to a quiz (admin) ----------
app.post('/api/quizzes/:id/questions', async (req, res) => {
  const { id } = req.params;
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  console.log(`\n[Backend API] POST /api/quizzes/${id}/questions - Adding question text.`);
  try {
    const result = await pool.query(
      `INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, question_text, correct_option`,
      [id, question_text, option_a, option_b, option_c, option_d, correct_option]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to create question.' });
  }
});

// ---------- PUT /api/questions/:id — edit a question (admin) ----------
app.put('/api/questions/:id', async (req, res) => {
  const { id } = req.params;
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;
  console.log(`\n[Backend API] PUT /api/questions/${id} - Editing question.`);
  try {
    const result = await pool.query(
      `UPDATE questions
       SET question_text = $1, option_a = $2, option_b = $3, option_c = $4, option_d = $5, correct_option = $6
       WHERE id = $7
       RETURNING id`,
      [question_text, option_a, option_b, option_c, option_d, correct_option, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Question not found.' });
    }
    res.json({ updated: true, id: Number(id) });
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to update question.' });
  }
});

// ---------- DELETE /api/questions/:id — delete a question (admin) ----------
app.delete('/api/questions/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n[Backend API] DELETE /api/questions/${id} - Deleting question.`);
  try {
    const result = await pool.query('DELETE FROM questions WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Question not found.' });
    }
    res.json({ deleted: true, id: Number(id) });
  } catch (err) {
    console.error(`[Backend Error]`, err);
    res.status(500).json({ error: 'Failed to delete question.' });
  }
});

// Vercel imports this Express app from api/[...path].js. Only open a port
// when the file is started directly for local development.
if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Softmarc admin API running on http://localhost:${PORT}`);
  });
}

module.exports = app;
