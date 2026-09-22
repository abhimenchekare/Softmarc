# Softmarc — 60-second guide

## RUN ON YOUR PC (test, edit content)
1. Start **MySQL** (XAMPP / WAMP control panel → Start).
2. In the folder with `server.js`, make a file named exactly **`.env`**:
   `DB_HOST=127.0.0.1` `DB_PORT=3306` `DB_NAME=softmarc` `DB_USER=root` `DB_PASS=`
   (empty password = XAMPP default).
3. phpMyAdmin → create database **softmarc** → SQL tab → paste `MYSQL_MIGRATION.sql` → Go.
4. `node server.js` → open http://localhost:3000
   Then: `node set-admin-password.js` -> paste the UPDATE line it prints into phpMyAdmin.
   Terminal must show `[DB] MySQL connected`. If not, read the `[DB]` line — it now names the problem.

## RUN ON THE CLOUD (real users)
1. hPanel → **MySQL** → create database + user (password = letters/numbers only) → note the `uXXXXXX_` prefixes.
2. phpMyAdmin (hosted) → select that DB → SQL tab → paste `MYSQL_MIGRATION.sql` → Go.
3. Upload code: push the folder to GitHub (keep `server.js`, `package.json`, `.npmrc`, all `.html`/`.js`/`.css`, `favicon.png`, `logo.png`, `brand-bg.mp4`, `vendor/`; do NOT upload `.env`, `node_modules`, `.env.local`).
4. hPanel → **Node.js** → Environment Variables → add:
   `DB_HOST=127.0.0.1` `DB_PORT=3306` `DB_NAME=uXXXXXX_softmarc` `DB_USER=uXXXXXX_admin` `DB_PASS=…` → **Save** → **Restart App**.
5. Open `https://softmarcedu.in/api/health?v=1` → must say `"status":"ok"`.
   If it says `missing_env` → step 4 not saved/restarted. If `Access denied` → wrong DB password/user in MySQL.
6. Login fails with "Invalid email or password"? Run `node set-admin-password.js`, paste its UPDATE
   line into hosted phpMyAdmin (see `RESET_ADMIN.sql`), then sign in with the password you typed.

## IMPORTANT
Your PC database and the cloud database are **separate**. Content made on the PC is not on
the cloud until you run the same SQL there (or add it again in the admin panel).
Never upload `server-local.js` or `.env.local` to the cloud.

## Security (v23)
Admin/student APIs now require a signed session token, so a stranger with the URL cannot
read learner data or change content. Deploy `server.js` + `softmarc-auth.js` +
`softmarc-common.js` + all pages in ONE push, or the site answers 401 for everyone.
Details and a 5-minute self-audit: `SECURITY.md`.

## Pushing to GitHub (safety notes)
- Only `server.js` affects the live site; the rest are documents/templates.
- `server.js` now also blocks `*.md` over HTTP, so pushing these guides cannot leak the
  default admin credentials (`*.sql`, `package.json`, `.env*` were already 403-blocked).
- No new npm packages were added, no table is renamed or deleted — an existing cloud
  database keeps working as is.
