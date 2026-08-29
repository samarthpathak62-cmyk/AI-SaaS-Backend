// Run manually: npm run backup
// Or on a daily cron: 0 3 * * * cd /path/to/ai-backend && npm run backup >> logs/backup.log 2>&1
// Uses `pg_dump`, which must be installed on the VPS (same version family as your Postgres server).
require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP_LAST = 14; // days of backups to keep

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destPath = path.join(BACKUP_DIR, `backup-${stamp}.sql.gz`);

try {
  execSync(`pg_dump "${process.env.DATABASE_URL}" | gzip > "${destPath}"`, { shell: '/bin/bash' });
  console.log(`Backup saved: ${destPath}`);
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exit(1);
}

const cutoff = Date.now() - KEEP_LAST * 24 * 60 * 60 * 1000;
for (const file of fs.readdirSync(BACKUP_DIR)) {
  const filePath = path.join(BACKUP_DIR, file);
  if (fs.statSync(filePath).mtimeMs < cutoff) {
    fs.unlinkSync(filePath);
    console.log(`Deleted old backup: ${file}`);
  }
}
