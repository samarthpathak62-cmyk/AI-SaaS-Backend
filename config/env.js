require('dotenv').config();
const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid Postgres connection string' }),
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid redis:// connection string' }),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  APP_URL: z.string().url().default('http://localhost:3000'),

  // Comma-separated list of origins allowed to call this API from a browser
  // (your website's domain(s)). Native apps (no Origin header) are unaffected.
  // Example: ALLOWED_ORIGINS=https://myapp.com,https://www.myapp.com
  ALLOWED_ORIGINS: z.string().optional(),

  LLAMA_SERVER_URL: z.string().url().optional(),
  LLAMA_SERVER_URLS: z.string().optional(),

  DEFAULT_DAILY_TOKEN_LIMIT: z.coerce.number().default(20000),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(6).optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_TO_CONSOLE: z.coerce.boolean().default(true)
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('\n❌ Invalid environment configuration:\n');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('\nFix your .env file (see .env.example) and restart.\n');
    process.exit(1);
  }
  return result.data;
}

module.exports = { loadEnv };
