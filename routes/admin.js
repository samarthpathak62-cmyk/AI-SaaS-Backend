const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const { PLANS } = require('../config/plans');
const { auditLog } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/users - list everyone + usage + plan
router.get('/users', async (req, res) => {
  const { rows } = await query(`
    SELECT id, username, email, role, plan, plan_status, daily_token_limit, tokens_used_today,
           is_active, email_verified, created_at
    FROM users ORDER BY id DESC LIMIT 500
  `);
  res.json({ users: rows });
});

// GET /api/admin/stats - quick overview
router.get('/stats', async (req, res) => {
  const [totalUsers, activeToday, totalTokensToday, totalRequests, errorsToday] = await Promise.all([
    query('SELECT COUNT(*)::int c FROM users'),
    query('SELECT COUNT(*)::int c FROM users WHERE tokens_used_today > 0'),
    query('SELECT COALESCE(SUM(tokens_used_today),0)::bigint s FROM users'),
    query('SELECT COUNT(*)::int c FROM request_logs'),
    query("SELECT COUNT(*)::int c FROM request_logs WHERE status = 'error' AND created_at > now() - interval '24 hours'")
  ]);
  res.json({
    totalUsers: totalUsers.rows[0].c,
    activeToday: activeToday.rows[0].c,
    totalTokensToday: totalTokensToday.rows[0].s,
    totalRequests: totalRequests.rows[0].c,
    errorsLast24h: errorsToday.rows[0].c
  });
});

// GET /api/admin/audit-logs - recent sensitive actions across all users
router.get('/audit-logs', async (req, res) => {
  const { rows } = await query(
    `SELECT id, user_id, actor_role, action, target_type, target_id, ip, metadata, created_at
     FROM audit_logs ORDER BY id DESC LIMIT 200`
  );
  res.json({ audit_logs: rows });
});

// PATCH /api/admin/users/:id/limit  { daily_token_limit }
router.patch('/users/:id/limit', validate(schemas.adminSetLimit), async (req, res) => {
  await query('UPDATE users SET daily_token_limit = $1 WHERE id = $2', [req.body.daily_token_limit, req.params.id]);
  await auditLog({ userId: req.user.id, actorRole: 'admin', action: 'admin.limit_changed', targetType: 'user', targetId: req.params.id, req, metadata: req.body });
  res.json({ message: 'Limit updated' });
});

// PATCH /api/admin/users/:id/plan  { plan: "pro" } - for manual/cash payments outside Stripe
router.patch('/users/:id/plan', validate(schemas.adminSetPlan), async (req, res) => {
  const planDef = PLANS[req.body.plan];
  if (!planDef) return res.status(400).json({ error: `Unknown plan. Valid options: ${Object.keys(PLANS).join(', ')}` });

  await query(`UPDATE users SET plan = $1, daily_token_limit = $2, plan_status = 'active' WHERE id = $3`, [
    req.body.plan, planDef.daily_token_limit, req.params.id
  ]);
  await auditLog({ userId: req.user.id, actorRole: 'admin', action: 'admin.plan_changed', targetType: 'user', targetId: req.params.id, req, metadata: { plan: req.body.plan } });
  res.json({ message: `User moved to ${planDef.name} plan`, daily_token_limit: planDef.daily_token_limit });
});

// PATCH /api/admin/users/:id/role  { role: "developer" }
router.patch('/users/:id/role', validate(schemas.adminSetRole), async (req, res) => {
  await query('UPDATE users SET role = $1 WHERE id = $2', [req.body.role, req.params.id]);
  await auditLog({ userId: req.user.id, actorRole: 'admin', action: 'admin.role_changed', targetType: 'user', targetId: req.params.id, req, metadata: req.body });
  res.json({ message: `Role updated to ${req.body.role}` });
});

// PATCH /api/admin/users/:id/suspend  { is_active: 0 or 1 }
router.patch('/users/:id/suspend', validate(schemas.adminSuspend), async (req, res) => {
  await query('UPDATE users SET is_active = $1 WHERE id = $2', [!!req.body.is_active, req.params.id]);
  await auditLog({ userId: req.user.id, actorRole: 'admin', action: req.body.is_active ? 'admin.user_activated' : 'admin.user_suspended', targetType: 'user', targetId: req.params.id, req });
  res.json({ message: req.body.is_active ? 'User activated' : 'User suspended' });
});

module.exports = router;
