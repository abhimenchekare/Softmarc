# "I uploaded server.js but /api/health still looks the same"

## 1. Read the SHAPE of the JSON — that is the version stamp
The old API and the new API answer the same question differently:

**OLD server.js (pre-v21)** — exactly 3 fields:
```json
{"status":"error","error":"Access denied for user 'root'@'localhost' (using password: NO)","hint":"Check DB environment variables"}
```
**NEW server.js (v21+)** — 5 fields, and the hint spells out the fix:
```json
{"status":"error","error":"…","db_target":"root@localhost:3306/(none)","missing_env":["DB_HOST","DB_NAME","DB_USER"],"hint":"Database settings are not loaded by the Node app — missing: … hPanel → Node.js configuration → Environment Variables … RESTART APP …"}
```

If you still see the 3-field answer, the **process in memory is still the old file**.
Uploading a file never restarts Node. Go to hPanel → Websites → **Node.js** →
**Restart App**, then reload `https://softmarcedu.in/api/health?v=1`.

## 2. Confirm the file on the server (SSH or hPanel → File Manager)
```bash
cd /home/uXXXXXX/domains/softmarcedu.in/hbuilds/versions/<uuid>/nodejs
grep -c "Cannot start" server.js     # 0 = old file, 1 = new file is there
node -e "console.log(process.env.DB_HOST, process.env.DB_USER, process.env.DB_NAME)"
```
(`.env.local` / `MYSQL_MIGRATION.sql` are served as **403 Forbidden** over HTTP by design,
so `curl https://softmarcedu.in/server.js` returning 403 is the security guard working.)

## 3. If the file is new but you deployed from GitHub
Hostinger builds a **fresh copy** of the repo into `hbuilds/versions/<uuid>/`.
Files placed there by hand are deleted on the next Redeploy. Two options:
- **Panel env vars only** (recommended): they are stored by the platform, not in the build.
- Or commit a file named exactly `.env` and remove `.env` from `.gitignore` + `.env*`
  from the Node.js "Files to ignore" list. (Weaker: the secret sits in your repo.)

## 4. If you tested on your own laptop
`server.js` on a laptop has no MySQL to talk to — the error is expected and says nothing
about the live site. Local demo: `npm run local`.

## 5. The actual bug you are chasing is env vars, not the upload
No version of `server.js` can log anybody in while `DB_HOST/DB_NAME/DB_USER` are unset.
Set them → Restart App → `/api/health` must say `"status":"ok"` → *then* try
admin login; if it then says "Invalid email or password", run `RESET_ADMIN.sql`
in phpMyAdmin.
