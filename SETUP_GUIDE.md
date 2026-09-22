# 🚀 Hostinger MySQL Setup Guide

## STEP 1: Create MySQL Database in Hostinger

1. Login to **Hostinger hPanel**
2. Go to **Databases** → **MySQL Databases**
3. Create new database:
   - Database Name: `softmarc`
   - Username: `softmarc_admin`
   - Password: (create a strong password)
4. **Copy these details** — you'll need them!

```
Database Host: 127.0.0.1     <-- ALWAYS 127.0.0.1, never "localhost" (IPv6 fail)
Database Name: u346236540_softmarc   (Hostinger prefixes it with uXXXXXX_)
Database User: u346236540_admin
Database Password: your-password     <-- letters + numbers only; % $ ! & break env parsing
Port: 3306
```

---

## STEP 2: Run SQL Migration

1. In hPanel → **Databases** → **phpMyAdmin**
2. Select your database (`u346236540_softmarc`)
3. Click **SQL** tab
4. Copy and paste the content of `MYSQL_MIGRATION.sql`
5. Click **Go**

---

## STEP 3: Set Environment Variables

1. hPanel → **Websites** → your site → left menu **Node.js** (the app screen, not the Git screen)
2. Open **Environment Variables** (on some plans it is inside **Configuration / Edit application**)
3. Add these (one row each):

| Variable | Value |
|----------|-------|
| `DB_HOST` | `127.0.0.1` |
| `DB_PORT` | `3306` |
| `DB_NAME` | `u346236540_softmarc` |
| `DB_USER` | `u346236540_admin` |
| `DB_PASS` | `your-database-password` |

4. Press **Save**, then **Restart App** (⋮ menu). Saving alone does **not** reload the
   environment — and a **Redeploy** wipes `hbuilds/versions/<uuid>/nodejs/`, so anything
   you uploaded there by hand (including a `.env`) disappears on the next deploy.
   Only this panel survives redeploys.

---

## STEP 4: Update Your GitHub Repo

Replace these files in your repo:

### 1. Replace `package.json`
Use the one I created (uses `mysql2` instead of `pg`)

### 2. Replace `server.js`
Use the one I created (connects to MySQL instead of PostgreSQL)

### 3. Delete these files (not needed):
- `vercel.json`
- `.env` (if exists)

### 4. Push to GitHub:
```bash
git add .
git commit -m "Switch to MySQL for Hostinger"
git push
```

---

## STEP 5: Redeploy (only if you changed code)

1. Push `server.js` to GitHub → in the Node.js screen press **Redeploy**
   (or wait for the auto-deploy) and let the build finish.
2. Visit `https://softmarcedu.in/api/health?v=1` (the `?v=1` dodges CDN cache)

Expected, when connected:
```json
{ "status": "ok", "time": "2026-09-21 12:00:00", "user_count": 3, "course_count": 5, "message": "All tables exist" }
```

If it is still an error, **read which fields come back** — that tells you which side
is wrong (v21+ only):
| What you see | Meaning |
|---|---|
| `"missing_env": [...]` + `"db_target": "root@localhost…"` | env vars did not reach the process → Save + **Restart App** |
| `"db_target": "u…_admin@127.0.0.1:3306/u…_softmarc"` + `Access denied` | MySQL user password/grant wrong → hPanel → MySQL → change password |
| same + `ECONNREFUSED` | MySQL server stopped → start it in hPanel → MySQL |
| old JSON with only `status`/`error`/`hint` | **the running server.js is still the previous version** → deploy/restart did not happen |

---

## STEP 6: Create Admin User

After migration, create your admin user:

```bash
curl -X POST https://softmarcedu.in/api/users \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Admin","email":"admin@softmarcedu.in","password":"your-password","role":"admin"}'
```

Or use phpMyAdmin to insert directly.

---

## File Changes Summary

| File | Action |
|------|--------|
| `server.js` | **Replace** — Uses mysql2 instead of pg |
| `package.json` | **Replace** — mysql2 dependency instead of pg |
| `MYSQL_MIGRATION.sql` | **New** — Run in phpMyAdmin |
| `vercel.json` | **Delete** — Not needed |
| `.env` | **Delete** — Use Hostinger env vars instead |
