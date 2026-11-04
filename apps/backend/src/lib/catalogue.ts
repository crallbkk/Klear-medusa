/**
 * SKU prefix of the Medusa "Klear Lenses" product (variants KLR-LENS-SV150,
 * KLR-LENS-SV167, ...). Checkout adds every pair as two line items, a frame
 * variant and a lens variant from this product. Must match the storefront's
 * `LENS_SKU_PREFIX` (Klear `src/lib/cart/to-medusa.ts`).
 */
export const LENS_SKU_PREFIX = "KLR-LENS-";

export function isLensSku(sku: string | null | undefined): boolean {
  return typeof sku === "string" && sku.toUpperCase().startsWith(LENS_SKU_PREFIX);
}
