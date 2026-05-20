import { buildLabJobPacket } from "../build-packet";
import { PRESCRIPTION_MODULE } from "../../prescription/service";
import { Modules } from "@medusajs/framework/utils";

/**
 * Unit test for buildLabJobPacket. Mocks the container so we test the
 * orchestrator's composition logic without spinning up Medusa.
 */

function makeContainer(opts: {
  order: unknown;
  decryptedRx: unknown;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderModule: any = {
    retrieveOrder: jest.fn().mockResolvedValue(opts.order),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prescriptionService: any = {
    decryptForLabHandoff: jest.fn().mockResolvedValue(opts.decryptedRx),
  };
  return {
    resolve: jest.fn((key: string) => {
      if (key === Modules.ORDER) return orderModule;
      if (key === PRESCRIPTION_MODULE) return prescriptionService;
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
}

const SAMPLE_ORDER = {
  id: "order_abc",
  items: [
    {
      id: "item_1",
      variant_sku: "F-RD-001",
      metadata: {
        klear_sku: "KLR-RD-001-BLACK-M",
        klear_prescription_id: "rx_1",
        klear_lens_config: {
          lens_type: "single_vision",
          index: 1.6,
          coating_addons: ["anti_reflective"],
        },
      },
    },
  ],
  shipping_address: {
    first_name: "สมชาย",
    last_name: "ใจดี",
    address_1: "123/45 ซอยสุขุมวิท 21",
    city: "วัฒนา",
    province: "กรุงเทพมหานคร",
    postal_code: "10110",
    phone: "+66812345678",
  },
};

const SAMPLE_RX = {
  sph_right: -2.5,
  sph_left: -2.25,
  cyl_right: -1.0,
  cyl_left: -0.75,
  axis_right: 90,
  axis_left: 85,
  add_right: null,
  add_left: null,
  pd: 62,
};

describe("buildLabJobPacket", () => {
  it("composes a LabJobPacket from order + decrypted Rx + Klear metadata", async () => {
    const container = makeContainer({
      order: SAMPLE_ORDER,
      decryptedRx: SAMPLE_RX,
    });
    const packet = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(packet.klear_order_id).toBe("order_abc");
    expect(packet.frame_sku).toBe("KLR-RD-001-BLACK-M");
    expect(packet.lens_type).toBe("single_vision");
    expect(packet.lens_index).toBe(1.6);
    expect(packet.coating_addons).toEqual(["anti_reflective"]);
    expect(packet.prescription).toEqual(SAMPLE_RX);
    expect(packet.customer.name).toBe("สมชาย ใจดี");
    expect(packet.customer.phone).toBe("+66812345678");
    expect(packet.customer.delivery_address.country_code).toBe("TH");
    expect(packet.customer.delivery_address.postal_code).toBe("10110");
    expect(packet.job_ref).toBe("klear-order_abc");
  });

  it("falls back to variant_sku when klear_sku is missing", async () => {
    const order = {
      ...SAMPLE_ORDER,
      items: [{ ...SAMPLE_ORDER.items[0], metadata: {} }],
    };
    const container = makeContainer({
      order,
      decryptedRx: SAMPLE_RX,
    });
    const packet = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(packet.frame_sku).toBe("F-RD-001");
    expect(packet.lens_type).toBe("single_vision"); // default
    expect(packet.coating_addons).toEqual([]);
  });

  it("rejects unknown lens types, defaulting to single_vision", async () => {
    const order = {
      ...SAMPLE_ORDER,
      items: [
        {
          ...SAMPLE_ORDER.items[0],
          metadata: {
            ...SAMPLE_ORDER.items[0].metadata,
            klear_lens_config: {
              lens_type: "magic_lens",
              index: 1.6,
              coating_addons: [],
            },
          },
        },
      ],
    };
    const container = makeContainer({
      order,
      decryptedRx: SAMPLE_RX,
    });
    const packet = await buildLabJobPacket({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      orderId: "order_abc",
    });
    expect(packet.lens_type).toBe("single_vision");
  });

  it("throws when shipping address has no phone", async () => {
    const order = {
      ...SAMPLE_ORDER,
      shipping_address: {
        ...SAMPLE_ORDER.shipping_address,
        phone: "",
      },
    };
    const container = makeContainer({
      order,
      decryptedRx: SAMPLE_RX,
    });
    await expect(
      buildLabJobPacket({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container: container as any,
        orderId: "order_abc",
      }),
    ).rejects.toThrow(/no phone/);
  });

  it("throws when order has no shipping address", async () => {
    const order = { ...SAMPLE_ORDER, shipping_address: null };
    const container = makeContainer({
      order,
      decryptedRx: SAMPLE_RX,
    });
    await expect(
      buildLabJobPacket({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container: container as any,
        orderId: "order_abc",
      }),
    ).rejects.toThrow(/no shipping address/);
  });

  it("throws when order has no line items", async () => {
    const order = { ...SAMPLE_ORDER, items: [] };
    const container = makeContainer({
      order,
      decryptedRx: SAMPLE_RX,
    });
    await expect(
      buildLabJobPacket({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        container: container as any,
        orderId: "order_abc",
      }),
    ).rejects.toThrow(/no line items/);
  });
});
