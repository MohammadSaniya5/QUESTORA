# QUESTORA – setup (step by step)

## 1. Install Node.js
Download the LTS version from https://nodejs.org (v18 or newer), install it, then open a terminal and check: `node -v`

## 2. Unzip and open the folder
Unzip `questora.zip`. In the terminal: `cd questora`

## 3. Install
`npm install`

## 4. (Optional) choose your admin login
Mac/Linux:  `export ADMIN_EMAIL=you@college.edu ADMIN_PASSWORD='ChooseAStrongOne1!' SESSION_SECRET=any-long-random-text`
Windows PowerShell:  `$env:ADMIN_EMAIL="you@college.edu"; $env:ADMIN_PASSWORD="ChooseAStrongOne1!"; $env:SESSION_SECRET="any-long-random-text"`
If you skip this, the admin is `admin@questora.local` / `Admin@12345`. Change it before real use.
The admin is created only the first time the server runs (when the database file is new).

## 5. Run
`npm start`  then open
- Students: http://localhost:3000
- Admin:    http://localhost:3000/admin   (type this address yourself; there is no link to it in the student site)

## 6. Try it
1. Student site → Create account → Sign in → Start examination → answer → Finish.
2. Admin site → sign in → Question Bank / Live Monitoring / Leaderboard / Rewards & Settings.

## Making it the full 30-question / 30-minute exam
The seed bank has only 14 questions (10-question, 10-minute exam). In Admin:
1. Question Bank → add or bulk-import questions (at least 15 Quantitative, 8 Maths, 4 Physics, 3 Chemistry).
2. Rewards & Settings → set 15 / 8 / 4 / 3 and duration 1800 → Save.

## Put it online
Run it on any Node host (Render, Railway, a VPS) with `NODE_ENV=production`, set `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, serve over HTTPS, and keep `questora.db` on persistent disk.

## What is different from the original spec (honest list)
- SQLite + Express instead of PostgreSQL/Prisma/Next.js/Supabase (runs with zero setup; schema is in `server.js`).
- Live monitoring refreshes every 3 seconds instead of Supabase Realtime.
- Admin charts are simple bar charts, not Recharts. No Lottie, no automated test suite, no profile photos.
- Correctness of a question is shown to the student only after they lock that answer; unanswered questions never expose answers.
- Rate limiting is in-memory and resets when the server restarts.
