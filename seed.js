require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

async function seed() {
  console.log('📦 Starting PostgreSQL automated database & table builder...');

  // Step 1: Connect to default 'postgres' DB to ensure the 'softmarc' database exists
  const setupPool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: 'postgres', // Connect to standard default DB
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });

  try {
    const dbCheck = await setupPool.query("SELECT 1 FROM pg_database WHERE datname = 'softmarc'");
    if (dbCheck.rowCount === 0) {
      await setupPool.query("CREATE DATABASE softmarc;");
      console.log('🆕 Created database "softmarc" successfully in PostgreSQL.');
    } else {
      console.log('✅ Database "softmarc" verified (already exists).');
    }
  } catch (err) {
    console.error('⚠️ Error checking or creating database:', err.message);
  } finally {
    await setupPool.end();
  }

  // Step 2: Now connect directly to 'softmarc' database to verify and build the tables
  const pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: 'softmarc',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });

  try {
    console.log('🧱 Verifying and building tables inside "softmarc" database...');

    // 1. Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          full_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'student' CHECK (role IN ('student', 'admin')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "users" verified/built.');

    // 2. Create quizzes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
          id SERIAL PRIMARY KEY,
          course_name VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "quizzes" verified/built.');

    // 3. Create questions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
          id SERIAL PRIMARY KEY,
          quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
          question_text TEXT NOT NULL,
          option_a VARCHAR(255) NOT NULL,
          option_b VARCHAR(255) NOT NULL,
          option_c VARCHAR(255) NOT NULL,
          option_d VARCHAR(255) NOT NULL,
          correct_option CHAR(1) CHECK (correct_option IN ('A', 'B', 'C', 'D')) NOT NULL
      );
    `);
    console.log('✅ Table "questions" verified/built.');

    // 4. Create student_submissions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_submissions (
          id SERIAL PRIMARY KEY,
          student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          student_name VARCHAR(255) NOT NULL,
          quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
          quiz_title VARCHAR(255) NOT NULL,
          answers JSONB NOT NULL,
          score INTEGER NOT NULL,
          submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Table "student_submissions" verified/built.');

    // 5. Seed admin user
    const checkAdmin = await pool.query('SELECT * FROM users WHERE email = $1', ['admin@softmarc.com']);
    if (checkAdmin.rowCount === 0) {
      const hash = await bcrypt.hash('admin123', SALT_ROUNDS);
      await pool.query(
        "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['Softmarc Admin', 'admin@softmarc.com', hash, 'admin']
      );
      console.log('🌱 Seeded admin user (admin@softmarc.com / admin123)');
    } else {
      console.log('ℹ️ Admin user already exists.');
    }

    // 6. Seed student user
    const checkStudent = await pool.query('SELECT * FROM users WHERE email = $1', ['student@softmarc.com']);
    if (checkStudent.rowCount === 0) {
      const hash = await bcrypt.hash('student123', SALT_ROUNDS);
      await pool.query(
        "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['John Doe', 'student@softmarc.com', hash, 'student']
      );
      console.log('🌱 Seeded student user (student@softmarc.com / student123)');
    } else {
      console.log('ℹ️ Student user already exists.');
    }

    // 7. Seed default CATIA Quizzes
    const checkQuiz = await pool.query("SELECT * FROM quizzes WHERE title = 'CATIA V5 Part Design Quiz'");
    let quizId;
    if (checkQuiz.rowCount === 0) {
      const result = await pool.query(
        "INSERT INTO quizzes (course_name, title) VALUES ($1, $2) RETURNING id",
        ['CATIA V5 Part Design', 'CATIA V5 Part Design Quiz']
      );
      quizId = result.rows[0].id;
      console.log('🌱 Seeded quiz: CATIA V5 Part Design Quiz');
      
      // Seed Questions for Part Design Quiz
      await pool.query(`
        INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
        VALUES 
        (${quizId}, 'Which workbench is used to sketch 2D profile drawings in CATIA V5?', 'Sketcher Workbench', 'Part Design Workbench', 'Generative Shape Design', 'Drafting Workbench', 'A'),
        (${quizId}, 'Which solid feature in CATIA V5 extrudes a 2D profile along a linear vector to create a 3D solid?', 'Pocket', 'Shaft', 'Pad', 'Slot', 'C'),
        (${quizId}, 'What is the file extension of a standard single mechanical component design in CATIA V5?', '.catdrawing', '.catproduct', '.catpart', '.model', 'C')
      `);
      console.log('🌱 Seeded questions for Part Design Quiz');
    } else {
      console.log('ℹ️ Part Design Quiz already exists.');
    }

    const checkQuiz2 = await pool.query("SELECT * FROM quizzes WHERE title = 'CATIA Assembly Assessment'");
    let quizId2;
    if (checkQuiz2.rowCount === 0) {
      const result = await pool.query(
        "INSERT INTO quizzes (course_name, title) VALUES ($1, $2) RETURNING id",
        ['CATIA Assembly Design', 'CATIA Assembly Assessment']
      );
      quizId2 = result.rows[0].id;
      console.log('🌱 Seeded quiz: CATIA Assembly Assessment');
      
      // Seed Questions for Assembly Quiz
      await pool.query(`
        INSERT INTO questions (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
        VALUES 
        (${quizId2}, 'Which assembly constraint in CATIA aligns the centerlines or axes of two cylindrical components?', 'Contact Constraint', 'Coincidence Constraint', 'Offset Constraint', 'Fix Constraint', 'B'),
        (${quizId2}, 'What is the file extension of a multi-component structure assembly in CATIA V5?', '.catpart', '.catprocess', '.catproduct', '.catdrawing', 'C'),
        (${quizId2}, 'Which DMU tool inside CATIA is used to check for spacing overlaps or material penetrations between assembly components?', 'BOM Analyzer', 'Clash and Clearance Analysis', 'Explode Manager', 'Compass Manipulator', 'B')
      `);
      console.log('🌱 Seeded questions for Assembly Assessment');
    } else {
      console.log('ℹ️ Assembly Assessment already exists.');
    }

    console.log('🎉 Database verification and seeding complete!');

  } catch (err) {
    console.error('Error seeding database:', err);
  } finally {
    await pool.end();
  }
}

seed();
