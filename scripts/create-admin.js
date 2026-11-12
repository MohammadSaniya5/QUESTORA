require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
(async () => {
  if (!process.env.DATABASE_URL || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error("Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD first.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(`INSERT INTO profiles(role,email,first_name,last_name,password_hash,created_at)
      VALUES('admin',$1,'Questora','Administrator',$2,$3)
      ON CONFLICT(email) DO UPDATE SET role='admin',password_hash=EXCLUDED.password_hash`,
      [email, hash, Date.now()]);
    console.log("Admin account created/updated:", email);
  } finally { await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
