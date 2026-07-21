import {
  Sentry,
  __resetSentryInitForTests,
  captureException,
  captureMessage,
  initSentry,
  scrub,
  scrubBreadcrumb,
  scrubSentryEvent,
} from "../sentry";

const ORIGINAL_DSN = process.env.SENTRY_DSN;

afterEach(() => {
  __resetSentryInitForTests();
  if (ORIGINAL_DSN === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = ORIGINAL_DSN;
  }
  jest.restoreAllMocks();
});

describe("scrub — PDPA denylist redactor", () => {
  it("redacts every decrypted Rx field while passing opaque ids through untouched", () => {
    const input = {
      order_id: "order_01H...",
      lab_job_id: "labjob_01H...",
      tracking_number: "TH123456789",
      shipment_id: "shp_01H...",
      cart_id: "cart_01H...",
      status: "shipped",
      // Decrypted-field vocabulary (modules/lms/types.ts PrescriptionData)
      sph_right: -2.5,
      sph_left: -2.25,
      cyl_right: -0.5,
      cyl_left: -0.75,
      axis_right: 90,
      axis_left: 85,
      add_right: 1.5,
      pd_binocular: 62,
      pd_right: 31,
      pd_left: 31,
      // Encrypted-at-rest column vocabulary (supabase-vault.ts)
      od_sphere_enc: "AQIDBAU=",
      os_cylinder_enc: "BgcICQo=",
      prescription: { anything: "nested Rx object" },
      ciphertext: "opaque-blob",
      plaintext: "-2.50 SPH",
      decrypted: true,
    };

    const out = scrub(input) as Record<string, unknown>;

    // Opaque operational ids survive — required for ops debugging.
    expect(out.order_id).toBe("order_01H...");
    expect(out.lab_job_id).toBe("labjob_01H...");
    expect(out.tracking_number).toBe("TH123456789");
    expect(out.shipment_id).toBe("shp_01H...");
    expect(out.cart_id).toBe("cart_01H...");
    expect(out.status).toBe("shipped");

    // Every Rx field is redacted.
    for (const key of [
      "sph_right",
      "sph_left",
      "cyl_right",
      "cyl_left",
      "axis_right",
      "axis_left",
      "add_right",
      "pd_binocular",
      "pd_right",
      "pd_left",
      "od_sphere_enc",
      "os_cylinder_enc",
      "prescription",
      "ciphertext",
      "plaintext",
      "decrypted",
    ]) {
      expect(out[key]).toBe("[redacted]");
    }
  });

  it("redacts secrets/credentials and drops them even when nested", () => {
    const input = {
      order_id: "order_1",
      nested: {
        supabase_service_role_key: "sbp_abc123",
        key_alias: "prescription_master_key",
        api_key: "sk_live_abc",
        authorization: "Bearer eyJhbGci...",
        password: "hunter2",
        session_token: "tok_abc",
        vault_secret: "abc",
      },
    };

    const out = scrub(input) as Record<string, unknown>;
    expect(out.order_id).toBe("order_1");
    const nested = out.nested as Record<string, unknown>;
    for (const key of Object.keys(input.nested)) {
      expect(nested[key]).toBe("[redacted]");
    }
  });

  it("redacts customer PII fields", () => {
    const input = {
      order_id: "order_1",
      email: "customer@example.com",
      phone: "+66812345678",
      first_name: "Somchai",
      last_name: "Rattana",
      delivery_address: { line1: "123 Sukhumvit", city: "Bangkok" },
      line_user_id: "U1234567890abcdef",
    };

    const out = scrub(input) as Record<string, unknown>;
    expect(out.order_id).toBe("order_1");
    expect(out.email).toBe("[redacted]");
    expect(out.phone).toBe("[redacted]");
    expect(out.first_name).toBe("[redacted]");
    expect(out.last_name).toBe("[redacted]");
    expect(out.line_user_id).toBe("[redacted]");
    // Whole subtree dropped in one shot — never recurses into line1/city.
    expect(out.delivery_address).toBe("[redacted]");
  });

  it("caps recursion depth instead of hanging on a pathologically deep object", () => {
    let deep: Record<string, unknown> = { order_id: "order_bottom" };
    for (let i = 0; i < 20; i++) {
      deep = { child: deep };
    }
    expect(() => scrub(deep)).not.toThrow();
  });

  it("is cycle-safe against self-referential objects", () => {
    const cyclic: Record<string, unknown> = { order_id: "order_1" };
    cyclic.self = cyclic;
    expect(() => scrub(cyclic)).not.toThrow();
  });

  it("redacts spelled-out sphere/cylinder keys, not just the sph/cyl abbreviations", () => {
    const out = scrub({
      sphere: -2.25,
      cylinder: -0.75,
      od_sphere: 1.0,
      order_id: "order_keepme",
    }) as Record<string, unknown>;
    expect(out.sphere).toBe("[redacted]");
    expect(out.cylinder).toBe("[redacted]");
    expect(out.od_sphere).toBe("[redacted]");
    expect(out.order_id).toBe("order_keepme");
  });

  it("leaves primitives and arrays of primitives untouched", () => {
    expect(scrub("plain string")).toBe("plain string");
    expect(scrub(42)).toBe(42);
    expect(scrub(null)).toBe(null);
    expect(scrub(undefined)).toBe(undefined);
    expect(scrub([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("scrubSentryEvent — full-event backstop", () => {
  it("scrubs extra, contexts, and breadcrumb data; drops request cookies", () => {
    const event = {
      extra: {
        order_id: "order_1",
        prescription: { sph_right: -2.5 },
      },
      contexts: {
        lab_job: { lab_job_id: "labjob_1", ciphertext: "blob" },
      },
      breadcrumbs: [
        {
          category: "http",
          data: { order_id: "order_1", email: "leak@example.com" },
        },
      ],
      request: {
        cookies: { session: "abc123" },
        headers: { authorization: "Bearer token", "x-request-id": "req_1" },
        data: { order_id: "order_1", phone: "+66800000000" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const out = scrubSentryEvent(event);

    expect(out.extra.order_id).toBe("order_1");
    expect(out.extra.prescription).toBe("[redacted]");
    expect(out.contexts.lab_job.lab_job_id).toBe("labjob_1");
    expect(out.contexts.lab_job.ciphertext).toBe("[redacted]");
    expect(out.breadcrumbs[0].data.order_id).toBe("order_1");
    expect(out.breadcrumbs[0].data.email).toBe("[redacted]");
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.headers.authorization).toBe("[redacted]");
    expect(out.request.headers["x-request-id"]).toBe("req_1");
    expect(out.request.data.order_id).toBe("order_1");
    expect(out.request.data.phone).toBe("[redacted]");
  });

  it("redacts request.query_string wholesale when any param name is sensitive, leaves opaque ones", () => {
    const sensitive = {
      request: { query_string: "order_id=order_1&email=leak%40example.com" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(scrubSentryEvent(sensitive).request.query_string).toBe("[redacted]");

    const opaque = {
      request: { query_string: "order_id=order_1&status=shipped" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(scrubSentryEvent(opaque).request.query_string).toBe(
      "order_id=order_1&status=shipped",
    );
  });

  it("no-ops cleanly on an event with no extra/contexts/breadcrumbs/request", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = { message: "plain event" } as any;
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect(scrubSentryEvent(event)).toBe(event);
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs a single breadcrumb's data in place", () => {
    const breadcrumb = {
      category: "fetch",
      data: { order_id: "order_1", api_key: "sk_live_x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const out = scrubBreadcrumb(breadcrumb);
    expect(out.data!.order_id).toBe("order_1");
    expect(out.data!.api_key).toBe("[redacted]");
  });

  it("passes through a breadcrumb with no data untouched", () => {
    const breadcrumb = { category: "navigation" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(scrubBreadcrumb(breadcrumb as any)).toBe(breadcrumb);
  });
});

describe("initSentry — dormant-until-DSN", () => {
  it("does not initialize the SDK when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    const initSpy = jest.spyOn(Sentry, "init").mockImplementation(() => undefined as never);

    initSentry();

    expect(initSpy).not.toHaveBeenCalled();
  });

  it("initializes the SDK exactly once when SENTRY_DSN is set, even across repeated calls", () => {
    process.env.SENTRY_DSN = "https://fake@o0.ingest.sentry.io/0";
    const initSpy = jest.spyOn(Sentry, "init").mockImplementation(() => undefined as never);

    initSentry();
    initSentry();
    initSentry();

    expect(initSpy).toHaveBeenCalledTimes(1);
    const options = initSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(options.dsn).toBe("https://fake@o0.ingest.sentry.io/0");
    expect(options.tracesSampleRate).toBe(0);
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
  });

  it("wires beforeSend to the scrubber — a leaked Rx field never reaches Sentry.init's caller-visible event", () => {
    process.env.SENTRY_DSN = "https://fake@o0.ingest.sentry.io/0";
    const initSpy = jest.spyOn(Sentry, "init").mockImplementation(() => undefined as never);

    initSentry();

    const options = initSpy.mock.calls[0][0] as {
      beforeSend: (event: unknown) => unknown;
    };
    const scrubbed = options.beforeSend({
      extra: { order_id: "order_1", prescription: { sph_right: -2.5 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as { extra: Record<string, unknown> };

    expect(scrubbed.extra.order_id).toBe("order_1");
    expect(scrubbed.extra.prescription).toBe("[redacted]");
  });
});

describe("captureException / captureMessage — no-op safety", () => {
  it("captureException never throws, with or without Sentry initialized", () => {
    delete process.env.SENTRY_DSN;
    expect(() =>
      captureException(new Error("boom"), {
        tags: { module: "test" },
        extra: { order_id: "order_1" },
      }),
    ).not.toThrow();
  });

  it("captureMessage never throws, with or without Sentry initialized", () => {
    delete process.env.SENTRY_DSN;
    expect(() =>
      captureMessage("something happened", {
        level: "warning",
        tags: { module: "test" },
        extra: { order_id: "order_1" },
      }),
    ).not.toThrow();
  });

  it("scrubs `extra` before it reaches Sentry.withScope's context, even pre-init", () => {
    delete process.env.SENTRY_DSN;
    const withScopeSpy = jest.spyOn(Sentry, "withScope");

    captureException(new Error("boom"), {
      extra: { order_id: "order_1", prescription: { sph_right: -2.5 } },
    });

    expect(withScopeSpy).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopeArg = { setTag: jest.fn(), setContext: jest.fn() } as any;
    const scopeFn = withScopeSpy.mock.calls[0][0] as unknown as (
      scope: unknown,
    ) => void;
    scopeFn(scopeArg);

    expect(scopeArg.setContext).toHaveBeenCalledWith(
      "extra",
      expect.objectContaining({
        order_id: "order_1",
        prescription: "[redacted]",
      }),
    );
  });

  it("swallows an error thrown by the underlying SDK instead of propagating it", () => {
    jest.spyOn(Sentry, "withScope").mockImplementation(() => {
      throw new Error("SDK internals blew up");
    });
    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(() => captureMessage("hi")).not.toThrow();
  });
});
