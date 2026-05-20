import { decryptPrescription, SupabaseVaultError } from "../supabase-vault";

const PREV_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...PREV_ENV,
    SUPABASE_URL: "https://supa.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  };
});

afterEach(() => {
  process.env = { ...PREV_ENV };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Response>,
): jest.Mock {
  let i = 0;
  const spy = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const handler = handlers[i++];
    if (!handler) {
      throw new Error(`unexpected fetch call ${i} to ${url}`);
    }
    return handler(String(url), init);
  });
  return spy as unknown as jest.Mock;
}

function makeRowResponse(): Response {
  return jsonResponse(200, [
    {
      id: "rx_1",
      status: "active",
      od_sphere_enc: "ct_od_sph",
      od_cylinder_enc: "ct_od_cyl",
      od_axis_enc: "ct_od_axis",
      od_add_enc: null,
      os_sphere_enc: "ct_os_sph",
      os_cylinder_enc: "ct_os_cyl",
      os_axis_enc: "ct_os_axis",
      os_add_enc: null,
      pd_binocular_enc: "ct_pd_bin",
      pd_right_enc: null,
      pd_left_enc: null,
    },
  ]);
}

describe("decryptPrescription", () => {
  it("fetches the row + decrypts every populated field", async () => {
    // Map from ciphertext → plaintext for the fake Vault.
    const plaintexts: Record<string, string> = {
      ct_od_sph: "-2.5",
      ct_od_cyl: "-1.0",
      ct_od_axis: "90",
      ct_os_sph: "-2.25",
      ct_os_cyl: "-0.75",
      ct_os_axis: "85",
      ct_pd_bin: "62",
    };

    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      // row fetch
      () => makeRowResponse(),
    ];
    // decryption RPC calls — one per non-null ciphertext (7 here).
    for (let i = 0; i < 7; i++) {
      handlers.push((url, init) => {
        // Verify we hit the canonical Vault RPC name + send the
        // prescription_master_key alias on every call.
        expect(url).toContain("/rpc/decrypt_with_vault_key");
        const body = JSON.parse((init?.body as string) ?? "{}");
        expect(body.key_alias).toBe("prescription_master_key");
        const pt = plaintexts[body.ciphertext];
        return jsonResponse(200, pt);
      });
    }

    const fetchMock = mockFetchSequence(handlers);
    const rx = await decryptPrescription("rx_1", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(rx.sph_right).toBe(-2.5);
    expect(rx.sph_left).toBe(-2.25);
    expect(rx.cyl_right).toBe(-1.0);
    expect(rx.cyl_left).toBe(-0.75);
    expect(rx.axis_right).toBe(90);
    expect(rx.axis_left).toBe(85);
    expect(rx.add_right).toBeNull();
    expect(rx.add_left).toBeNull();
    expect(rx.pd).toBe(62);
  });

  it("uses pd_right + pd_left when pd_binocular is null", async () => {
    const row = jsonResponse(200, [
      {
        id: "rx_2",
        status: "active",
        od_sphere_enc: "ct_a",
        od_cylinder_enc: "ct_b",
        od_axis_enc: null,
        od_add_enc: null,
        os_sphere_enc: "ct_c",
        os_cylinder_enc: "ct_d",
        os_axis_enc: null,
        os_add_enc: null,
        pd_binocular_enc: null,
        pd_right_enc: "ct_pdr",
        pd_left_enc: "ct_pdl",
      },
    ]);
    const plaintexts: Record<string, string> = {
      ct_a: "-1.0",
      ct_b: "0",
      ct_c: "-1.0",
      ct_d: "0",
      ct_pdr: "31",
      ct_pdl: "31",
    };

    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => row,
    ];
    for (let i = 0; i < 6; i++) {
      handlers.push((_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        return jsonResponse(200, plaintexts[body.ciphertext]);
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    const rx = await decryptPrescription("rx_2", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(rx.pd).toBe(62);
  });

  it("throws not_found when Supabase returns no row", async () => {
    const fetchMock = mockFetchSequence([() => jsonResponse(200, [])]);
    await expect(
      decryptPrescription("rx_missing", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(SupabaseVaultError);
  });

  it("throws status_invalid when prescription is not active", async () => {
    const fetchMock = mockFetchSequence([
      () =>
        jsonResponse(200, [
          {
            id: "rx_deleted",
            status: "deleted",
            od_sphere_enc: null,
            od_cylinder_enc: null,
            od_axis_enc: null,
            od_add_enc: null,
            os_sphere_enc: null,
            os_cylinder_enc: null,
            os_axis_enc: null,
            os_add_enc: null,
            pd_binocular_enc: null,
            pd_right_enc: null,
            pd_left_enc: null,
          },
        ]),
    ]);
    await expect(
      decryptPrescription("rx_deleted", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "status_invalid",
    });
  });

  it("throws config error when SUPABASE_URL is missing", async () => {
    delete process.env.SUPABASE_URL;
    const fetchMock = jest.fn();
    await expect(
      decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "config",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws config error when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fetchMock = jest.fn();
    await expect(
      decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "config",
    });
  });

  it("throws incomplete when both pd_binocular and pd_right/left are absent", async () => {
    const row = jsonResponse(200, [
      {
        id: "rx_incomplete",
        status: "active",
        od_sphere_enc: "ct_a",
        od_cylinder_enc: "ct_b",
        od_axis_enc: null,
        od_add_enc: null,
        os_sphere_enc: "ct_c",
        os_cylinder_enc: "ct_d",
        os_axis_enc: null,
        os_add_enc: null,
        pd_binocular_enc: null,
        pd_right_enc: null,
        pd_left_enc: null,
      },
    ]);
    const plaintexts: Record<string, string> = {
      ct_a: "-1.0",
      ct_b: "0",
      ct_c: "-1.0",
      ct_d: "0",
    };
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => row,
    ];
    for (let i = 0; i < 4; i++) {
      handlers.push((_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        return jsonResponse(200, plaintexts[body.ciphertext]);
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    await expect(
      decryptPrescription("rx_incomplete", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "incomplete",
    });
  });
});
