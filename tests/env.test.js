const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('loadEnv accepts a valid, complete configuration', () => {
  process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.JWT_SECRET = 'a'.repeat(32);
  process.env.LLAMA_SERVER_URL = 'http://127.0.0.1:8080/v1/chat/completions';

  delete require.cache[require.resolve('../config/env')];
  const { loadEnv } = require('../config/env');
  const env = loadEnv();

  assert.equal(env.DATABASE_URL, process.env.DATABASE_URL);
  assert.equal(env.PORT, 3000); // default applied
});

test('loadEnv exits the process with a clear error on missing required vars', () => {
  assert.throws(() => {
    execFileSync(process.execPath, ['-e', "require('" + path.join(__dirname, '..', 'config', 'env') + "').loadEnv()"], {
      env: { PATH: process.env.PATH }, // deliberately empty config
      stdio: 'pipe'
    });
  });
});
