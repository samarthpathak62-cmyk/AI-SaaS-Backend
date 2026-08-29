const { loadEnv } = require('./config/env');
const env = loadEnv(); // exits process with a clear error if .env is misconfigured

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./logger');
const { pool } = require('./db/postgres');
const { redis } = require('./lib/redis');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const apiKeyRoutes = require('./routes/apikeys');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const conversationRoutes = require('./routes/conversations');
const gatewayRoutes = require('./routes/gateway');
const { router: billingRoutes, stripeWebhookHandler, paymenterWebhookHandler } = require('./routes/billing');

const app = express();
app.set('trust proxy', 1); // needed behind Nginx so rate-limit / req.ip see the real client

app.use(helmet());

// CORS: only browsers send an Origin header, so this only restricts your website(s).
// Native mobile apps and server-to-server calls have no Origin and are always allowed.
// Set ALLOWED_ORIGINS in .env to your website domain(s), comma-separated.
const allowedOrigins = (env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // mobile app / curl / server-to-server
    if (allowedOrigins.length === 0) {
      // No allowlist configured yet - fail closed in production, open in dev so local work isn't blocked.
      if (env.NODE_ENV === 'production') {
        logger.warn('CORS blocked - ALLOWED_ORIGINS is not set', { origin });
        return callback(new Error('Not allowed by CORS'));
      }
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('CORS blocked request', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Stripe needs the RAW body to verify its signature - must come before express.json()
app.post('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
// Kept for backward compatibility with any Stripe dashboard webhook already pointed at the old URL:
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json({ limit: '15mb' })); // 15mb so base64 vision images fit

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

app.use('/api/auth', rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use('/api/chat', rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use('/v1', rateLimit({ windowMs: 60 * 1000, max: 60 })); // outer IP ceiling; per-plan limit applies inside the route

// ---- Health endpoints ----
// /live  - is the process even running? (for process managers / container orchestrators)
app.get('/live', (req, res) => res.json({ status: 'alive' }));

// /health - basic human-facing check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) }));

// /ready - can this instance actually serve traffic? Checks real dependencies.
app.get('/ready', async (req, res) => {
  const checks = { database: false, redis: false };
  try {
    await pool.query('SELECT 1');
    checks.database = true;
  } catch { /* stays false */ }
  try {
    await redis.ping();
    checks.redis = true;
  } catch { /* stays false */ }

  const ready = checks.database && checks.redis;
  res.status(ready ? 200 : 503).json({ ready, checks });
});

app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/v1', gatewayRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

const server = app.listen(env.PORT, () => {
  logger.info(`AI backend running on port ${env.PORT} (${env.NODE_ENV})`);
});

// ---- Graceful shutdown ----
// Stops accepting new connections, lets in-flight requests finish, then closes
// the DB pool and Redis connection before exiting. Prevents dropped requests
// and connection leaks on deploys/restarts (PM2, Docker, systemd all send SIGTERM).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);

  server.close(async () => {
    try {
      await pool.end();
      redis.disconnect();
      clearTimeout(forceExitTimer);
      logger.info('Shutdown complete.');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
