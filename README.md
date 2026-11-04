# Klear — commerce backend (MedusaJS v2)

The order and catalogue engine behind [kleareyes.com](https://kleareyes.com).
The storefront is a separate repo (`crallbkk/Klear`, Next.js on Vercel); it owns
checkout, payments (Opn/Omise), the customer-facing order lifecycle and all
customer messages. This repo owns the product catalogue, orders of record,
fulfillment (Shippop) and the lab pipeline. The full picture is in the
storefront repo's `ARCHITECTURE.md`.

Deployed on Railway (`ap-southeast-1`) with Railway Postgres and Redis.
The backend app lives in `apps/backend/`.

## What is custom here

| Path (under `apps/backend/src/`) | What it does |
|---|---|
| `modules/lms/` | `lab_job` table + service. One job per order, built from the order's line-item metadata (`build-packet.ts`). Lab provider is a placeholder until a lab partner is chosen. |
| `modules/prescription/` | The only Medusa-side decrypt of a prescription (Supabase Vault RPC), after an HMAC check of the id (`rx-signature.ts`). |
| `modules/shipping/` | Shippop client, plus `provider/`, a native Medusa fulfillment provider (`shippop`). |
| `subscribers/order-placed.ts` | Creates the lab job when an order is placed. |
| `subscribers/shippop-tracking.ts` | Carrier status → Medusa fulfillment delivered + POST to the storefront. |
| `jobs/heal-pending-rx.ts` | Every 30 min: moves send-later jobs on once the prescription arrives. |
| `jobs/redact-lab-job-rx.ts` | Daily: blanks the readable prescription on finished lab jobs. |
| `api/admin/lab-jobs/` | Admin list / get / retry of lab jobs. |
| `api/webhooks/shippop/[secret]/` | Shippop tracking webhook (path-secret auth). |
| `api/middlewares.ts` | Raw body for the Shippop webhook; 5xx errors reported to Sentry. |
| `migration-scripts/initial-data-seed.ts` | Thailand-only store/region/tax/stock-location seed (runs once on migrate). |

## Local development

Prerequisites: Node 20+, PostgreSQL 15+, Redis (optional locally).

```bash
npm ci
```

```bash
cp apps/backend/.env.template apps/backend/.env
```

Set `DATABASE_URL` in `apps/backend/.env`, then:

```bash
cd apps/backend && npx medusa db:migrate
```

```bash
cd apps/backend && npx medusa user -e you@example.com -p <password>
```

```bash
cd apps/backend && npm run dev
```

Admin: `http://localhost:9000/app`. Every env var is documented in
`apps/backend/.env.template`.

## Checks (same as CI)

```bash
cd apps/backend && npx tsc --noEmit
```

```bash
cd apps/backend && npm run test:unit
```

## Deploying

Railway builds `main` (`cd apps/backend && npm run build`) and runs
`npx medusa db:migrate` before each deploy. Deploys are not reliably
triggered by every push; use "Deploy" in the Railway dashboard or
`railway redeploy --from-source`. In production the server refuses to boot
without `JWT_SECRET`, `COOKIE_SECRET`, `DATABASE_URL` and the three CORS
variables.
