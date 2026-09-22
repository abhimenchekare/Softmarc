# Softmarc — "Access denied for user 'root'@'localhost' (using password: NO)"

## What it means
This error is **not** a password problem and **not** a code problem. It is the
server saying: *"nobody told me which database to use, so I knocked on MySQL's
default door (user `root`, host `localhost`, empty password) and was turned away."*

`server.js` reads its database settings **only from environment variables**:

| Variable | Your Hostinger value | Notes |
|---|---|---|
| `DB_HOST` | `127.0.0.1` | **must be 127.0.0.1, not localhost** (localhost resolves to IPv6 and fails) |
| `DB_PORT` | `3306` | optional, this is the default |
| `DB_NAME` | `softmarc_db` | exact name from hPanel → MySQL Management |
| `DB_USER` | `softmarc_admin` | MySQL *user*, not your hPanel login |
| `DB_PASS` | (your MySQL user password) | **avoid special characters** — `% $ ! &` in the password break env parsing |

If **any** of `DB_HOST`, `DB_NAME`, `DB_USER` is missing, the app now refuses to
guess and prints exactly which one is missing.

## Where to put them (Hostinger)
1. hPanel → **Websites** → softmarcedu.in → left menu **Node.js** (under "Advanced"/hbuilds).
2. Open **Environment Variables** (sometimes inside the app's *Configuration* / *Edit* panel).
3. Add the 5 rows above → **Save**.
4. **Restart App** (⋮ menu → Restart, or Save & Restart). Saving alone does nothing.
5. Open `https://softmarcedu.in/api/health` → you want
   `{"status":"ok","user_count":N,...}`.

## Alternative: a `.env` file
Create a file named **exactly `.env`** (not `.env.local`) next to `server.js`:

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=softmarc_db
DB_USER=softmarc_admin
DB_PASS=yourmysqlpassword
DATA_DIR=/home/u123456/domains/softmarcedu.in/data
```

**⚠ GitHub users read this:** the repo's `.gitignore` contains `.env`, and
Hostinger's Node.js settings list *"Files to ignore"* usually contains `.env*`.
So a `.env` you push to GitHub **will never reach the server**. Either upload the
`.env` directly in **hPanel → File Manager** into
`/home/uXXXXXX/domains/softmarcedu.in/hbuilds/versions/<uuid>/nodejs/`
(that folder is replaced on every deploy — re-upload after deploys), **or** just use
the Environment Variables panel above, which survives redeploys. Prefer the panel.

## If you are running this on YOUR OWN COMPUTER (no GitHub, no cloud)
`server.js` needs *some* MySQL to talk to and reads its settings from **only one place:
a file named exactly `.env` in the same folder as `server.js`**. `require('dotenv')` is
pinned to that path (v22), so a `.env.local` sitting there is deliberately ignored —
that is why `127.0.0.1` in `.env.local` changes nothing.

Pick ONE of these two:

**A. Use your local MySQL (phpMyAdmin / XAMPP / WAMP) — real data, same code as the server**
1. phpMyAdmin → Databases → create `softmarc` (utf8mb4).
2. Select it → **SQL** tab → paste all of `MYSQL_MIGRATION.sql` → **Go**.
   It also inserts the admin row, whose hash is an unusable placeholder on purpose.
3. Copy `.env.example` to `.env` in the `server.js` folder, keep the "A" block:
   `DB_HOST=127.0.0.1` `DB_PORT=3306` `DB_NAME=softmarc` `DB_USER=root` `DB_PASS=`
   (XAMPP's root password is empty → leave `DB_PASS=` blank.)
4. `node server.js` → terminal must print `[DB] target root@127.0.0.1:3306/softmarc`
   and `[DB] MySQL connected`. Then http://localhost:3000 works and `/api/health` says `"status":"ok"`.

**B. Use the built-in SQLite demo — nothing to install**
```bash
npm run local        # runs server-local.js, creates softmarc.db next to it
```
Note: data saved in mode B lives in `softmarc.db` **on your PC only**; it is not the
cloud database, and pushing to GitHub later will not carry it. Content you create in
the admin panel while testing locally is therefore local-only unless you use mode A
against the hosted MySQL (DB_HOST `127.0.0.1` = the *machine's own* MySQL: it means
the host running the Node app, so it works on your laptop and on Hostinger alike).

## Still erroring after setting env vars?
Read the new fields the API now returns from `/api/health`:

- `"missing_env": ["DB_PASS"]`-style list → the panel value didn't reach the app:
  you forgot Restart, or you edited a different app version folder.
- `db_target` shows `root@localhost` → env vars are **not** loaded (same as above).
- `db_target` shows `softmarc_admin@127.0.0.1:3306/softmarc_db` and still
  `Access denied` → the MySQL user/password or its grant is wrong:
  hPanel → MySQL → **Change password** for `softmarc_admin`, then confirm the user
  is listed under that database `softmarc_db`.
- `ECONNREFUSED 127.0.0.1:3306` → MySQL server is stopped: hPanel → MySQL → start it.
- `ER_NOT_SUPPORTED_AUTH_MODE` → recreate the MySQL user (Hostinger's default
  `mysql_native_password` works with mysql2).

## Admin password
The seed row in `MYSQL_MIGRATION.sql` intentionally carries an unusable placeholder hash, and
no document in this package contains a working password — so nothing is leaked by reading the
repo or downloading the site. Set yours with `node set-admin-password.js` (hidden prompt, prints
one SQL line) or, if you can already sign in, Settings → Change password. Passwords under 8
characters and obvious ones like the old demo default are refused by the server.
