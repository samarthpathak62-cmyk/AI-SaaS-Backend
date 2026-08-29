# AI Backend v2 — Production Foundation (Postgres + Redis)

Ye Priority-1 (foundation) release hai — SQLite se **Postgres**, in-memory se **Redis** pe migrate kiya, aur ye sab add kiya:

- ✅ **PostgreSQL** — proper relational DB, concurrent writes handle karta hai
- ✅ **Redis** — rate limiting ka backing store (restart-safe)
- ✅ **Refresh token rotation** — har refresh pe naya token, purana revoke; agar koi revoked token dobara use ho (stolen token) toh poori session family turant revoke ho jaati hai
- ✅ **API key management** — har user multiple named keys bana sakta hai, expiry set kar sakta hai, revoke kar sakta hai (`/api/keys`)
- ✅ **RBAC** — roles: `user`, `developer`, `admin`
- ✅ **Zod validation** — har request body strictly validate hoti hai
- ✅ **Audit logs** — login, key creation, admin actions — sab `audit_logs` table mein
- ✅ **Health endpoints** — `/live`, `/health`, `/ready` (DB+Redis actually check karta hai)
- ✅ **Graceful shutdown** — SIGTERM/SIGINT pe in-flight requests complete hoke hi process band hota hai
- ✅ **Environment validation** — galat/missing `.env` pe server start hi nahi hoga, clear error dega

Pehle wale features bhi sab hain (vision, streaming, conversation history, moderation, Stripe billing, referral, usage alerts).

## 1. VPS pe dependencies install karo

```bash
# Postgres
sudo apt install postgresql postgresql-contrib

# Redis
sudo apt install redis-server

# pg_dump/psql (backup/restore ke liye, Postgres install se hi aata hai)
```

Database banao:
```bash
sudo -u postgres psql -c "CREATE DATABASE ai_backend;"
sudo -u postgres psql -c "CREATE USER ai_backend_user WITH ENCRYPTED PASSWORD 'apna_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ai_backend TO ai_backend_user;"
```

## 2. Backend install karo

```bash
cd ai-backend
npm install
cp .env.example .env
nano .env   # DATABASE_URL, REDIS_URL, JWT_SECRET, SMTP, Stripe sab bharo
```

**`JWT_SECRET` kam se kam 32 characters ka random string ho** — chhota hoga toh server start hi nahi hoga (env validation isliye hai).

## 3. Schema apply karo aur admin banao

```bash
npm run migrate         # Postgres mein saari tables banata hai
npm run setup-admin      # Admin account banata hai
```

Admin banne ke baad login karke (`POST /api/auth/login`) apna access token lo, phir `POST /api/keys` se ek API key banao — vahi key aap website/app mein use karoge.

## 4. Server start karo

```bash
npm start
```
Production ke liye PM2:
```bash
pm2 start server.js --name ai-backend
pm2 save && pm2 startup
```

## 5. Health checks (load balancer / monitoring ke liye)

| Endpoint | Kab use ho |
|---|---|
| `GET /live` | Process zinda hai ya nahi (bas ping) |
| `GET /health` | Basic status + uptime |
| `GET /ready` | DB + Redis dono se connect ho pa raha hai kya (503 agar nahi) |

## 6. Daily backups (cron)

```bash
crontab -e
0 3 * * * cd /path/to/ai-backend && npm run backup >> logs/backup.log 2>&1
```
Restore karna ho: `npm run restore backups/backup-2026-08-07T03-00-00.sql.gz`

## 7. API Reference (naya/updated)

### Auth
| Endpoint | Kya karta hai |
|---|---|
| `POST /api/auth/register` | `{username, email, password, referral_code?}` |
| `POST /api/auth/login` | → `access_token` (15 min) + `refresh_token` (30 din) |
| `POST /api/auth/refresh-token` | `{refresh_token}` → naya access+refresh token pair (purana revoke ho jaata hai) |
| `POST /api/auth/logout` | `{refresh_token}` → session khatam |
| `POST /api/auth/verify-email` | `{token}` |
| `POST /api/auth/forgot-password` / `reset-password` | password recovery |

**5 galat login attempts = 15 minute account lock** (automatic, brute-force protection).

### API Keys (naya)
| Endpoint | Kya karta hai |
|---|---|
| `GET /api/keys` | Apni sab keys dekho (raw key kabhi dobara nahi dikhti) |
| `POST /api/keys` | `{name, expires_in_days?, scopes?}` → naya key (sirf ek baar dikhta hai) |
| `DELETE /api/keys/:id` | Key revoke karo |

### Account data (GDPR-style)
| Endpoint | Kya karta hai |
|---|---|
| `GET /api/account/export` | Profile, keys (metadata), conversations, messages, usage aur audit logs — sab ek JSON file mein |
| `POST /api/account/delete` | `{password, confirm:"DELETE"}` → account permanently delete (cascades to keys/conversations/tokens) |

**Important:** Ab model calls ke liye login-JWT nahi, `/api/keys` se bani key use hoti hai — isse aap alag-alag apps/servers ke liye alag keys bana sakte ho aur jab chaho revoke kar sakte ho, bina password change kiye.

### Chat (pehle jaisa hi, ab Postgres pe)
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer sk-xxxxxxx" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```
Vision aur streaming (`stream:true`) pehle jaise hi kaam karte hain — README ke purane examples valid hain.

### Admin (RBAC — sirf `role:admin`)
| Endpoint | Kya karta hai |
|---|---|
| `GET /api/admin/users` | Sab users |
| `GET /api/admin/stats` | Overview |
| `GET /api/admin/audit-logs` | Recent sensitive actions (login, key changes, admin actions) |
| `PATCH /api/admin/users/:id/limit` | Custom token limit |
| `PATCH /api/admin/users/:id/plan` | Manual plan assign |
| `PATCH /api/admin/users/:id/role` | `{role: "developer"}` — RBAC role badlo |
| `PATCH /api/admin/users/:id/suspend` | Ban/unban |

## 8. AI Gateway — one endpoint, any provider

`POST /v1/chat/completions` ab OpenAI, Anthropic, Gemini, Groq, OpenRouter, Ollama, vLLM, llama.cpp, aur LM Studio — sabko ek hi jagah se support karta hai. Configure sirf wahi providers karo jo aap use karna chahte ho — `.env` mein jis provider ki API key nahi bhari, wo automatically skip ho jaata hai.

```bash
# Ek specific model maango
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxx" -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages":[{"role":"user","content":"Hello!"}]}'

# Smart routing - "cheapest" sabse sasta available model chunega
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxx" -H "Content-Type: application/json" \
  -d '{"routing": "cheapest", "messages":[{"role":"user","content":"Hello!"}]}'

# Explicit fallback chain - Gemini down ho toh Claude, phir OpenAI, phir local model
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxxx" -H "Content-Type: application/json" \
  -d '{"fallback_chain": ["gemini-1.5-pro", "claude-sonnet-4-6", "gpt-4o", "local-llama"], "messages":[{"role":"user","content":"Hello!"}]}'

# Kaunse models abhi available hain (jinki key configured hai)
curl http://localhost:3000/v1/models -H "Authorization: Bearer sk-xxxxxxx"
```

**Routing strategies** (`routing` field mein bhejo):
| Strategy | Kya karta hai |
|---|---|
| `cheapest` | Sabse kam cost-per-token wala available model |
| `fastest` / `latency_based` | Jiski average response time sabse kam rahi ho |
| `quality` | Sabse high quality-tier wala model |
| `local_first` | Pehle aapke apne VPS/GPU wale models try karega, fir cloud pe jayega |
| `health_based` | Jo abhi down/failing nahi hai use karega |
| `fallback` (default) | Quality ke hisaab se order, automatic fallback agar top wala fail ho |

**Kaise kaam karta hai:** Har request mein ek ordered candidate list banti hai. Pehla try hota hai — agar wo fail ho (down, error, timeout) toh automatically agla try hota hai, jab tak koi respond na kare. Ye har strategy mein hota hai — isliye "Gemini down → Claude → OpenAI → Local" jaisa fallback bina extra code ke milta hai, bas `fallback_chain` mein order de do.

**Note:** Streaming (`stream: true`) mein sirf pehla candidate try hota hai — beech stream mein fallback karne se client ko duplicate/mila-julaa output milega, isliye non-streaming requests hi poori fallback chain try karti hain. Cost tracking automatic hai — `config/models.js` mein har model ki per-1k-token cost hai, har request ka actual `$` cost `request_logs.cost_usd` mein save hota hai (admin isse revenue vs cost dekh sakta hai).

Naya provider/model add karna ho toh bas `config/providers.js` aur `config/models.js` mein entry add karo — baaki sab (routing, fallback, cost tracking) automatically kaam karega.

## 9. Free plan — 2 ghante/din usage limit

Free plan users ke liye ab do limits ek saath lagte hain:
- **Token limit** (pehle jaisa) — `daily_token_limit` (free = 20,000/day)
- **Usage-time limit** (naya) — `daily_usage_seconds_limit` (free = 2 ghante/din, `config/plans.js` mein change kar sakte ho)

Usage-time sirf **active usage** count karta hai — agar do requests ke beech 5 minute se zyada gap hai, wo idle time free plan ke 2-ghante budget se kata nahi jaata (user chat band karke chala jaaye toh time waste nahi hota). Dono limits `usage_reset_date` ke saath har din midnight pe reset ho jaate hain.

Limit lagne par response: `429 { error: "Free plan daily usage limit (2 hours) reached..." }`. Pro/Business plans ke liye `daily_usage_seconds_limit: null` hai — sirf token limit lagu hota hai, time ka koi cap nahi.

`GET /api/account/me` response mein `usage_seconds_today` aur `usage_seconds_remaining_today` bhi milte hain, taaki app/website mein "X minutes left today" jaisa UI dikha sako.

## 10. Payment system — Stripe + Paymenter, user ki choice

Ab do payment gateways support hote hain — **Stripe** (pehle se tha) aur **Paymenter** (naya, self-hosted billing panel — https://paymenter.org). Jo bhi `.env` mein configured ho (ek ya dono), wahi `GET /api/billing/plans` ke `payment_providers` array mein dikhta hai. User checkout karte waqt `provider` bata sakta hai — agar nahi bataya toh jo pehla configured mila wahi use hoga.

```bash
# Available plans + kaunse gateways configured hain
curl http://localhost:3000/api/billing/plans

# Stripe se checkout
curl -X POST http://localhost:3000/api/billing/create-checkout-session \
  -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" \
  -d '{"plan": "pro", "provider": "stripe"}'

# Paymenter se checkout (provider "paymenter" bhejo)
curl -X POST http://localhost:3000/api/billing/create-checkout-session \
  -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" \
  -d '{"plan": "pro", "provider": "paymenter"}'
```

### Setup

**Stripe** — pehle jaisa hi: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` bharo, webhook `https://yourdomain.com/api/billing/webhook/stripe` pe point karo.

**Paymenter** — apna Paymenter instance chalao (ya unka PaaS use karo), phir:
1. Paymenter admin panel se API token banao → `.env` mein `PAYMENTER_URL` aur `PAYMENTER_API_TOKEN` bharo
2. Har paid plan ke liye Paymenter mein ek Product banao, uska ID → `PAYMENTER_PRODUCT_PRO` / `PAYMENTER_PRODUCT_BUSINESS`
3. `PAYMENTER_WEBHOOK_SECRET` set karo aur Paymenter ko configure karo ki order paid hone par `POST https://yourdomain.com/api/billing/webhook/paymenter` pe header `X-Paymenter-Secret: <same secret>` ke saath yeh bheje: `{"event":"order.paid","order_id":"...","product_id":"...","status":"paid"}`

**⚠️ Important:** Paymenter ka exact checkout-URL pattern aur outbound-webhook format aapke install/version ke hisaab se thoda alag ho sakta hai — `lib/payments/paymenterProvider.js` ke top comment mein ye clearly likha hai, live jaane se pehle apne Paymenter setup pe verify kar lena. Agar webhook automatically nahi lagta, toh koi problem nahi — admin manually bhi plan activate kar sakta hai: `PATCH /api/admin/users/:id/plan` (already available), bina kisi webhook ke.



1. HTTPS zaroor lagao (Nginx + Certbot)
2. `.env` kabhi commit mat karo (`.gitignore` mein already hai)
3. `llama-server`, Postgres, Redis — sab `127.0.0.1` pe hi bind rakho, public expose mat karo (docker-compose use kar rahe ho toh compose network isolate karta hai)
4. Refresh token reuse detection built-in hai — agar koi purana (already-rotated) refresh token dobara use kare, poora session family revoke ho jaata hai (session hijack protection)
5. Password change/reset hote hi sab refresh tokens automatically revoke ho jaate hain
6. **CORS**: `.env` mein `ALLOWED_ORIGINS` apne website domain(s) se bharo (comma-separated). Production mein agar ye set nahi hai, browser se aane wali requests block ho jaayengi. Mobile app is se unaffected hai — native apps `Origin` header bhejte hi nahi, toh unhi ke liye alag se kuch karne ki zaroorat nahi.

## Ek hi backend, saare clients (app + website)

Ye backend design hi is tarah hua hai ki app aur website dono isi ek instance se connect rahen aur sab user data isi Postgres mein aaye:
- Auth (`/api/auth/*`) aur API keys (`/api/keys`) dono client types ke liye same hain — website login-JWT (`requireAuth`) use kare, app ya third-party integrations long-lived API key (`requireApiKey`) use karein.
- `ALLOWED_ORIGINS` sirf browser (website) requests ko restrict karta hai — app kabhi block nahi hoga.
- Sab data (users, conversations, usage, billing) ek hi Postgres mein hai, isliye website pe kiya gaya kaam turant app mein bhi dikhega (aur vice versa) — koi sync layer nahi chahiye.
- Naya client (jaise admin dashboard ya doosri app) add karna ho toh bas uska origin `ALLOWED_ORIGINS` mein add karo ya ek naya API key issue karo — backend code kuch change nahi karna padta.

## Tests aur CI

```bash
npm test              # node ka built-in test runner, koi extra dependency nahi
```
`tests/` mein moderation, crypto helpers aur env validation ke tests hain. `.github/workflows/ci.yml` har push/PR pe automatically `npm ci && npm test` chalata hai.

## Docker se run karna (recommended for consistent app+website deploys)

```bash
cp .env.example .env
nano .env   # DATABASE_URL/REDIS_URL ki zaroorat nahi - compose khud set karta hai; baaki (JWT_SECRET, SMTP, Stripe, ALLOWED_ORIGINS) bharo
docker compose up -d --build
docker compose exec app npm run migrate
docker compose exec app npm run setup-admin
```
Postgres aur Redis dono containers ke andar hi rehte hain (`127.0.0.1` pe expose nahi hote), sirf `app` port `3000` par bahar khulta hai.

## Scope note — jo abhi nahi hai

Ye foundation (Priority 1) release hai. Ye cheezein — **RAG + vector DB, 2FA/WebAuthn, analytics dashboard, Kubernetes/multi-region, error tracking (Sentry), background job queue (bulk emails ka retry), real moderation API (abhi sirf keyword regex hai)** — abhi nahi hain. Kuch (jaise Kubernetes, multi-region, auto-scaling) ek single VPS pe realistically chalte bhi nahi — unke liye multiple servers chahiye. Baaki agle phase mein add karenge jab foundation stable ho jaye.

## File Structure

```
ai-backend/
├── server.js                  # Entry point: health checks, graceful shutdown
├── logger.js                  # Winston logging
├── setup-admin.js
├── .env.example
├── db/
│   ├── postgres.js              # Connection pool
│   ├── migrations/                # Versioned .sql files, applied in order
│   └── migrate.js                # Applies pending migrations, tracks them in schema_migrations
├── lib/
│   ├── redis.js                  # Redis client + cache helpers
│   ├── crypto.js                  # API key hashing, tokens
│   ├── audit.js                    # Audit log writer
│   └── payments/                   # stripeProvider.js, paymenterProvider.js, index.js (registry)
├── schemas/index.js            # Zod validation schemas
├── middleware/
│   ├── auth.js                   # JWT + API key + RBAC + free-plan 2hr usage-time cap
│   ├── validate.js               # Generic Zod middleware
│   ├── moderation.js             # Content moderation
│   └── planRateLimit.js          # Per-plan rate limiting (Redis-backed)
├── routes/
│   ├── auth.js                   # register/login/refresh/verify/reset
│   ├── apikeys.js                # API key CRUD
│   ├── account.js                # profile, password change, data export/delete
│   ├── chat.js                   # legacy single-provider (llama.cpp) endpoint
│   ├── gateway.js                # /v1/chat/completions - multi-provider AI Gateway
│   ├── conversations.js          # chat history CRUD
│   ├── admin.js                  # user mgmt + RBAC + audit log viewer
│   └── billing.js                # Stripe + Paymenter checkout/portal/webhooks
├── tests/                        # node:test unit tests (moderation, crypto, plans, env)
├── .github/workflows/ci.yml      # runs npm test on every push/PR
├── lib/gateway/
│   ├── router.js                 # routing strategies + fallback candidate ordering
│   ├── health.js                 # per-model health/latency tracking
│   ├── cost.js                    # $ cost calculation per request
│   └── adapters/                  # openaiCompatible.js, anthropic.js, gemini.js
├── config/
│   ├── env.js                   # Startup env validation (Zod)
│   ├── plans.js                  # Free/Pro/Business limits
│   ├── providers.js               # AI Gateway provider registry
│   ├── models.js                  # AI Gateway model catalog (cost/speed/quality)
│   └── llama-cluster.js           # Multi-server load balancing (legacy /api/chat)
├── scripts/
│   ├── backup-db.js              # pg_dump backup
│   └── restore-db.js              # Restore from backup
└── legal/                      # Terms of Service + Privacy templates
```
