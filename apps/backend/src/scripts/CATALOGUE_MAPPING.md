# Catalogue Field Mapping — `frames.ts` → Medusa

Source of truth for `migrate-catalogue.ts`. Documents how the storefront's
`FrameProduct` shape (`Klear/src/lib/catalogue/frames.ts`) maps onto Medusa
v2 product/variant + metadata.

## Decision: one product per SKU (single variant)

The storefront treats each color as its own URL (`klear-classic-round-black`
vs `klear-classic-round-tortoise`) with its own handle. Mirroring that as
one Medusa product per SKU keeps the `/shop/[handle]` PDP wiring trivial —
no variant selector UI, one handle per page. If colors should later be
collapsed into a single product with a Color option, it's an additive
follow-up.

## Field map

| `FrameProduct` field | Medusa core | Notes |
|---|---|---|
| `handle` | `product.handle` | Upsert key |
| `name.en` | `product.title` |  |
| `description.en` | `product.description` |  |
| `status === "active"` | `product.status: "published"` | Anything else → `"draft"` |
| `price_thb` | `variant.prices[0].amount` | THB has no minor unit; stored as-is |
| `sku` | `variant.sku` |  |
| — | `product.options` | Single option `Default = ["Default"]` (Medusa requires it) |
| — | `variant.title` | `"Default"` |
| — | `variant.manage_inventory` | `true` (Bangkok Warehouse stock) |
| — | `product.sales_channels` | Default Sales Channel |
| — | `product.shipping_profile_id` | Default standard profile (created if missing) |

## Stored in `metadata` (no query need beyond lookup-by-handle)

| Storefront field | `metadata` key |
|---|---|
| `name.th` | `name_th` |
| `blurb.{en,th}` | `blurb_en`, `blurb_th` |
| `description.th` | `description_th` |
| `shape` | `shape` |
| `material` | `material` |
| `size` | `size` |
| `mount_type` | `mount_type` (enum, see below) |
| `recommended_face_shapes` | `recommended_face_shapes` (JSON array) |
| `progressives_supported` | `progressives_supported` (bool) |
| `images.{front,three_quarter,side,on_face}` | `images.*` (R2 keys) |
| `ar_glb_key` | `ar_glb_key` (R2 key or null) |
| `spec` (lab dims) | `spec` (JSON object) |
| `sort_order` | `sort_order` |
| `status` (storefront enum) | `klear_status` (kept alongside Medusa `status` since Medusa only has published/draft) |

## `mount_type` enum

Values: `"full_rim" | "half_rim" | "rimless" | "drilled"`. Drives the
storefront's rimless/drilled → 1.67-only lens gate (Klear
`DECISIONS.md` "Base lens index — 1.56"; Klear `BACKLOG.md` M15). The
1.56 base lens resin is too brittle for drill mounts / unsupported
edges, so rimless + drilled frames must fulfil in 1.67 MR-7.

Enforced at two boundaries in the storefront:
- Presentation: `src/components/flow/lens-select-view.tsx` disables the
  Basic (1.56) tile on rimless/drilled frames.
- Money boundary: `assertFrameLensCompatibility` in
  `src/lib/medusa/checkout.ts` refuses to sync the cart with an
  incompatible pairing.

Missing / unrecognised value → `"full_rim"` (safe pass) both in the
migration's `buildMetadata` and in the storefront's `readMountType`.
Every seed row in `frame-seed.ts` sets it explicitly — an added SKU
must answer this question before it ships. Rewrite the migration by
re-running `npx medusa exec ./src/scripts/migrate-catalogue.ts` after
setting the field on new rows.

## Why not separate models?

- **Categories for shape/material/size**: defer. Filters on `/shop` can run
  off `metadata` via fields query for now. Promote to Categories if/when we
  need PLP URLs like `/shop/round` for SEO.
- **`frame_attrs` custom module table for `spec`**: defer. The lab handoff
  reads `spec` directly from the storefront data file today. When the lab
  handoff path moves to consume Medusa, we'll evaluate whether `metadata`
  JSON is enough or if we need a typed table.

## Stale demo products

The script builds the set of `seed_handles` and lists every other product
in the store. By default it warns. With `PURGE=true` (env) or `--purge`
(argv) it deletes them — used once to remove the leftover "Medusa T-Shirt".
