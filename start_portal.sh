#!/bin/bash
echo "=========================================="
echo "🚀 AUTOMATED PORTAL STARTUP SCRIPT"
echo "=========================================="

# 1. Install PostgreSQL and PostgreSQL-contrib
echo "📦 Installing PostgreSQL..."
sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib

# 2. Start PostgreSQL service
echo "🔌 Starting PostgreSQL service..."
sudo /etc/init.get/postgresql start || sudo service postgresql start || sudo systemctl start postgresql

# Fallback: if those fail, try pg_ctlcluster
if ! pg_isready; then
  echo "⚠️ Service start failed. Trying pg_ctlcluster..."
  sudo pg_ctlcluster 17 main start || sudo pg_ctlcluster 15 main start || sudo pg_ctlcluster 16 main start
fi

# 3. Configure postgres user password
echo "🔑 Setting PostgreSQL password..."
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres123';"

# 4. Create database softmarc if not exists
echo "🗄️ Checking database..."
sudo -u postgres psql -t -A -c "SELECT 1 FROM pg_database WHERE datname='softmarc'" | grep -q 1
if [ $? -ne 0 ]; then
  echo "🆕 Creating softmarc database..."
  sudo -u postgres psql -c "CREATE DATABASE softmarc;"
else
  echo "✅ Database softmarc already exists."
fi

# 5. Create users table if not exists
echo "📐 Checking users table..."
sudo -u postgres psql -d softmarc -t -A -c "SELECT 1 FROM information_schema.tables WHERE table_name='users'" | grep -q 1
if [ $? -ne 0 ]; then
  echo "🆕 Creating users table..."
  sudo -u postgres psql -d softmarc -c "
  CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'student' CHECK (role IN ('student', 'admin')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );"
else
  echo "✅ Table users already exists."
fi

# Create quizzes, questions, and submissions tables if they do not exist
echo "📐 Checking quizzes, questions, and submissions tables..."
sudo -u postgres psql -d softmarc -t -A -c "SELECT 1 FROM information_schema.tables WHERE table_name='quizzes'" | grep -q 1
if [ $? -ne 0 ]; then
  echo "🆕 Creating quizzes table..."
  sudo -u postgres psql -d softmarc -c "
  CREATE TABLE quizzes (
      id SERIAL PRIMARY KEY,
      course_name VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );"
fi

sudo -u postgres psql -d softmarc -t -A -c "SELECT 1 FROM information_schema.tables WHERE table_name='questions'" | grep -q 1
if [ $? -ne 0 ]; then
  echo "🆕 Creating questions table..."
  sudo -u postgres psql -d softmarc -c "
  CREATE TABLE questions (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
      question_text TEXT NOT NULL,
      option_a VARCHAR(255) NOT NULL,
      option_b VARCHAR(255) NOT NULL,
      option_c VARCHAR(255) NOT NULL,
      option_d VARCHAR(255) NOT NULL,
      correct_option CHAR(1) CHECK (correct_option IN ('A', 'B', 'C', 'D')) NOT NULL
  );"
fi

sudo -u postgres psql -d softmarc -t -A -c "SELECT 1 FROM information_schema.tables WHERE table_name='student_submissions'" | grep -q 1
if [ $? -ne 0 ]; then
  echo "🆕 Creating student_submissions table..."
  sudo -u postgres psql -d softmarc -c "
  CREATE TABLE student_submissions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      student_name VARCHAR(255) NOT NULL,
      quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
      quiz_title VARCHAR(255) NOT NULL,
      answers JSONB NOT NULL,
      score INTEGER NOT NULL,
      submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );"
fi

# 6. Install dependencies
echo "📦 Installing Node dependencies..."
npm install

# 7. Seed database
echo "🌱 Seeding database..."
node seed.js

# 8. Start Express application server
echo "🚀 Starting Node server..."
npm start
