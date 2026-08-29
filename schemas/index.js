const { z } = require('zod');

const register = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, underscore allowed'),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  referral_code: z.string().optional()
});

const login = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const refreshToken = z.object({
  refresh_token: z.string().min(10)
});

const forgotPassword = z.object({
  email: z.string().email()
});

const resetPassword = z.object({
  token: z.string().min(10),
  new_password: z.string().min(8)
});

const changePassword = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8)
});

const createCheckoutSession = z.object({
  plan: z.string().min(1),
  provider: z.enum(['stripe', 'paymenter']).optional()
});

const deleteAccount = z.object({
  password: z.string().min(1),
  confirm: z.literal('DELETE', { errorMap: () => ({ message: 'confirm must be the string "DELETE"' }) })
});

const chatMessage = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([
    z.string().max(50000),
    z.array(z.object({
      type: z.enum(['text', 'image_url']),
      text: z.string().max(50000).optional(),
      image_url: z.object({ url: z.string() }).optional()
    })).max(10)
  ])
});

const chatRequest = z.object({
  messages: z.array(chatMessage).min(1).max(50),
  conversation_id: z.number().int().positive().optional(),
  model: z.string().max(100).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional()
});

const createApiKey = z.object({
  name: z.string().min(1).max(64).default('default'),
  expires_in_days: z.number().int().positive().max(365).optional(),
  scopes: z.array(z.enum(['chat', 'admin', 'billing'])).optional()
});

const adminSetPlan = z.object({
  plan: z.string().min(1)
});

const adminSetLimit = z.object({
  daily_token_limit: z.number().int().nonnegative()
});

const adminSuspend = z.object({
  is_active: z.union([z.literal(0), z.literal(1)])
});

const adminSetRole = z.object({
  role: z.enum(['user', 'developer', 'admin'])
});

module.exports = {
  register, login, refreshToken, forgotPassword, resetPassword, changePassword, deleteAccount,
  chatRequest, createApiKey, createCheckoutSession, adminSetPlan, adminSetLimit, adminSuspend, adminSetRole
};
