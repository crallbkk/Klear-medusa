import {
  decryptPrescription,
  SupabaseVaultError,
  RX_ENC_COLUMNS,
} from "../supabase-vault";

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
    // Binocular 62 → halved 50/50 into each eye (monocular for the lab).
    expect(rx.pd_right).toBe(31);
    expect(rx.pd_left).toBe(31);
  });

  it("preserves asymmetric monocular PD as-is (no summing) when pd_binocular is null", async () => {
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
      ct_pdr: "33",
      ct_pdl: "29",
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
    // Monocular values are kept per-eye, never summed.
    expect(rx.pd_right).toBe(33);
    expect(rx.pd_left).toBe(29);
  });

  it("throws decrypt error when the Vault RPC returns NULL for a present ciphertext (no fabricated 0.00 diopters)", async () => {
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => makeRowResponse(),
    ];
    // Every decrypt call answers null — Number(null) would be 0, i.e. a
    // fabricated plano value, if the guard were missing.
    for (let i = 0; i < 7; i++) {
      handlers.push(() => jsonResponse(200, null));
    }
    const fetchMock = mockFetchSequence(handlers);
    await expect(
      decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "decrypt",
    });
  });

  it("throws decrypt error when the Vault RPC returns an empty string", async () => {
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => makeRowResponse(),
    ];
    for (let i = 0; i < 7; i++) {
      handlers.push(() => jsonResponse(200, ""));
    }
    const fetchMock = mockFetchSequence(handlers);
    await expect(
      decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "decrypt",
    });
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

// Regression guard for M6 (Rx-decrypt contract dedup): the select list and
// the decrypt-column mapping are now BOTH derived from RX_ENC_COLUMNS, so a
// future edit that adds/renames/removes a column can't leave the PostgREST
// fetch and the decrypt step silently out of sync with each other.
describe("RX_ENC_COLUMNS drift guard", () => {
  it("the PostgREST select query contains every column declared in RX_ENC_COLUMNS", async () => {
    let selectUrl = "";
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
      (url) => {
        selectUrl = url;
        return makeRowResponse();
      },
    ];
    for (let i = 0; i < 7; i++) {
      handlers.push((_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        return jsonResponse(200, plaintexts[body.ciphertext]);
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    await decryptPrescription("rx_1", {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(RX_ENC_COLUMNS.length).toBe(11);
    for (const col of RX_ENC_COLUMNS) {
      expect(selectUrl).toContain(col);
    }
  });

  it("maps each *_enc column to the correct DecryptedPrescription field (distinct value per field catches mis-mapping)", async () => {
    // Every column gets its own ciphertext -> its own distinct plaintext,
    // so if the map-based decrypt ever read the wrong column into the
    // wrong output field (e.g. os_axis_enc into axis_right), this fails
    // instead of silently passing because two fields happened to share
    // a value.
    const row = jsonResponse(200, [
      {
        id: "rx_distinct",
        status: "active",
        od_sphere_enc: "ct_od_sphere",
        od_cylinder_enc: "ct_od_cylinder",
        od_axis_enc: "ct_od_axis",
        od_add_enc: "ct_od_add",
        os_sphere_enc: "ct_os_sphere",
        os_cylinder_enc: "ct_os_cylinder",
        os_axis_enc: "ct_os_axis",
        os_add_enc: "ct_os_add",
        pd_binocular_enc: null,
        pd_right_enc: "ct_pd_right",
        pd_left_enc: "ct_pd_left",
      },
    ]);
    const plaintexts: Record<string, string> = {
      ct_od_sphere: "-1.25",
      ct_os_sphere: "-1.75",
      ct_od_cylinder: "-0.25",
      ct_os_cylinder: "-0.50",
      ct_od_axis: "10",
      ct_os_axis: "170",
      ct_od_add: "1.50",
      ct_os_add: "2.00",
      ct_pd_right: "32",
      ct_pd_left: "34",
    };
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => row,
    ];
    // 10 non-null *_enc fields (pd_binocular_enc is null here, so dec()
    // short-circuits without a fetch call for it).
    for (let i = 0; i < 10; i++) {
      handlers.push((_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        return jsonResponse(200, plaintexts[body.ciphertext]);
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    const rx = await decryptPrescription("rx_distinct", {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(rx.sph_right).toBe(-1.25);
    expect(rx.sph_left).toBe(-1.75);
    expect(rx.cyl_right).toBe(-0.25);
    expect(rx.cyl_left).toBe(-0.5);
    expect(rx.axis_right).toBe(10);
    expect(rx.axis_left).toBe(170);
    expect(rx.add_right).toBe(1.5);
    expect(rx.add_left).toBe(2.0);
    // pd_right_enc/pd_left_enc were populated (monocular), so they pass
    // through as-is — no 50/50 binocular split.
    expect(rx.pd_right).toBe(32);
    expect(rx.pd_left).toBe(34);
  });
});

// Supabase's new API keys (sb_secret_...) are not JWTs and must go in the
// `apikey` header only; the legacy JWT service_role key keeps apikey + Bearer
// so the deploy is safe before SUPABASE_SERVICE_ROLE_KEY is switched.
describe("Supabase auth headers by key shape", () => {
  const LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.test-legacy.sig";
  const SECRET_KEY = "sb_secret_test-only";

  /** Runs a full decrypt (row fetch + 7 RPC calls) and returns the
   *  normalised headers of every request, in call order. */
  async function captureHeaders(): Promise<Headers[]> {
    const seen: Headers[] = [];
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      (_url, init) => {
        seen.push(new Headers(init?.headers));
        return makeRowResponse();
      },
    ];
    for (let i = 0; i < 7; i++) {
      handlers.push((_url, init) => {
        seen.push(new Headers(init?.headers));
        return jsonResponse(200, "1");
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    await decryptPrescription("rx_1", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(8);
    return seen;
  }

  it("sends a secret key as apikey only, with no Authorization header, on the row fetch and every decrypt RPC", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_KEY;
    const seen = await captureHeaders();
    for (const h of seen) {
      expect(h.get("apikey")).toBe(SECRET_KEY);
      expect(h.has("authorization")).toBe(false);
    }
  });

  it("keeps apikey + Bearer for the legacy JWT service_role key", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_KEY;
    const seen = await captureHeaders();
    for (const h of seen) {
      expect(h.get("apikey")).toBe(LEGACY_KEY);
      expect(h.get("authorization")).toBe(`Bearer ${LEGACY_KEY}`);
    }
  });

  it("keeps the non-auth headers alongside the key", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_KEY;
    const [rowFetch, ...rpcCalls] = await captureHeaders();
    expect(rowFetch.get("accept")).toBe("application/json");
    for (const h of rpcCalls) {
      expect(h.get("content-type")).toBe("application/json");
      expect(h.get("accept")).toBe("application/json");
    }
  });

  it("trims whitespace pasted around the key before choosing the header shape", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = `  ${SECRET_KEY}\n`;
    const seen = await captureHeaders();
    for (const h of seen) {
      expect(h.get("apikey")).toBe(SECRET_KEY);
      expect(h.has("authorization")).toBe(false);
    }
  });

  it("throws config error when SUPABASE_SERVICE_ROLE_KEY is only whitespace", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "  \n";
    const fetchMock = jest.fn();
    await expect(
      decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "config",
      message: expect.stringContaining("is not set"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Config errors reach Sentry and lab_job.last_error, so none may echo the
  // key. Each case must fail before any request goes out.
  // [label, env value, a fragment of the key that must not leak]
  it.each([
    ["a publishable key", "sb_publishable_test-only", "test-only"],
    ["an unknown sb_ key type", "sb_other_test-only", "test-only"],
    ["a key with a line break inside (wrapped paste)", "sb_secret_wrap\nped", "sb_secret_wrap"],
    ["a key with a CRLF inside", "eyJhbGciOiJIUzI1NiJ9.legacy\r\nwrap.sig", "eyJhbGciOiJIUzI1NiJ9"],
    ["a quoted key", '"sb_secret_test-only"', "test-only"],
  ])(
    "refuses %s with a config error that does not echo the key",
    async (_label, key, fragment) => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
      const fetchMock = jest.fn();
      const err = await decryptPrescription("rx_1", {
        fetch: fetchMock as unknown as typeof fetch,
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "SupabaseVaultError", code: "config" });
      expect((err as Error).message).not.toContain(fragment);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("replaces a thrown fetch error that quotes the key with an rpc error that does not", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_KEY;
    const fetchMock = jest.fn(async () => {
      // Shape of undici's rejection of an invalid header value.
      throw new TypeError(
        `Headers.append: "${SECRET_KEY}" is an invalid header value.`,
      );
    });
    const err = await decryptPrescription("rx_1", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "SupabaseVaultError", code: "rpc" });
    expect((err as Error).message).not.toContain(SECRET_KEY);
    expect((err as Error).message).toContain("network error");
  });

  it("keeps a network error's code (and only the code) on a failed decrypt RPC", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_KEY;
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => makeRowResponse(),
    ];
    for (let i = 0; i < 7; i++) {
      handlers.push(() => {
        throw Object.assign(new TypeError(`fetch failed for ${LEGACY_KEY}`), {
          cause: { code: "ECONNRESET" },
        });
      });
    }
    const err = await decryptPrescription("rx_1", {
      fetch: mockFetchSequence(handlers) as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "SupabaseVaultError", code: "rpc" });
    expect((err as Error).message).toContain("ECONNRESET");
    expect((err as Error).message).not.toContain(LEGACY_KEY);
  });

  it("drops a network error code that is not a plain code (it could carry the key)", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_KEY;
    const fetchMock = jest.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: `bad ${LEGACY_KEY}` },
      });
    });
    const err = await decryptPrescription("rx_1", {
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "SupabaseVaultError", code: "rpc" });
    expect((err as Error).message).toContain("network error");
    expect((err as Error).message).not.toContain(LEGACY_KEY);
  });

  it("trims whitespace around SUPABASE_URL too", async () => {
    process.env.SUPABASE_URL = " https://supa.test\n";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_KEY;
    let rowUrl = "";
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      (url) => {
        rowUrl = url;
        return makeRowResponse();
      },
    ];
    for (let i = 0; i < 7; i++) handlers.push(() => jsonResponse(200, "1"));
    await decryptPrescription("rx_1", {
      fetch: mockFetchSequence(handlers) as unknown as typeof fetch,
    });
    expect(rowUrl.startsWith("https://supa.test/rest/v1/prescriptions?")).toBe(
      true,
    );
  });
});

// The storefront treats a missing cylinder as "no astigmatism" and stores no
// ciphertext for it (Website `src/lib/prescription/schema.ts`). Medusa used to
// reject such a prescription as `incomplete`, failing the lab job of every
// customer without astigmatism (seen on a production test order, 27 Oct).
describe("optional cylinder (no astigmatism)", () => {
  function rowWith(overrides: Record<string, string | null>): Response {
    return jsonResponse(200, [
      {
        id: "rx_cyl",
        status: "active",
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
        ...overrides,
      },
    ]);
  }

  /** Decrypts `row`, answering each RPC call from `plaintexts`. Expects
   *  exactly one RPC call per non-null ciphertext in the row. */
  async function decryptWith(
    row: Response,
    plaintexts: Record<string, string>,
  ) {
    const handlers: Array<(url: string, init?: RequestInit) => Response> = [
      () => row,
    ];
    for (let i = 0; i < Object.keys(plaintexts).length; i++) {
      handlers.push((_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        return jsonResponse(200, plaintexts[body.ciphertext]);
      });
    }
    const fetchMock = mockFetchSequence(handlers);
    return decryptPrescription("rx_cyl", {
      fetch: fetchMock as unknown as typeof fetch,
    });
  }

  it("decrypts a sphere-only prescription (no cylinder stored) with cylinder 0 on both eyes", async () => {
    // The exact shape of the 27 Oct production test order's row.
    const rx = await decryptWith(
      rowWith({
        od_sphere_enc: "ct_od_sph",
        os_sphere_enc: "ct_os_sph",
        pd_binocular_enc: "ct_pd",
      }),
      { ct_od_sph: "-1.75", ct_os_sph: "-2.00", ct_pd: "63" },
    );
    expect(rx).toEqual({
      sph_right: -1.75,
      sph_left: -2,
      cyl_right: 0,
      cyl_left: 0,
      axis_right: null,
      axis_left: null,
      add_right: null,
      add_left: null,
      pd_right: 31.5,
      pd_left: 31.5,
    });
  });

  it("fills in 0 only for the eye that has no cylinder", async () => {
    const rx = await decryptWith(
      rowWith({
        od_sphere_enc: "ct_od_sph",
        os_sphere_enc: "ct_os_sph",
        od_cylinder_enc: "ct_od_cyl",
        od_axis_enc: "ct_od_axis",
        pd_binocular_enc: "ct_pd",
      }),
      {
        ct_od_sph: "-1.00",
        ct_os_sph: "-1.25",
        ct_od_cyl: "-0.75",
        ct_od_axis: "90",
        ct_pd: "62",
      },
    );
    expect(rx.cyl_right).toBe(-0.75);
    expect(rx.axis_right).toBe(90);
    expect(rx.cyl_left).toBe(0);
    expect(rx.axis_left).toBeNull();
  });

  it("still refuses a prescription without a sphere value", async () => {
    await expect(
      decryptWith(
        rowWith({ os_sphere_enc: "ct_os_sph", pd_binocular_enc: "ct_pd" }),
        { ct_os_sph: "-1.25", ct_pd: "62" },
      ),
    ).rejects.toMatchObject({
      name: "SupabaseVaultError",
      code: "incomplete",
      message: expect.stringContaining("missing sphere values"),
    });
  });
});
