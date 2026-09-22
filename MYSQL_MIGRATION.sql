-- =============================================================
-- Softmarc: MySQL Migration for Hostinger
-- Run this in Hostinger phpMyAdmin or MySQL Database section
-- =============================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(20) DEFAULT 'student',
  phone           VARCHAR(50) DEFAULT NULL,
  department      VARCHAR(255) DEFAULT NULL,
  institution     VARCHAR(255) DEFAULT NULL,
  city            VARCHAR(255) DEFAULT NULL,
  avatar_image    LONGTEXT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 2. COURSES TABLE
CREATE TABLE IF NOT EXISTS courses (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  title           VARCHAR(500) NOT NULL,
  slug            VARCHAR(500) NOT NULL UNIQUE,
  tag             VARCHAR(100) DEFAULT 'Course',
  short_description TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  duration_hours  INT DEFAULT 10,
  level           VARCHAR(20) DEFAULT 'Beginner',
  image           TEXT DEFAULT '',
  status          VARCHAR(20) DEFAULT 'active',
  display_order   INT DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 3. SUBTOPICS TABLE
CREATE TABLE IF NOT EXISTS subtopics (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  course_id       INT NOT NULL,
  title           VARCHAR(500) NOT NULL,
  slug            VARCHAR(500) DEFAULT '',
  dur             VARCHAR(50) DEFAULT '15 min',
  description     TEXT DEFAULT '',
  video_url       TEXT DEFAULT '',
  pdf_url         TEXT DEFAULT '',
  exercise        TEXT DEFAULT '',
  display_order   INT DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- 4. QUIZZES TABLE
CREATE TABLE IF NOT EXISTS quizzes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  course_name     VARCHAR(500) DEFAULT '',
  title           VARCHAR(500) NOT NULL,
  course_id       INT NULL,                 -- which course this assessment belongs to
  module_index    INT NULL,                  -- unused by the quiz editor (a quiz belongs to the course); kept so older rows still load
  pass_pct        INT NOT NULL DEFAULT 60,   -- score needed to unlock the exercise step
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One assessment per subtopic: the app enforces this in the editor, the index just makes the
-- lookup cheap. Existing databases get these three columns automatically on first start.
CREATE INDEX idx_quizzes_topic ON quizzes (course_id, module_index);   -- helps the course-filtered quiz list

-- 5. QUESTIONS TABLE
CREATE TABLE IF NOT EXISTS questions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  quiz_id         INT NOT NULL,
  question_text   TEXT NOT NULL,
  option_a        VARCHAR(500) DEFAULT '',
  option_b        VARCHAR(500) DEFAULT '',
  option_c        VARCHAR(500) DEFAULT '',
  option_d        VARCHAR(500) DEFAULT '',
  correct_option  VARCHAR(5) DEFAULT '',
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

-- 6. STUDENT SUBMISSIONS TABLE
CREATE TABLE IF NOT EXISTS student_submissions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  student_id      INT DEFAULT NULL,
  student_name    VARCHAR(255) DEFAULT '',
  quiz_id         INT DEFAULT NULL,
  quiz_title      VARCHAR(500) DEFAULT '',
  answers         JSON DEFAULT NULL,
  score           INT DEFAULT 0,
  submitted_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. LESSON PROGRESS TABLE
CREATE TABLE IF NOT EXISTS lesson_progress (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  student_id      INT NOT NULL,
  course_name     VARCHAR(500) NOT NULL,
  module_index    INT NOT NULL,
  completed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_progress (student_id, course_name, module_index)
);

-- 8. Admin account (deliberately UNUSABLE until you set your own password).
--    This row makes sure an admin exists, but its hash can never match anything.
--    To activate it, run on your own PC:   node set-admin-password.js
--    and paste the single UPDATE line it prints into phpMyAdmin (SQL tab -> Go).
--    Nothing that documents a working password ships with this app, so nobody
--    can read a credential out of the repo, the docs, or a download of the code.
INSERT INTO users (full_name, email, password_hash, role) VALUES
('Admin User', 'admin@softmarc.com', 'PASTE-YOUR-OWN-BCRYPT-HASH-HERE-00000000000000000000000000000', 'admin')
ON DUPLICATE KEY UPDATE email=email;

-- =============================================================
-- DONE! All tables created.
-- =============================================================

-- =============================================================
-- v7/v8 addition: learning-path step tracking (video → pdf → mcq → ex)
-- The Node server also creates this table automatically on boot.
-- =============================================================
CREATE TABLE IF NOT EXISTS lesson_steps (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  student_id    INT NOT NULL,
  course_name   VARCHAR(500) NOT NULL,
  module_index  INT NOT NULL,
  step          VARCHAR(16) NOT NULL,
  pct           INT NOT NULL DEFAULT 100,
  completed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_step (student_id, course_name, module_index, step)
);

-- =============================================================
-- v10 addition: live time tracking (dashboard "Hours logged" card)
-- The Node server also creates this table automatically on boot.
-- =============================================================
CREATE TABLE IF NOT EXISTS user_time (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  day        DATE NOT NULL,
  seconds    INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_day (student_id, day)
);
