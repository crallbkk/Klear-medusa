// Fixtures shared by the feed's unit tests (not a test file itself).

// Values that must never leave Medusa through the feed. Each is distinct
// and searchable, so a leak of any one of them is caught by name.
export const SECRETS = [
  "SECRET-RX-ID-7731",
  "SECRET-SIG-AAAA",
  "SECRET-ORDER-META",
  "SECRET-LINE-META",
  "secret.person@example.test",
  "Secretsurname",
  "99 Secret Soi",
  "+66899990000",
  "SECRET-TRACKING-SP999",
  "SECRET-COURIER-TH999",
  "cus_SECRETCUSTOMER",
  "SECRET-PUBLIC-CODE",
  "SECRET-CATALOG-HANDLE",
];

/** An order as Medusa's query could hand it over, carrying every kind of
 *  value that must not cross. */
export function leakyOrderDetail() {
  return {
    id: "order_A",
    email: "secret.person@example.test",
    customer_id: "cus_SECRETCUSTOMER",
    customer: { id: "cus_SECRETCUSTOMER", email: "secret.person@example.test" },
    metadata: {
      klear_prescription_id: "SECRET-RX-ID-7731",
      klear_prescription_sig: "SECRET-SIG-AAAA",
      note: "SECRET-ORDER-META",
      public_code: "SECRET-PUBLIC-CODE",
    },
    shipping_address: {
      first_name: "Somchai",
      last_name: "Secretsurname",
      address_1: "99 Secret Soi",
      phone: "+66899990000",
    },
    billing_address: { last_name: "Secretsurname", phone: "+66899990000" },
    cart_id: "cart_A",
    cart: { id: "cart_B", email: "secret.person@example.test" },
    // Medusa's own totals, deliberately wrong here: Medusa shrinks them
    // after a return, so the feed must never read them.
    item_total: 1,
    discount_total: 1,
    shipping_total: 1,
    total: 1,
    tax_total: 0,
    shipping_methods: [
      {
        id: "ordsm_1",
        amount: { numeric: 50, raw: { value: "50", precision: 20 } },
        is_tax_inclusive: true,
        tax_lines: [{ rate: 0 }],
        adjustments: [],
        detail: { claim_id: null, exchange_id: null, return_id: null },
      },
    ],
    items: [
      {
        id: "ordli_1",
        title: "Klear Frame",
        subtitle: "Black",
        variant_sku: "KLR-F1",
        product_handle: "SECRET-CATALOG-HANDLE",
        quantity: 1,
        unit_price: 1000,
        is_tax_inclusive: true,
        tax_lines: [{ rate: 0 }],
        adjustments: [{ amount: 100, code: "SECRET-ORDER-META" }],
        // Medusa's figures for the line, ignored.
        subtotal: 1,
        discount_total: 1,
        metadata: {
          klear_prescription_id: "SECRET-RX-ID-7731",
          klear_prescription_sig: "SECRET-SIG-AAAA",
          klear_lens_config: { index: 1.67 },
          other: "SECRET-LINE-META",
        },
      },
      {
        id: "ordli_2",
        title: "Klear Lenses",
        subtitle: null,
        variant_sku: "KLR-LENS-SV167",
        quantity: 1,
        unit_price: "590",
        tax_lines: [],
        adjustments: [],
        subtotal: 1,
        discount_total: 1,
        metadata: { other: "SECRET-LINE-META" },
      },
    ],
  };
}

export const ORDER_ROW = {
  id: "order_A",
  display_id: 42,
  currency_code: "thb",
  sales_channel_id: "sc_1",
  placed_at: "2026-11-20T03:00:00.123456Z",
  canceled_at: null,
  updated_at: "2026-11-20T03:05:00.654321Z",
  version: 3,
};
