// Run once: node setup-admin.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, pool } = require('./db/postgres');
const { generateReferralCode } = require('./lib/crypto');

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in your .env file first.');
    process.exit(1);
  }

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);

  if (rows[0]) {
    await query("UPDATE users SET role = 'admin', email_verified = TRUE WHERE id = $1", [rows[0].id]);
    console.log(`Existing user ${email} upgraded to admin.`);
  } else {
    const password_hash = bcrypt.hashSync(password, 10);
    const referral_code = generateReferralCode();
    await query(
      `INSERT INTO users (username, email, password_hash, role, daily_token_limit, email_verified, referral_code)
       VALUES ('admin', $1, $2, 'admin', 1000000, TRUE, $3)`,
      [email, password_hash, referral_code]
    );
    console.log(`Admin account created for ${email}.`);
    console.log('Log in via POST /api/auth/login, then create an API key via POST /api/keys.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
