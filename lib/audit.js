const { query } = require('../db/postgres');
const logger = require('../logger');

// action examples: 'login', 'login_failed', 'api_key.created', 'api_key.revoked',
// 'password.reset', 'admin.plan_changed', 'admin.user_suspended'
async function auditLog({ userId = null, actorRole = null, action, targetType = null, targetId = null, req = null, metadata = {} }) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, actor_role, action, target_type, target_id, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId, actorRole, action, targetType, targetId ? String(targetId) : null,
        req?.ip || null, req?.headers?.['user-agent'] || null, JSON.stringify(metadata)
      ]
    );
  } catch (err) {
    // Audit logging must never break the main request
    logger.error('Failed to write audit log', { error: err.message, action });
  }
}

module.exports = { auditLog };
