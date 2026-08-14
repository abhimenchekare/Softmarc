-- Softmarc CAD Learning Portal — database schema
-- Run this once against a fresh database:
--   psql -U postgres -d softmarc -f schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(120) NOT NULL,
  email         VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'student'
                CHECK (role IN ('student', 'admin')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Speeds up email lookups on login
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
