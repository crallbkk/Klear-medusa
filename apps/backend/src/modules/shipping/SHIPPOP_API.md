# Shippop API reference (verified subset)

Source: the public Postman collection exported 2026-05-20 from
[Shippop's developer portal](http://developers.shippop.com). This file
captures only the endpoints and fields **we actually use** — kept in
sync with `providers/shippop.ts`.

For the full upstream API (cross-border, billing, identity, rebate,
reports, etc.) see the original Postman collection (stored off-repo in
Bitwarden under "Shippop API docs").

## Base URL

Set per environment in Railway: `SHIPPOP_API_BASE_URL`. Production
typically `https://mall.shippop.com`. Sandbox base TBD — Shippop does
not publish one; merchant approval gates live keys.

## Authentication

`api_key` is passed as a **body field**, not an HTTP header.
JSON calls: `{ "api_key": "<key>", ... }`.
Form calls (only `/confirm/` so far): `api_key=<key>&...` urlencoded.

## Endpoints

### POST `/pricelist/` — rate quote (2.1.1)

Request body (JSON). `data` is a **numbered object**, one batch row per
carrier we want to price.

```json
{
  "api_key": "<key>",
  "data": {
    "0": {
      "from": { "name": "...", "address": "...", "district": "...", "state": "...", "province": "...", "postcode": "10110", "tel": "0800000000" },
      "to":   { "name": "...", "address": "...", "district": "...", "state": "...", "province": "...", "postcode": "10500", "tel": "0800000000" },
      "parcel": { "name": "-", "weight": 300, "width": 8, "length": 18, "height": 6 },
      "courier_code": "FLE",
      "showall": 1
    }
  }
}
```

Response (200):

```json
{
  "status": true,
  "data": {
    "0": {
      "FLE": {
        "courier_code": "FLE",
        "courier_name": "FlashExpress",
        "price": "238",
        "estimate_time": "ภายใน 1 - 2 วัน",
        "available": true,
        "remark": "optional",
        "err_code": "ERR_DEFAULT"
      }
    }
  }
}
```

Notes:
- `weight` is in **grams**; dimensions in **cm**.
- Shippop's address fields swap the usual labels: `district` = subdistrict
  (tambon), `state` = district (amphoe), `province` = province (changwat).
- `showall: 1` returns every eligible courier for the route.

### POST `/booking/` — create + reserve shipment (3.1)

Two-step flow: **booking reserves**, **confirm commits**. We always
auto-confirm unless caller opts out via `auto_confirm: false`.

Request:

```json
{
  "api_key": "<key>",
  "email": "ops@klear.com",
  "data": [
    {
      "from": {...},
      "to": {...},
      "parcel": {...},
      "courier_code": "FLE",
      "ref_no_1": "order_01J...",
      "ref_no_2": "KLR-A1B2C3"
    }
  ]
}
```

Response:

```json
{
  "status": true,
  "purchase_id": 452002,
  "total_price": 25,
  "data": {
    "0": {
      "status": true,
      "tracking_code": "SP452045855",
      "courier_tracking_code": "ST499960801ST",
      "courier_code": "EMST",
      "price": 25
    }
  }
}
```

Fields we care about:
- `purchase_id` — Shippop's grouping ID, needed for `/confirm/` and `/label/`.
- `tracking_code` (`SP...`) — Shippop's stable shipment identifier. Use this for `/tracking/`.
- `courier_tracking_code` — the carrier's own AWB. Use this for `/cancel/`.

### POST `/confirm/` — commit the booking (3.2)

**This endpoint uses `application/x-www-form-urlencoded`, not JSON.**

```
api_key=<key>&purchase_id=452002
```

Response:

```json
{
  "status": true,
  "result": {
    "0": {
      "status": true,
      "tracking_code": "SP452030829",
      "courier_tracking_code": "ST499959975ST",
      "courier_code": "EMST"
    }
  }
}
```

Rows can fail individually with `status: false` and a `message` — typical
causes are invalid phone format (Thai requires E.164 or local 0-prefixed)
or postcode mismatch. We surface these as `ShippingError("confirm_row_failed")`.

### POST `/cancel/` — cancel a shipment (3.4)

```json
{ "api_key": "<key>", "courier_tracking_code": "ST499960801ST" }
```

Cancel uses the **carrier's** AWB, not Shippop's `SP...` code. Only
works before pickup; carriers refuse after the first scan.

### POST `/tracking/` — pull tracking events (5.1)

```json
{ "tracking_code": "SP529189074" }
```

Response includes both `states` (array) and `state` (numbered object) —
identical content. We read `states`.

Each event:

```json
{
  "status": "POD",
  "datetime": "2023-10-18 11:17:52",
  "location": "Nonthaburi",
  "description": "Delivery successfully ,จัดส่งพัสดุสำเร็จ"
}
```

Known status codes (mapped in `mapShippopTrackingStatus`):

| Shippop code | Klear ShipmentStatus | Meaning |
|---|---|---|
| `010` | `picked_up` | Shipment picked up |
| `102` | `in_transit` | At hub/transit station |
| `103` | `in_transit` | At destination station |
| `045` | `out_for_delivery` | Out for delivery |
| `POD` | `delivered` | Proof of delivery |
| `complete` | `delivered` | (order-level synonym) |
| `cancel` | `cancelled` | Cancelled |
| `return` | `returned` | Returned to sender |
| `fail` | `delivery_failed` | Delivery failed |
| `ready` | `ready` | Confirmed, awaiting pickup |
| anything else | `in_transit` | Safe default — **never** `delivered` |

Timestamps are Bangkok-local `YYYY-MM-DD HH:mm:ss` (UTC+7) — we
convert to ISO-8601 UTC in `bangkokToIso`.

### POST `/label/` — fetch printable label (6.1)

```json
{ "api_key": "<key>", "purchase_id": "24744979", "type": "html", "size": "sticker4x6" }
```

Response: `{ "status": true, "html": "<!DOCTYPE html>..." }`.

The HTML is fully inline (CSS, fonts) and ready to render. Stash to R2
if you need it beyond the Shippop session — Shippop has not committed
to long-term URL stability.

### POST `/calltopickup/flash/` — Flash pickup request (8.2)

Carrier-specific. Distinct shape from the generic `/calltopickup/`:

```json
{
  "api_key": "<key>",
  "estimateParcelNumber": 10,
  "pickupStaffInfoId": "1000",
  "srcDetailAddress": "...",
  "srcName": "...",
  "srcPhone": "0800000000",
  "srcPostalCode": "10500"
}
```

**Not yet implemented** in `providers/shippop.ts` — added when we wire
the daily-pickup orchestration. Targeted for the same PR that converts
to `AbstractFulfillmentProviderService` (see DEV_TRACKER 2.11).

## Webhooks (7.1)

Shippop POSTs status updates to a URL we register with them. Body is
**`application/x-www-form-urlencoded`** (not JSON):

```
tracking_code=SP452045855&order_status=POD&courier_tracking_code=ST499960801ST&data[datetime]=2026-05-20+16:30:00
```

**No HMAC signature is provided.** Authentication is by IP allowlist
(request from Shippop's published egress) **and** a path secret we
embed in the registered callback URL:

```
https://api.klear.com/webhooks/shippop/<path_secret>
```

`ShippopProvider.verifyAndParseWebhook` rejects the call when the
`path_secret` does not match `SHIPPOP_WEBHOOK_PATH_SECRET`. The Medusa
API route is responsible for extracting the path segment and passing
it through.

Reply must be HTTP 200 with `{ "success": 1 }`.

## Required env (Railway)

```
SHIPPOP_API_KEY=<from Shippop merchant dashboard>
SHIPPOP_API_BASE_URL=https://mall.shippop.com
SHIPPOP_WEBHOOK_PATH_SECRET=<generated; also store in Bitwarden>
SHIPPING_DEFAULT_CARRIER=FLE   # optional; defaults to "FLE"
```

## Open gaps (verify against live API once merchant account exists)

1. Does Shippop offer a sandbox base URL? (Postman collection only references production.)
2. What is the full status-code vocabulary? We covered the documented codes; expect to add more as we observe live webhooks.
3. Confirm webhook source IP range for the firewall allowlist.
4. Are `ref_no_1` / `ref_no_2` echoed back in tracking webhooks? If yes, we can use them to look up the Klear order without a separate `tracking_code → order_id` index.
5. Test the `/label/` HTML rendering on a real label printer + thermal paper before launch.
