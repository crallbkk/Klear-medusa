# klear_shipping module

Klear-specific shipping orchestration. Wraps **Shippop** — a Thai aggregator
fronting 50+ carriers behind one REST API.

Decision: see `DECISIONS.md` § "Shipping Provider — Shippop (aggregator)"
in the storefront repo (2026-05-20). Default routed carrier is **Flash
Express**; remote-postcode fallback is **Thailand Post EMS**.

## Status

Skeleton only. Every method currently throws `ShippingError("not_configured")`
because `SHIPPOP_API_KEY` is not yet set. The module wires into
`medusa-config.ts` so the service registers cleanly today; live API calls
land once the Shippop merchant account exists.

## Files

- `service.ts` — `ShippingModuleService` (module entrypoint)
- `types.ts` — vendor-neutral types + `IShippingProvider` + `ShippingError`
- `providers/_unconfigured.ts` — used when env vars are missing
- `providers/shippop.ts` — real provider skeleton (method stubs + TODOs)
- `__tests__/service.unit.spec.ts` — interface-shape + unconfigured tests

## Required env (Railway)

```
SHIPPOP_API_KEY=<from Shippop merchant dashboard>
SHIPPOP_API_BASE_URL=https://mall.shippop.com   # confirm in docs
SHIPPOP_WEBHOOK_SECRET=<generated, also stored in Bitwarden>
SHIPPING_DEFAULT_CARRIER=flash                  # optional; defaults to "flash"
```

Until all three secrets are set, `ShippingModuleService` resolves to
`UnconfiguredShippopProvider` and every method throws. This is intentional:
the system fails loudly instead of silently shipping nothing.

## Next steps

1. Apply for Shippop merchant account (off-platform; gated on Thai company
   registration — see `DECISIONS.md` regulatory action items)
2. Add the three env vars above to Railway + Bitwarden
3. Implement the five TODOs in `providers/shippop.ts` against the live API
4. Add a Medusa subscriber: on `order.placed` → call `createShipment`
5. Add a Medusa API route to receive Shippop tracking webhooks, verify
   signature, map to Klear order-state events, fire the existing LINE
   templates from `src/lib/line/templates.ts` (storefront repo)
6. Add an integration test against the Shippop sandbox once available

## Why an aggregator instead of direct carrier integration

- One Medusa module unlocks 50+ carriers (Flash, Kerry, J&T, EMS, DHL,
  Ninja Van, SCG, Best)
- Native LINE tracking notifications match the brand-voice / Thai-UX bar
  (`KLEAR.md` §2)
- Carrier-agnostic during launch when actual performance is unknown — swap
  routing by config, not by code
- Direct Flash integration becomes worth the work above ~300 parcels/day;
  Shippop keeps serving the long tail

## Why provider-pattern even with the vendor decided

If Shippop has an outage, rate hike, or behaviour change we don't like, the
swap surface is `service.ts` line 21 (`resolveProvider()`) — not every
caller in the codebase. Matches the `klear_payment` module shape.
