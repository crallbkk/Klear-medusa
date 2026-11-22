# Routes for Klear Operations

Klear Operations reads from Medusa through the feed routes (`/ops-feed/*`)
and pushes its stock figures to the two stock sync routes (`/ops-sync/*`).
Medusa never writes into Operations. The contracts are in the accounting
repository, `integration-contracts/`: contract 1 (commerce feed), contract 2
(lab usage, see `src/modules/lms/README.md`) and contract 5 (stock sync).

## Routes

| Route | Contract | Secret | Writes |
|---|---|---|---|
| `GET /ops-feed/orders?after=&limit=` | 1, orders | `KLEAR_OPS_FEED_SECRET` | nothing |
| `GET /ops-feed/fulfillments?after=&limit=` | 1, fulfillments | `KLEAR_OPS_FEED_SECRET` | nothing |
| `GET /ops-feed/lab-releases?after=&limit=` | 2 | `KLEAR_OPS_FEED_SECRET` | nothing |
| `POST /ops-sync/frame-stock` | 5, part 1 (report-only) | `KLEAR_STOCK_SYNC_SECRET` | nothing |
| `POST /ops-sync/lens-stock` | 5, part 2 | `KLEAR_LENS_SNAPSHOT_SECRET` | the lab's lens snapshot |

1. **Authentication.** A bearer secret per row above, at least 32
   characters, compared as SHA-256 digests in constant time (`auth.ts`).
   Unset or too short means the route answers 503. No secret opens another
   one's route, so the read-only feed secret cannot write the snapshot. If
   two of the three variables hold the same value, the routes of both
   answer 503 until they differ, with the same body as an unset secret;
   the reason goes only to the log, by variable name (compared as
   digests; no value or digest is logged).
2. **Not admin routes.** Medusa checks a sign-in only under `/admin` and
   `/store`, and `api/middlewares.ts` adds nothing under `/ops-*`. An admin
   session, a customer token, a publishable key or a secret API key is
   refused with 401 (tested against the real server).
3. **Errors.** A database error's text holds the SQL and its values, so a
   failure is logged and sent to Sentry by its kind only (class, code),
   and the caller gets a fixed sentence. A record the feed cannot serve
   (`FeedValueError`: a missing amount, a fractional quantity, tax) stops
   its stream; the log line and Sentry (`record_id`) name the order's or
   fulfillment's Medusa id and the field, never a value, so someone can
   look at it in Medusa. The caller still gets the fixed sentence.

## What crosses

### Orders (`GET /ops-feed/orders`)

```
{ orders: [ { id, display_id, cart_id, placed_at, currency_code,
              item_total_satang, discount_total_satang,
              shipping_total_satang, total_satang, canceled_at,
              sales_channel_id, version, updated_at,
              lines: [ { id, sku, description, quantity,
                         gross_satang, discount_satang } ] } ],
  next_after, has_more, polled_through }
```

1. **The order as it was placed**, whenever it is first read: its
   version-1 lines, quantities, unit prices, line adjustments, shipping
   methods and shipping adjustments.
   1. Medusa 2.14 writes every later change to an order as a new version
      (`order_item`, `order_shipping`, and the line and shipping
      adjustments each carry a `version`) and leaves the version-1 rows as
      they were. Checked against the real server, row by row, after a
      fulfillment, a received return, a claim adding a new line, a claim
      topping up a line, an exchange with return shipping, an order edit
      adding a line and changing a quantity, and a reset of the current
      adjustments: the version-1 rows were all there and unchanged.
   2. So none of those moves an amount or a line here, and a backfill
      (cursor null) gives the same record as the first read. The
      real-server test `ops-feed.spec.ts` does each of them and compares.
   3. Medusa's own totals are never read: its line `subtotal` and
      `discount_total` shrink after a return (they are worked out on the
      quantity less what came back), and its order totals include later
      versions.
   4. **Draft orders.** An order converted from a draft is read at version
      1 too. A draft edited before conversion moves through versions while
      still a draft, so its version 1 may not be what was finally sold.
      Klear makes no draft orders; such an order has no cart id and is on
      Operations' exception list already (design 8.1 item 5). Open for the
      owner if draft orders are ever used.
2. **`version`, an addition to contract 1 that the owner has to accept.**
   Medusa's current version of the order, a whole number. It rises with
   every later change (a fulfillment, a return, a claim, an edit); the
   amounts do not move with it. It lets Operations see that something
   happened after placement. Adding an optional field is not a new
   contract version (contract README, rule 6), but it is not in the
   contract's field list.
3. A line: its Medusa line id, its variant SKU, `description` (the
   product title, then ` / ` and the variant title when there is one), its
   quantity as placed, `gross_satang` (unit price times that quantity) and
   `discount_satang` (its adjustments, in what the customer paid).
4. **Rounding: once per family of figures, then shared out.** The lines'
   gross amounts, the lines' discounts, the shipping amounts and the
   shipping discounts are each added up exactly, rounded once to the
   satang (half away from zero), and the satang are shared out to the
   lines (or methods) by largest remainder, ties by id. A 100 baht
   discount over three 100 baht lines is 3334 + 3333 + 3333 satang, a
   discount total of 10000 and a total of 20000, as Medusa and the Opn
   charge say. These hold exactly for every record:
   1. `item_total_satang` = the lines' `gross_satang` less their
      `discount_satang`, added up;
   2. `shipping_total_satang` = the shipping amounts less the shipping
      discounts;
   3. `discount_total_satang` = the lines' discounts plus the shipping
      discounts;
   4. `total_satang` = `item_total_satang` + `shipping_total_satang`.
   A total can still differ from Medusa's by a satang only when both a
   line's price and its discount have fractions of a satang, which Klear's
   whole-baht prices do not.
5. **Tax.** Klear is not VAT-registered and the store's rate is 0, but
   orders placed before 2026-10-11 can carry a 7 % tax line. Those prices
   were tax-inclusive: a tax-inclusive line or shipping method is served at
   its price, whatever the rate, and an adjustment that is not
   tax-inclusive counts with the tax on it, as Medusa counts it. Only a
   non-zero rate on a tax-EXCLUSIVE line or method is refused
   (`FeedValueError`, naming the order), because tax on top of the price
   is not carried and the figure would be short. Medusa's tax figure is
   never carried.
6. **Credit lines are not subtracted.** Store credit or a gift card on an
   order is not in these figures, so such an order would be served above
   its charge. Klear uses neither today.
7. Draft orders are not served until converted (converting updates them).
   A deleted order is not served; Operations' nightly comparison finds it.
8. **Found while testing, Medusa's, not the feed's:** Medusa 2.14's order
   module fails to receive a return on an order that has a shipping
   discount ("Order shipping method adjustment with version: 4 ... already
   exists": it copies the shipping adjustment twice into one version).
   Checked with the module's own `createReturn` and `receiveReturn`; the
   admin return workflow was not tried.

### Fulfillments (`GET /ops-feed/fulfillments`)

```
{ fulfillments: [ { id, order_id, created_at, kind,
                    quoted_shipping_satang, canceled_at, delivered_at,
                    updated_at,
                    lines: [ { line_item_id, sku, quantity } ] } ],
  next_after, has_more, polled_through }
```

1. Only fulfillments linked to an order. A return's inbound fulfillment is
   linked to the return, ships nothing and is not served.
2. `kind` is `replacement` when the fulfillment ships an item that a claim
   or an exchange added to the order before the fulfillment was made,
   `original` otherwise. Medusa 2.14 records that only on the order change
   action that added the line (`ITEM_ADD` with a claim or exchange id).
   "Before the fulfillment" matters: a claim can add more of an existing
   line, and the line's earlier shipment must stay `original`. A
   fulfillment's kind therefore never changes once served. The flip side:
   once a claim has topped up a line, every later fulfillment of that line
   is `replacement`, also one that ships a piece of the original order
   late.
3. `quoted_shipping_satang` is Shippop's price at booking. The Shippop
   adapter stores it on the fulfillment as `cost_thb` from this change on;
   older fulfillments, and any not booked through Shippop, have null.
4. A line: the order line it ships, the SKU Medusa put on the fulfillment
   item (the inventory item's, else the variant's), the quantity.

### Never crosses

1. Order or line metadata (it carries the prescription id and signature
   and the lens configuration), the packet, prescription ids.
2. The customer, their name, addresses, email and phone.
3. Catalog attributes (handle, collection, type, options) and tracking
   numbers. Of a fulfillment's provider data only `cost_thb` is selected.
4. The routes accept `after` and `limit` and nothing else: a field list,
   or any other parameter, is answered 400.

Each record is built field by field from a named list (`commerce.ts`),
never by copying an object and removing fields. Medusa's query is asked
for whole lines (`items.*`), because a line's quantity asked for by name
comes back empty; that line data, metadata included, is read into memory
and never into a record.

## The cursor

Records come in ascending order of (updated time, id). The cursor is the
last record's `updated_at`, in UTC to the microsecond as Postgres keeps
it, then `|`, then its id, and it is exclusive: send `next_after` back as
`after` and the next page starts after that record, also among records
that share the same time. A record updated in the last 60 seconds of
Medusa's database clock is held back, so a transaction that commits late
is still read. A record changed after it was served gets a new updated
time and is served again (a cancelled order, a delivered or cancelled
fulfillment). To re-read the 10 minutes before a cursor, send that time
with an empty id (`2026-11-23T09:50:00.000000Z|`). `has_more` says the
page was full. `polled_through` is Medusa's clock less 60 seconds, given
only when `has_more` is false: everything updated up to then has been
served (design 11.1 item 3). With nothing new, `next_after` is the cursor
that was sent.

## Stock sync, report-only (`POST /ops-sync/frame-stock`)

```
request  { watermark: "<a fulfillments cursor>" | null,
           frames: [ { inventory_item_id, on_hand } ] }
response { mode: "report_only",
           frames: [ { inventory_item_id, known, settled, medusa_stocked,
                       expected, difference, written: false } ] }
```

1. Decision D2 (2026-11-18): report-only. Nothing is ever written; a
   person corrects Medusa from Operations' exception list.
2. The watermark is a position in the fulfillments feed, (updated time,
   id): the ledger has taken in every order fulfillment at or before it, in
   its current state, and none after it.
3. A frame is **settled** when none of its order fulfillments is after the
   watermark. Then whatever Medusa shipped or took back, the ledger has
   seen, so `expected` is the ledger's on-hand and `difference` is
   Medusa's stocked quantity (all locations) less it.
4. A frame is **not settled**, and gets no `expected` and no
   `difference`, when:
   1. any of its order fulfillments is after the watermark. That includes
      one created before the watermark's record but updated after it (a
      delivery scan, a cancel): the feed has not served it in that state,
      and the ledger's figure may not reflect it. Reporting a difference
      then would invite a person to "correct" Medusa wrongly;
   2. any fulfillment of it, linked to an order or not, was created or
      updated in the last 60 seconds. Medusa takes the stock off
      (`adjustInventoryLevelsStep`) before it links the fulfillment to its
      order, in a separate step, so for a moment the stock is gone and no
      order fulfillment explains it. A fulfillment that is never linked (a
      return's inbound one) is never served, so it holds a frame back for
      those 60 seconds only.
5. The comparison runs inside the same per-item lock Medusa's stock
   adjustment takes.
6. **Clocks and staleness.** `settled` compares Medusa's `updated_at`
   (written by the application's clock) with the database's clock for the
   60 seconds; the two must agree within that. A frame that shipped within
   the last poll interval plus 60 seconds is unsettled by design.
   Operations should alert when a frame stays unsettled for several cycles
   in a row: it means the feed is not keeping up.
7. A frame whose inventory item does not exist is `known: false`.
8. One watermark per request: it is the ledger's fulfillment cursor,
   which is the same for every frame.
9. Not built, because they guard a write: the frame allowlist, the
   explained-change limit (receipt movements in the request are not read),
   the pause switch and the daily cap. They come with the writer mode.

## Lens snapshot (`POST /ops-sync/lens-stock`)

```
request  { as_of: "YYYY-MM-DD", lenses: [ { sku, on_hand } ] }
response { as_of, stored }
409 older_than_stored; 422 not_a_release or not_yet_closed
```

Replaces the lab system's lens snapshot. See "Lens stock" in
`src/modules/lms/README.md`.

## Tests

1. Unit: `__tests__/commerce.unit.spec.ts` (cursor, money, the two
   records), `__tests__/commerce-routes.unit.spec.ts` (auth, parameters,
   the page, failures), `../ops-sync/__tests__/stock-sync.unit.spec.ts`.
2. Real server: `integration-tests/http/ops-feed.spec.ts` makes real
   orders and fulfillments through Medusa's modules, pages through both
   streams with small pages and shared timestamps, cancels and delivers
   after a record was served, and checks that none of a list of secret
   values written into metadata, addresses and tracking data appears.
