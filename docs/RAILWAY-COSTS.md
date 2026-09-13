# Railway costs — where the money actually goes

Written against the **Aug 9 – Sep 9, 2026** invoice (receipt #2241-8101), taken
during a period with **no production web traffic**.

## TL;DR

**Nothing on that invoice was a usage charge.** The $5.00 paid is the Hobby
plan subscription. Usage came to $3.62 and was fully cancelled by the $5.00 of
usage the plan includes. Trimming usage today changes the bill by **$0.00**.

What it *does* change is headroom: 72% of the included $5 was consumed with the
service doing nothing. That is the number worth defending, because it is the
one that will blow past $5 the moment the storefront goes live.

## The invoice, reconciled

| Line | Qty | Charge | Share |
|---|---:|---:|---:|
| Memory (per MB/min) | 14,800,612 | $3.43 | **94.8%** |
| vCPU (per vCPU/min) | 18,926 | $0.09 | 2.4% |
| Network | 1,425,574 | $0.07 | 1.9% |
| Disk (per GB/min) | 9,808 | $0.03 | 0.8% |
| Object Storage | 0 | $0.00 | — |
| Agent Usage | 0 | $0.00 | — |
| **Usage subtotal** | | **$3.62** | |
| Hobby plan (Sep 9 – Oct 9) | 1 | $5.00 | |
| Subtotal | | $8.62 | |
| Hobby plan included usage | | −$3.62 | |
| **Total paid** | | **$5.00** | |

Dividing each charge by Railway's list price turns it into something physical:

| Resource | List price | Implied steady state |
|---|---|---|
| Memory | $10 / GB-month | **~343 MB resident, 24/7** |
| vCPU | $20 / vCPU-month | **0.45% of one core** |
| Egress | $0.05 / GB | ~1.4 GB out for the month |
| Volume | $0.15 / GB-month | ~0.2 GB provisioned |

## Why a service with no traffic still costs money

Railway bills **allocated container-minutes, not requests**. A Medusa v2
backend is a long-lived Node monolith: it boots, loads the framework, the
custom modules (`prescription`, `lms`, `shipping`), the bundled admin
dashboard, and then holds all of it resident forever waiting for a request that
never comes. Zero traffic does not mean zero cost — it means you are paying
rent on idle RAM.

The 0.45% average CPU is the proof. The process is genuinely doing nothing;
it is simply *present*. That is why memory is 95% of the bill and CPU is a
rounding error, and it is why every meaningful lever below is a memory lever.

The `heal-pending-rx` sweep (`*/30 * * * *`) wakes the process 48x/day for one
indexed query. At 0.45% average CPU it is not a factor.

## What changed in this repo

Both in the runner stage of the root `Dockerfile`:

1. **`NODE_OPTIONS=--max-old-space-size=384`.** Node does not know it is inside
   a billed container. V8 sizes its default old-space from the *host's* memory,
   sees gigabytes of headroom, and so defers major GC — letting collectable
   garbage sit as resident, billed bytes. Capping the heap makes V8 collect
   instead of grow.

   This is a ceiling, not a hard RSS limit (resident = heap + native + code), and
   the saving is **expected, not measured** — verify it on the service's memory
   graph over the next few days. If you see SIGKILL / exit 137 restarts, raise
   it to 512 via a `NODE_OPTIONS` variable on the Railway service; that
   overrides the image without a rebuild. A crash loop costs far more than the
   RAM it saves.

2. **`MEDUSA_WORKER_MODE=shared`**, set explicitly. Medusa's server/worker split
   would mean a second always-on container and roughly double the memory bill,
   for a process running at 0.45% CPU. Pinning it means no future version
   default can silently double the bill.

Also hardened while in there: the boot command no longer routes the migration
through `npx` (which can fall back to a registry download at container start),
and `exec`s the server so `sh` does not linger as PID 1 swallowing SIGTERM.

## Levers that are NOT in code — Railway dashboard only

Ranked by how much they matter.

### 1. App Sleep / Serverless — the big one, pre-launch only

Service → **Settings → Serverless / App Sleep** (Railway has renamed this
across versions). The service scales to zero after a period with no inbound
traffic, and **you stop paying memory while it sleeps**. On a zero-traffic
service this reclaims most of the $3.43.

Two real trade-offs, both acceptable *today* and not at launch:

- **Cold starts.** A sleeping Medusa container has to boot the framework *and*
  run `db:migrate` before serving — tens of seconds. Unacceptable once a
  customer can hit the storefront.
- **Cron stops firing.** `heal-pending-rx` does not run while the process is
  asleep. Harmless right now (no lab provider is wired, so a `pending_rx` job
  has nowhere to advance to), but it silently breaks send-later Rx healing the
  moment one is.

**Turn this on now; turn it off as part of launch.**

### 2. Audit the service list for things you are not using

Every service in the environment is billed 24/7, whether or not anything talks
to it. Worth confirming in the dashboard:

- **Redis.** `medusa-config.ts` registers the Redis cache / event-bus /
  workflow-engine modules *only when `REDIS_URL` is set*, and falls back to
  in-memory ones otherwise. Pre-launch you can drop the Redis service and unset
  the variable. The cost is real but currently theoretical: in-memory workflow
  state does not survive a restart and does not support more than one instance.
  **Must come back before launch.**
- **Postgres.** Check whether the database is a Railway service or Supabase
  (`SUPABASE_URL` is used by the LMS module, but `DATABASE_URL` is separate).
  If both exist and only one is real, the other is pure waste.
- **Stale environments.** PR / staging environments each run a full copy of
  every service.

### 3. Things not worth your time

The $0.03 volume, the $0.07 of egress (~1.4 GB, essentially the admin dashboard
bundle on the occasions you log in), and the CPU line. Together they are 5% of
usage, which is itself 0% of what you paid.

## The honest bottom line

$5/month is the floor on Railway's Hobby plan — Railway has no free tier, and
because your usage is already inside the included allowance, the only way to
pay less is to leave the platform. For a managed Postgres + always-on Medusa
backend, $5 is cheap; chasing it is not a good use of time.

The thing to actually watch is the trend. At launch, memory grows (real
sessions, real cache, Redis back on, admin in daily use) and the included $5
stops covering it. Expect the bill to become a genuine usage bill then. The
changes above exist so that transition starts from a lower baseline — not to
save $3.62 that is already free.
