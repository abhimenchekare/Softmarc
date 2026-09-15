-- ============================================================
-- Softmarc Supabase Migration: Add Profile Fields to users table
-- Run this in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ============================================================

-- 1. Ensure users table exists (if you ran old schema, this is safe)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'student',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Add new profile columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS institution TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT; -- base64, up to ~4MB. For better perf use Supabase Storage.

-- Optional: additional fields you might want later
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 3. Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4. Test: check columns
SELECT column_name, data_type FROM information_schema.columns WHERE table_name='users';

-- 5. Test data: view all users with new fields
SELECT id, full_name, email, role, phone, department, institution, city, 
       CASE WHEN avatar_image IS NOT NULL THEN 'has avatar' ELSE 'no avatar' END as avatar_status,
       created_at FROM users LIMIT 10;

-- ============================================================
-- If your users table is empty, seed an admin + student (password: admin123 / student123)
-- ============================================================
-- INSERT INTO users (full_name, email, password_hash, role) VALUES
-- ('Admin', 'admin@softmarc.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyNiLXC6lvrJ2', 'admin'),
-- ('Test Student', 'student@softmarc.com', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyNiLXC6lvrJ2', 'student')
-- ON CONFLICT (email) DO NOTHING;
