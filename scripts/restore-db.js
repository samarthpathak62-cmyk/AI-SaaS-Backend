// Usage: node scripts/restore-db.js backups/backup-2026-08-07T10-00-00.sql.gz
require('dotenv').config();
const { execSync } = require('child_process');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/restore-db.js <path-to-backup.sql.gz>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

console.log(`⚠️  This will overwrite the current database with: ${file}`);
console.log('Restoring in 5 seconds... (Ctrl+C to cancel)');

setTimeout(() => {
  try {
    execSync(`gunzip -c "${file}" | psql "${process.env.DATABASE_URL}"`, { shell: '/bin/bash', stdio: 'inherit' });
    console.log('✅ Restore complete.');
  } catch (err) {
    console.error('❌ Restore failed:', err.message);
    process.exit(1);
  }
}, 5000);
