# Softmarc — what is locked, and what you must set

## v23 changes in one line
Every admin/student API endpoint now needs a signed session token that the browser
gets from `/api/login`; anonymous visitors and other learners can no longer read or
change anything.

## Locked now (server-side, not just hidden in CSS)
| What | Who may use it |
|---|---|
| `GET /api/users`, `/api/submissions`, `/api/analytics/summary` | **admins only** |
| `POST/PUT/DELETE` courses, subtopics, quizzes, questions | **admins only** |
| `POST /api/upload` (putting files on your server) | **admins only**, and only `.mp4 .webm .m4v .mov / .pdf .ppt .pptx / .png .jpg .jpeg .webp .gif` |
| `POST /api/config` (unlock thresholds) | **admins only** |
| `DELETE /api/users/<id>` | admin, or the owner closing their own account |
| `/api/progress`, `/api/time`, `/api/steps`, quiz submit, `/api/users/<id>…` | only your **own** id (admins may act for anyone) |
| everything else under `/api/*` | needs a valid token |
| `*.sql *.md *.json *.db *.env *.log *.sh server.js` over HTTP | **403 Forbidden** |
| `/api/login` | public, but 8 wrong tries per 10 min per email+IP → `429` |
| `/api/health` | public "is it up"; DB host/user/errors only with `HEALTH_VERBOSE=1` or an admin token |
| Iframes from other sites, `Access-Control-Allow-Origin: *` | removed — `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, HSTS behind https |

Still public on purpose: `GET /api/courses`, `GET /api/quizzes…`, `GET /api/config`,
`/videos /pdfs /images` file URLs (the lesson player and PDF viewer need them),
and the HTML pages themselves.

## Deploy these together — one GitHub push, then Redeploy + Restart
`server.js`, `server-local.js`, `softmarc-auth.js`, `softmarc-common.js`
and **all 11 pages**: `index.html soft_dashboard.html courses.html lesson.html
assessments.html certificates.html profile.html settings.html admin.html
analytics.html view_certificate.html`.
If `server.js` goes up without the pages, the pages cannot present a token and
everything answers 401. That is the security working — but it looks like an outage.

## What your users will notice
Once, right after the deploy, everyone is asked to sign in again (their device had no
token yet). Sessions then last 12 hours by default.

## Optional settings (hPanel → Node.js → Environment Variables)
| Variable | Default | Why you would set it |
|---|---|---|
| `AUTH_SECRET` | auto key in `DATA_DIR/.authkey` | Set a long random string if you prefer; keep it stable or all sessions end on redeploy. The auto file already survives redeploys. |
| `TOKEN_TTL_HOURS` | `12` | Session length. Lower = safer on shared PCs. |
| `ALLOW_ORIGINS` | *(none)* | Extra origins if you ever host the app on a second domain, e.g. `https://www.softmarcedu.in`. |
| `HEALTH_VERBOSE` | `0` | Temporarily `1` while debugging the database, then remove it. |
| `HTTPS` | on | Set `0` only if the site is ever served over plain http and HSTS annoys you. |

## Not magic — remaining honest risks
1. **No server-side revocation yet.** Tokens are signed, stateless, and expire by
   themselves. "Log out" clears the device; it cannot kill a token that was copied.
   A sessions table (next sprint) fixes that and brings forgot-password email at the
   same time.
2. **Uploaded files stay reachable by URL.** Anyone who guesses a video/PDF filename can
   open it. Names contain a timestamp + random part, so guessing is impractical, but a
   shared link is a shared link.
3. **Passwords are only as strong as they are.** bcrypt hashes are stored properly, so a
   DB leak is survivable — but there is still no email reset; a forgotten password needs
   an admin to change it (Settings → Change password, or `RESET_ADMIN.sql`).
4. **Client-side admin gating stays as decoration.** Real enforcement is now the server.
5. Keep `.env` out of GitHub (already gitignored) and never commit a real DB password.

## 5-minute self-audit after deploying
Open these in a logged-out private window and confirm the first four all say *sign in*:
```
https://softmarcedu.in/api/users
https://softmarcedu.in/api/analytics/summary?days=7
https://softmarcedu.in/api/submissions
https://softmarcedu.in/api/progress?student_id=1
https://softmarcedu.in/api/health          → {"status":"ok",…} and no db_target line
https://softmarcedu.in/package.json        → 403
https://softmarcedu.in/softmarc.db         → 403
```
Then sign in as a student and confirm Admin/Analytics links are gone and
`GET /api/users` still says "Admin access required".
