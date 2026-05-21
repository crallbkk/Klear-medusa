# klear_shipping module

Klear-specific shipping orchestration. Wraps **Shippop** — a Thai aggregator
fronting 50+ carriers behind one REST API.

Decision: see `DECISIONS.md` § "Shipping Provider — Shippop (aggregator)"
in the storefront repo (2026-05-20). Default routed carrier is **Flash
Express (`FLE`)**; remote-postcode fallback is **Thailand Post EMS (`EMST`)**.

## Status

Real Shippop implementation in `providers/shippop.ts`, fully covered by
mocked unit tests. Service auto-resolves to `UnconfiguredShippopProvider`
(every method throws with a pointer to DECISIONS.md) when the env vars
below are missing, so the module wires cleanly into Medusa today and
flips to real calls the moment the merchant key lands.

Verified against the Shippop Postman collection 2026-05-20 — see
`SHIPPOP_API.md` for the captured request/response shapes.

## Files

- `service.ts` — `ShippingModuleService` (lower-level Klear module; non-lifecycle uses)
- `types.ts` — vendor-neutral types + `IShippingProvider` + `ShippingError`
- `providers/_unconfigured.ts` — used when env vars are missing
- `providers/shippop.ts` — real provider against the verified API
- `provider/service.ts` — `ShippopFulfillmentService` (extends `AbstractFulfillmentProviderService`, registered with Medusa's built-in fulfillment module)
- `provider/index.ts` — `ModuleProvider(Modules.FULFILLMENT, ...)` registration
- `__tests__/shippop.unit.spec.ts` — 14 cases against a mocked fetch
- `__tests__/service.unit.spec.ts` — 12 interface-shape + unconfigured tests
- `provider/__tests__/service.unit.spec.ts` — 12 adapter delegation tests
- `SHIPPOP_API.md` — the curated subset of Shippop API docs we depend on

Related (outside this folder):

- `src/api/webhooks/shippop/[secret]/route.ts` — Shippop tracking webhook ingress; verifies path secret + emits `shippop.tracking.update` / `shippop.delivery.failed` on the event bus
- `medusa-config.ts` — registers `ShippopFulfillmentService` under `@medusajs/medusa/fulfillment` providers list

## Required env (Railway)

```
SHIPPOP_API_KEY=<from Shippop merchant dashboard>
SHIPPOP_API_BASE_URL=https://mall.shippop.com
SHIPPOP_WEBHOOK_PATH_SECRET=<generated; also store in Bitwarden>
SHIPPING_DEFAULT_CARRIER=FLE   # optional; defaults to "FLE"
```

Until all three secrets are set, `ShippingModuleService` resolves to
`UnconfiguredShippopProvider` and every method throws. This is intentional:
the system fails loudly instead of silently shipping nothing.

## API surface

```ts
ShippingModuleService {
  getRates(input): Promise<RateQuote[]>
  createShipment(input): Promise<Shipment>      // calls /booking/ then /confirm/
  getTracking(shippopCode): Promise<TrackingEvent[]>
  cancelShipment(courierAwb): Promise<void>     // pass the *courier* AWB, not the Shippop SP code
  getLabelHtml(purchaseId): Promise<string>     // 4x6 sticker HTML
  verifyAndParseWebhook({ raw_body, headers, path_secret }): Promise<ShippingWebhookEvent>
  getProviderName(): string
  getDefaultCarrier(): ThaiCarrier
}
```

Critical quirks (verified against the Postman docs):

1. **Two-step booking.** `/booking/` reserves; `/confirm/` commits.
   `createShipment` auto-confirms by default; pass `auto_confirm: false`
   for batch flows.
2. **Auth is a body field**, not a header. `api_key` goes in JSON or
   form-encoded body depending on the endpoint.
3. **`/confirm/` uses `application/x-www-form-urlencoded`** — every other
   call we make uses JSON. The provider handles this internally.
4. **Cancel takes the carrier AWB**, not Shippop's tracking code. Stay
   clear on which code is which: `shipment_id` (= Shippop `SP...`) for
   tracking; `courier_tracking_code` for cancel.
5. **Webhooks are not HMAC-signed.** Authentication is by path secret in
   the registered callback URL. Caller (the Medusa API route) extracts
   the path segment and passes it as `path_secret`.
6. **Tracking timestamps are Bangkok-local** with no timezone marker.
   The provider converts to ISO-8601 UTC via `bangkokToIso`.

## Next steps

1. ~~Convert to `AbstractFulfillmentProviderService`~~ — **done** (this PR). Provider lives in `provider/`.
2. ~~Webhook API route~~ — **done** (this PR). Route at `src/api/webhooks/shippop/[secret]/route.ts` verifies + emits on event bus.
3. **Subscriber for the emitted events** (DEV_TRACKER 2.12) — listens for `shippop.tracking.update` / `shippop.delivery.failed`, looks up the Medusa Fulfillment by `data.shippop_tracking_code`, and calls `createOrderShipmentWorkflow` / `markOrderFulfillmentAsDeliveredWorkflow`. Also fires the matching LINE OA template.
4. **Polling fallback cron** (DEV_TRACKER 2.12, every ~30 min) — call `getTracking` for any shipment still in `picked_up` / `in_transit` to cover dropped webhooks.
5. **Apply for Shippop merchant account** — off-platform, gated on Thai company registration. First true end-to-end test requires this.
6. **R2 label persistence** — stash `getLabelHtml` output so we don't re-hit Shippop on every reprint, and so label URLs survive any Shippop-side TTL.
7. **Flash pickup wiring** (`/calltopickup/flash/`) — daily pickup orchestration cron.
8. **Per-item parcel dims** — wire the storefront product variant's weight/dims (when available) into `computeParcelFromItems` in `provider/service.ts` instead of the default-stack approximation.

## Why provider-pattern even with the vendor decided

If Shippop has an outage, rate hike, or behaviour change we don't like,
the swap surface is `service.ts` line ~22 (`resolveProvider()`) — not
every caller in the codebase. Matches the `klear_payment` module shape.
