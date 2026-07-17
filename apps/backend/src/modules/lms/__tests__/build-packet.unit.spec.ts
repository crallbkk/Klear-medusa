import { buildLabJobPacket } from "../build-packet";
import { PRESCRIPTION_MODULE } from "../../prescription/service";
import { Modules } from "@medusajs/framework/utils";
import type { PrescriptionData } from "../types";

/**
 * Unit tests for buildLabJobPacket. Mocks the container so we exercise the
 * orchestrator's metadata-driven composition + failure matrix without
 * spinning up Medusa.
 */

function makeContainer(opts: {
  order: unknown;
  decryptedRx?: unknown;
  decryptImpl?: (prescriptionId: string) => Promise<unknown>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderModule: any = {
    retrieveOrder: jest.fn().mockResolvedValue(opts.order),
  };
  const decryptForLabHandoff = jest.fn(
    opts.decryptImpl ??
      (async (_id: string) => opts.decryptedRx),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prescriptionService: any = { decryptForLabHandoff };
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === Modules.ORDER) return orderModule;
      if (key === PRESCRIPTION_MODULE) return prescriptionService;
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  return { container, decryptForLabHandoff };
}

const SHIPPING = {
  first_name: "สมชาย",
  last_name: "ใจดี",
  address_1: "123/45 ซอยสุขุมวิท 21",
  city: "วัฒนา",
  province: "กรุงเทพมหานคร",
  postal_code: "10110",
  phone: "+66812345678",
};

function frameLine(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_1",
    variant_sku: "F-RD-001",
    metadata: {
      klear_kind: "frame",
      klear_sku: "KLR-RD-001-BLACK-M",
      klear_prescription_id: "rx_1",
      klear_prescription_status: "active",
      klear_lens_config: {
        lens_type: "single_vision",
        index: 1.67,
        coating_addons: ["anti_reflective"],
      },
      ...overrides,
    },
  };
}

function order(opts: {
  items?: unknown[];
  shipping?: unknown;
  metadata?: Record<string, unknown>;
} = {}) {
  return {
    id: "order_abc",
    items: opts.items ?? [frameLine()],
    shipping_address: opts.shipping === undefined ? SHIPPING : opts.shipping,
    metadata: opts.metadata ?? {},
  };
}

const RX: PrescriptionData = {
  sph_right: -2.5,
  sph_left: -2.25,
  cyl_right: -1.0,
  cyl_left: -0.75,
  axis_right: 90,
  axis_left: 85,
  add_right: null,
  add_left: null,
  pd_right: 31,
  pd_left: 31,
};

describe("buildLabJobPacket — happy path", () => {
  it("composes a packet from frame-line metadata + decrypted Rx", async () => {
    const { container, decryptForLabHandoff } = makeContainer({
      order: order(),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    const p = result.packet;
    expect(p.klear_order_id).toBe("order_abc");
    expect(p.frame_sku).toBe("KLR-RD-001-BLACK-M");
    expect(p.lens_type).toBe("single_vision");
    expect(p.lens_index).toBe(1.67);
    expect(p.coating_addons).toEqual(["anti_reflective"]);
    expect(p.prescription).toEqual(RX);
    expect(p.customer.name).toBe("สมชาย ใจดี");
    expect(p.customer.phone).toBe("+66812345678");
    expect(p.customer.delivery_address.country_code).toBe("TH");
    expect(p.job_ref).toBe("klear-order_abc");
    // Decrypt is called with the prescription id from metadata, not order id.
    expect(decryptForLabHandoff).toHaveBeenCalledWith("rx_1");
  });

  it("prefers the line-item prescription id, ignoring order-level", async () => {
    const { decryptForLabHandoff, container } = makeContainer({
      order: order({ metadata: { klear_prescription_id: "rx_ORDER" } }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("ok");
    expect(decryptForLabHandoff).toHaveBeenCalledWith("rx_1");
  });

  it("falls back to the ORDER-level prescription id (send-later, submitted post-order)", async () => {
    const line = frameLine({
      klear_prescription_id: null,
      klear_prescription_status: "pending",
    });
    const { decryptForLabHandoff, container } = makeContainer({
      order: order({
        items: [line],
        metadata: {
          klear_prescription_id: "rx_ORDER",
          klear_prescription_status: "active",
        },
      }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("ok");
    expect(decryptForLabHandoff).toHaveBeenCalledWith("rx_ORDER");
  });

  it("falls back to variant_sku when klear_sku is absent", async () => {
    const line = frameLine({ klear_sku: undefined });
    const { container } = makeContainer({
      order: order({ items: [line] }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.packet.frame_sku).toBe("F-RD-001");
  });

  it("builds a plano job with null prescription for non_prescription lenses", async () => {
    const line = frameLine({
      klear_prescription_id: null,
      klear_prescription_status: "active",
      klear_lens_config: {
        lens_type: "non_prescription",
        index: null,
        coating_addons: [],
      },
    });
    const { container, decryptForLabHandoff } = makeContainer({
      order: order({ items: [line] }),
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.packet.lens_type).toBe("non_prescription");
    expect(result.packet.prescription).toBeNull();
    expect(decryptForLabHandoff).not.toHaveBeenCalled();
  });
});

describe("buildLabJobPacket — skip", () => {
  it("skips a frame-only order (no lens config, no prescription)", async () => {
    const line = frameLine({
      klear_lens_config: null,
      klear_prescription_id: null,
      klear_prescription_status: "active",
    });
    const { container } = makeContainer({ order: order({ items: [line] }) });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("skip");
  });
});

describe("buildLabJobPacket — pending_rx", () => {
  it("returns pending_rx when an Rx lens has no id but line status is pending", async () => {
    const line = frameLine({
      klear_prescription_id: null,
      klear_prescription_status: "pending",
    });
    const { container } = makeContainer({ order: order({ items: [line] }) });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("pending_rx");
    if (result.outcome !== "pending_rx") return;
    expect(result.snapshot.klear_order_id).toBe("order_abc");
    expect(result.snapshot.lens_type).toBe("single_vision");
  });

  it("returns pending_rx when the ORDER-level status is pending", async () => {
    const line = frameLine({
      klear_prescription_id: null,
      klear_prescription_status: undefined,
    });
    const { container } = makeContainer({
      order: order({
        items: [line],
        metadata: { klear_prescription_status: "pending" },
      }),
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("pending_rx");
  });
});

describe("buildLabJobPacket — failed", () => {
  it("fails on an unknown lens type (no silent default)", async () => {
    const line = frameLine({
      klear_lens_config: {
        lens_type: "magic_lens",
        index: 1.6,
        coating_addons: [],
      },
    });
    const { container } = makeContainer({
      order: order({ items: [line] }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/unknown lens type/i);
    expect(result.reason).toMatch(/magic_lens/);
  });

  it("fails when an Rx-requiring lens has no prescription and is not pending", async () => {
    const line = frameLine({
      klear_prescription_id: null,
      klear_prescription_status: "active",
    });
    const { container } = makeContainer({ order: order({ items: [line] }) });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/requires a prescription/i);
  });

  it("fails (not silently drops) a multi-frame order", async () => {
    const { container } = makeContainer({
      order: order({ items: [frameLine(), frameLine({ klear_sku: "KLR-2" })] }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/multi-pair/i);
  });

  it("fails when a decrypt error is thrown", async () => {
    const { container } = makeContainer({
      order: order(),
      decryptImpl: async () => {
        throw new Error("Prescription rx_1 is deleted — refusing to decrypt");
      },
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/decrypt failed/i);
  });

  it("fails when the shipping address has no phone", async () => {
    const { container } = makeContainer({
      order: order({ shipping: { ...SHIPPING, phone: "" } }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/no phone/i);
  });

  it("fails when the order has no shipping address", async () => {
    const { container } = makeContainer({
      order: order({ shipping: null }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/no shipping address/i);
  });

  it("fails when no line carries klear_kind:frame", async () => {
    const { container } = makeContainer({
      order: order({ items: [{ id: "x", metadata: { klear_kind: "lens" } }] }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/no frame line/i);
  });

  it("fails when the order has no line items", async () => {
    const { container } = makeContainer({
      order: order({ items: [] }),
      decryptedRx: RX,
    });
    const result = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.reason).toMatch(/no line items/i);
  });
});
