-- ============================================================
-- Softmarc: set / reset the admin password with one nobody else knows
-- Run in Hostinger phpMyAdmin (select softmarc_db -> SQL tab). Nothing to upload.
-- ============================================================

-- 1. Which admin accounts exist? (hash_len must be 60 for a usable one; the
--    placeholder above is 61 chars and can never sign in — that is intentional)
SELECT id, full_name, email, role, LEFT(password_hash,7) AS hash_prefix,
       LENGTH(password_hash) AS hash_len, created_at
FROM users WHERE role='admin' ORDER BY id;

-- 2. On your own PC, in the project folder, type your new password when asked
--    (it is hidden and never written to any file or command history):
--        node set-admin-password.js
--    It prints an UPDATE line that already contains YOUR hash — paste it here:

-- UPDATE users SET password_hash = 'PASTE-YOUR-OWN-BCRYPT-HASH-HERE' WHERE email = 'admin@softmarc.com';

-- 3. If no admin row exists at all, the same script also prints the INSERT line.

-- 4. Sign in on the website with that password. If you are already able to sign in,
--    skip steps 2-3: Settings -> Change password does the same job, and the new
--    password goes straight into the database — it never appears in a file or chat.
