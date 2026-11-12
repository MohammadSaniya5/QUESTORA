# QUESTORA — Supabase + Vercel edition

This migration keeps the existing student and admin interfaces **byte-for-byte unchanged**:
- `public/index.html`
- `public/admin.html`

The Express API routes and response shapes are retained. SQLite is replaced by Supabase PostgreSQL. Vercel serves the existing HTML pages and runs the API as a serverless function.

## Architecture

- Frontend: the original HTML/CSS/JavaScript (unchanged).
- API: Express, deployed as a Vercel Function (`api/index.js`).
- Database: Supabase PostgreSQL, accessed only from the server with `pg`.
- Authentication: the existing signed, HttpOnly student/admin cookies are retained.
- Admin page: `/admin`; student page: `/`.

## 1. Create Supabase database

1. Create a project at https://supabase.com/dashboard.
2. Open **SQL Editor** → **New query**.
3. Paste the complete contents of `supabase-schema.sql`.
4. Click **Run** and confirm the tables are created.
5. Open **Project Settings → Database → Connection string**.
6. Select **Transaction pooler** and copy the URI. Use the pooler URL for Vercel/serverless deployment. Replace its password placeholder and keep it private.

The database tables are `profiles`, `questions`, `exam_attempts`, `attempt_questions`, `attempt_answers`, and `app_config`. Row Level Security is enabled; browser clients do not receive database credentials. The server connects using `DATABASE_URL`.

## 2. Configure locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in `DATABASE_URL`, a random `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
4. In PowerShell:

```powershell
npm install
npm run db:admin
npm run db:seed
npm start
```

5. Open:
   - Student: http://localhost:3000
   - Admin: http://localhost:3000/admin
   - API health: http://localhost:3000/api/health

The seed script adds 14 demonstration questions only when the question table is empty. The starter configuration is 10 questions / 10 minutes (5 Quant + 3 Maths + 1 Physics + 1 Chemistry). To run the full 30-question / 30-minute exam, add sufficient questions in Admin → Question Bank, then set the exam configuration in Admin → Rewards & Settings.

## 3. Deploy to Vercel

1. Push this folder to a new GitHub repository.
2. In Vercel, choose **Add New → Project** and import that repository.
3. Keep the project root as the repository root. Vercel detects the Node project.
4. In **Project Settings → Environment Variables**, add:
   - `DATABASE_URL` — Supabase Transaction Pooler URI
   - `SESSION_SECRET` — a long random secret (at least 32 characters)
   - `ADMIN_EMAIL` — your intended administrator email
   - `ADMIN_PASSWORD` — a strong administrator password
   - `NODE_ENV` — `production`
   - `PG_POOL_MAX` — `5`
5. Deploy.
6. Open the deployment URL. Test `/api/health`, student registration/login, exam, results and `/admin`.

`vercel.json` routes `/api/*` to the Express serverless function and `/admin` to the existing admin HTML file. The root `public/index.html` remains the student UI.

## 4. Important security notes

- Never put `DATABASE_URL`, database passwords, or `SESSION_SECRET` in browser JavaScript or `NEXT_PUBLIC_*` variables.
- Do not expose the Supabase `service_role` key. This project uses the server-side PostgreSQL connection string instead.
- Change the admin password before deployment.
- The existing signed-cookie login behavior is preserved to avoid changing the UI. Use HTTPS in production (Vercel provides it).
- The current rate limiter is in-memory; on serverless it is not globally shared. For production-scale abuse protection, move rate limiting to a shared store.
- Admin monitoring continues to use the original UI's polling behavior. Supabase Realtime can be added later without changing the visual interface.

## 5. Existing SQLite data

The uploaded ZIP did not contain `questora.db`, so there was no student/question database file available to migrate. The new Supabase schema starts empty apart from default configuration. The sample seed adds demonstration questions. If you have the old `questora.db` on your computer, keep a backup and export/import its records before switching users to the deployed version.

## 6. UI preservation

The two original HTML files are copied without edits. No redesign, CSS rewrite, or frontend framework conversion is performed in this migration. API endpoints and their JSON contracts are preserved so the existing UI continues to call the same URLs.
