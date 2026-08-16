# Softmarc Admin — Setup Guide

This gives you a working "Add User / Delete User" admin panel backed by a real
Postgres database.

## 1. Install Postgres

**Windows / Mac:** download and run the installer from
https://www.postgresql.org/download/ — during setup it will ask you to set a
password for the `postgres` superuser. Remember it, you'll need it below.

**Mac (Homebrew) alternative:**
```
brew install postgresql@16
brew services start postgresql@16
```

**Linux (Ubuntu/Debian):**
```
sudo apt update
sudo apt install postgresql
sudo systemctl start postgresql
```

## 2. Create the database

Open a terminal and run:
```
psql -U postgres
```
Enter the password you set during install, then inside the `psql` prompt run:
```sql
CREATE DATABASE softmarc;
\q
```

## 3. Create the `users` table

From the folder containing `schema.sql`, run:
```
psql -U postgres -d softmarc -f schema.sql
```
This creates the `users` table (name, email, password hash, role, created date).

## 4. Configure the API server

1. Copy `.env.example` to a new file named `.env`
2. Open `.env` and set `PGPASSWORD` to the password you chose in step 1
   (leave the other values as-is unless your setup differs)

## 5. Install and run the server

You'll need [Node.js](https://nodejs.org) installed. Then, from this folder:
```
npm install
npm start
```
You should see:
```
Softmarc admin API running on http://localhost:4000
```
Leave this running in its own terminal window.

## 6. Open the admin page

Open `admin.html` in your browser (double-click it, or drag it into a browser
window). It will automatically load, add, and delete users through the
server you just started.

## Files in this folder

| File | Purpose |
|---|---|
| `schema.sql` | Creates the `users` table |
| `server.js` | Express API — list, add, delete users |
| `package.json` | Node dependencies |
| `.env.example` | Template for your database credentials |
| `admin.html` | The admin page itself |

## Important security note

This is a working starting point, not a production-hardened system. Before
using it with real student data:

- **Add authentication** — right now `admin.html` and the API endpoints are
  open to anyone who can reach them. Add a login check (e.g. only allow
  requests from a logged-in admin session) before deploying.
- **Use HTTPS** in production so passwords aren't sent in plain text over
  the network.
- **Keep `.env` out of version control** — it contains your database password.
