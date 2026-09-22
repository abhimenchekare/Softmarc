# Run Softmarc Locally

## Quick Start (No MySQL needed!)

### Step 1: Install Dependencies
```bash
cd hostinger-mysql-ready
npm install
```

### Step 2: Run the LOCAL server (SQLite)
```bash
npm run local          # = node server-local.js  (SQLite file softmarc.db)
```
First run prints a one-off admin password for the demo (shown once in your terminal only),
or choose it yourself: `ADMIN_PASSWORD=yourchoice npm run local`
(Windows PowerShell: `$env:ADMIN_PASSWORD="yourchoice"; npm run local`).
**You do not have to install a database.** On Node 22.5+ (including Node 24 LTS) the demo uses the
SQLite that is built into Node itself. `better-sqlite3` is only the preferred engine; when npm has not
built it — for example after `npm install` prints

```
npm warn install-scripts   better-sqlite3@11.10.0 (install: prebuild-install || node-gyp rebuild --release)
```

or when you upgraded Node — you will see one line like
`[DB] better-sqlite3 not usable (Could not locate the bindings file …)` followed by
`[DB] Using the SQLite built into Node 24.x — the demo works exactly the same.`
**That is not an error.** The site, the login and all data behave identically; `softmarc.db` is still the file used.

If you are on Node 20 or older there is no built-in SQLite, so finish that one module:
```bash
npm install-scripts approve better-sqlite3
npm install
```
(or install Node 22.5+/24 — then no build step is needed at all.)
```bash
# equivalent, if you prefer typing it out
node server-local.js
```

> ⚠ **Do NOT run `node server.js` on your laptop.** `server.js` is the
> production API: it only speaks MySQL and reads `DB_HOST/DB_NAME/DB_USER/DB_PASS`.
> It ignores `DB_TYPE`/`DB_FILE` entirely and, without `DB_*` settings, it now stops with
> `[DB] Cannot start: DB_HOST, DB_NAME, DB_USER are not set.` — that message
> just means "this process has no database env vars", nothing is broken.
> If it happens anyway, v21+ prints the reason in the terminal:
> `[DB] Cannot start: DB_HOST, DB_NAME, DB_USER are not set.`

### What the local demo now includes (same behaviour as the cloud site)
`server-local.js` was extended to answer every endpoint the pages call, so testing on
localhost is representative: `/api/config` (plus the `.php` alias), `/api/steps` with the
**same sequential lock rules** (video → pdf → mcq → exercise; out-of-order writes are refused
with 403), `/api/time` (hours logged + day streak) and `/api/analytics/summary` (the admin
Analytics page). Checked against a real SQLite database: **27/27** assertions pass — including
"video at 40% refused", "pdf before video refused", hours summing to 3.2, and the analytics
series zero-filling 7 days.

The one thing local SQLite is *not*: a copy of your website's data. It writes `softmarc.db`
on your PC only, so courses/content you see on the cloud site won't be there. To test with the
real content, use the MySQL setup below.

### Using your OWN MySQL locally (phpMyAdmin / XAMPP) — two steps
1. Create a database in phpMyAdmin named `softmarc`, then open its **SQL** tab,
   paste the whole `MYSQL_MIGRATION.sql`, press **Go** (this also creates the admin:
   `admin@softmarc.com` row with a placeholder hash).
2. Make a file named exactly **`.env`** (not `.env.local`!) in the same folder as
   `server.js`, containing:
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=softmarc
DB_USER=root
DB_PASS=
```
`DB_PASS=` stays empty for XAMPP's default root. If your MySQL root has a password, put it there.
A template is in `.env.example` — copy and rename it.

Then start it:
```bash
node server.js
```
Terminal must print `[DB] target root@127.0.0.1:3306/softmarc` then `[DB] MySQL connected`.
If it still says `Cannot start`, your `.env` is in a different folder than `server.js`,
or is named `.env.txt` / `.env.local` (Windows hides the `.txt` — enable file extensions).

### Step 3: Open in Browser
- Website: http://localhost:3000
- Health Check: http://localhost:3000/health (server-local.js answers this)

---

## Admin Login

| Field | Value |
|-------|-------|
| Email | `admin@softmarc.com` |
| Password | whatever `node set-admin-password.js` gave you (or your `ADMIN_PASSWORD` for the demo) |

---

## How It Works

- **Local Testing**: Uses SQLite database (no MySQL installation needed)
- **Hostinger Production**: Uses MySQL database automatically

The same code works for both! Just change `DB_TYPE` environment variable.

---

## Environment Variables (local only)

`server-local.js` accepts:
```env
DB_FILE=./softmarc.db   # SQLite file location
PORT=3000
```
For **production** (`server.js`) the only env vars that matter are
`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASS` — see SETUP_GUIDE.md.

---

## Troubleshooting

### `npm start` says "[DB] Cannot start: DB_HOST, DB_NAME, DB_USER are not set."
That is deliberate — `server.js` (the cloud file) only talks to MySQL and refuses to run half-configured.
For testing on your own PC you do **not** need MySQL at all:

```bash
npm install          # once, in this folder
npm run local        # the demo: SQLite file softmarc.db, no MySQL, no .env edits
```
Open the address it prints. If that copy is already running in another window, close it first.

### Port already in use
The app now prints this instead of a stack trace: `[Port] Port 4000 is already in use…`
Use the port number from your message in place of `3000` below.
```bash
# Find and kill process on port 3000
# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Mac/Linux:
lsof -i :3000
kill -9 <PID>
```

### Database reset
Delete `softmarc.db` file and restart server.
