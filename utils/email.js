const nodemailer = require('nodemailer');
const logger = require('../logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail(to, subject, html) {
  // If SMTP isn't configured yet, don't crash the app - just log it.
  if (!process.env.SMTP_HOST) {
    logger.warn('SMTP not configured - email not sent', { to, subject });
    return { skipped: true };
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"AI Backend" <no-reply@example.com>',
      to, subject, html
    });
    return { sent: true };
  } catch (err) {
    logger.error('Failed to send email', { to, subject, error: err.message });
    return { sent: false, error: err.message };
  }
}

function sendVerificationEmail(email, token) {
  const url = `${process.env.APP_URL}/verify-email?token=${token}`;
  return sendEmail(email, 'Verify your email', `
    <p>Welcome! Please verify your email by clicking the link below:</p>
    <p><a href="${url}">${url}</a></p>
    <p>If you didn't create this account, ignore this email.</p>
  `);
}

function sendPasswordResetEmail(email, token) {
  const url = `${process.env.APP_URL}/reset-password?token=${token}`;
  return sendEmail(email, 'Reset your password', `
    <p>You requested a password reset. Click the link below (valid for 1 hour):</p>
    <p><a href="${url}">${url}</a></p>
    <p>If you didn't request this, ignore this email - your password won't change.</p>
  `);
}

function sendUsageAlertEmail(email, percentUsed, plan) {
  return sendEmail(email, 'You have used 80% of your daily limit', `
    <p>Heads up - you've used ${percentUsed}% of your daily token limit on the ${plan} plan today.</p>
    <p>Your limit resets at midnight, or you can upgrade your plan for more capacity.</p>
  `);
}

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail, sendUsageAlertEmail };
