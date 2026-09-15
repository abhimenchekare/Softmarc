# Fix: Profile Data Not Saving to Supabase (Vercel + GitHub)

Your site works but profile page only used `localStorage`, so data never reached Supabase.
I have fixed it: **server.js** now has profile endpoints + Supabase link, **profile.html** now reads/writes to Supabase.

---

## What was wrong?
1. **No columns in Supabase**: `users` table only had `full_name, email, password_hash, role`. No `phone, department, institution, city, avatar_image`.
2. **profile.html never called API**: It only did `localStorage.setItem('softmarc_user', ...)` – so after refresh on another device, data was gone, and Supabase Table Editor showed nothing.
3. **Vercel env vars**: If you only set `PGHOST` etc but not `DATABASE_URL`, Supabase Pooler connection can fail on Vercel (needs SSL). New `server.js` now supports both.

---

## Step-by-Step Fix

### 1. Run Migration in Supabase
Go to **Supabase Dashboard → Your Project → SQL Editor → New Query**
Copy-paste contents of `supabase_migration.sql` and click **Run**.

This will run:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS institution TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT;
```

Check **Table Editor → users** – you should see the new columns.

### 2. Set Environment Variables in Vercel
Go to **Vercel Dashboard → Your Project → Settings → Environment Variables**

You need **ONE** of these two options:

**Option A (Recommended for Supabase):**
- `DATABASE_URL` = your Supabase connection string
  Find it in Supabase → Project Settings → Database → Connection String → URI (Use Pooler, port 6543, with `?pgbouncer=true`)
  Example: `postgres://postgres.xxx:YOUR_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`

**Option B (Old PG* vars):**
- `PGHOST` = `aws-0-ap-south-1.pooler.supabase.com`
- `PGPORT` = `6543`
- `PGDATABASE` = `postgres`
- `PGUSER` = `postgres.xxxxx`
- `PGPASSWORD` = your password
- `NODE_ENV` = `production`

Add them, then **Redeploy** in Vercel → Deployments → Redeploy.

### 3. Test the API Link
After redeploy, open:
`https://your-site.vercel.app/api/health`

You should see:
```json
{ "status":"ok", "time":"...", "user_count": 5 }
```
If you see error, your DATABASE_URL / PGPASSWORD is wrong.

### 4. Update Your GitHub Repo
Replace in your repo:
- `server.js` (new version with `/api/users/:id` and `/api/users/:id/profile`)
- `profile.html` (new version that calls Supabase)
- `api/index.js` (new file – makes Vercel routing work)
- `vercel.json` (new simplified routes)
- Add `supabase_migration.sql` for reference

Git push → Vercel will auto-deploy.

### 5. Verify in Supabase
1. Login to your site → Go to Profile → Fill phone, department, institution, city → Click **Save Changes to Supabase**
2. You should see toast: **"✅ Profile saved to Supabase Postgres!"**
3. Go to Supabase → Table Editor → users → your row now has phone, etc.
4. Upload a photo (<2MB) → It saves as base64 TEXT. For production, consider Supabase Storage instead (better).

---

## New Endpoints Added
- `GET /api/users/:id` – get single profile (Supabase → frontend)
- `PUT /api/users/:id/profile` – update profile fields
- `PUT /api/users/:id/avatar` + `DELETE /api/users/:id/avatar` – avatar handling
- `GET /api/health` – debug Supabase connection
- `GET /api/users` now returns phone, department, institution, city, avatar_image
- `POST /api/login` now returns those fields too, so localStorage stays synced

---

## Common Pitfalls
- **Payload too large**: Vercel has 4.5MB limit. Base64 avatar > 2MB will fail. New code limits to 3MB and shows error. Compress images first.
- **Avatar column TEXT too small**: In Postgres, TEXT is unlimited, but if you used VARCHAR(255) before, change to TEXT.
- **Old localStorage data**: After first load, new profile.html auto-merges Supabase data into localStorage, so old local data is overwritten by DB truth.

Done! Now profile is truly linked to Supabase.
