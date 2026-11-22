import { refuseOrderTransfers, requireOrderOwner } from "../own-order";
import middlewares from "../../../middlewares";

const ORDERS: Record<string, { id: string; customer_id: string | null }> = {
  order_mine: { id: "order_mine", customer_id: "cus_me" },
  order_theirs: { id: "order_theirs", customer_id: "cus_other" },
  order_nobody: { id: "order_nobody", customer_id: null },
};

function run(opts: { id?: string; actor?: string | null; type?: string; fail?: boolean }) {
  const graph = jest.fn(async ({ filters }: { filters: { id: string } }) => {
    if (opts.fail) throw new Error("database down");
    const found = ORDERS[filters.id];
    return { data: found ? [found] : [] };
  });
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  const req = {
    params: { id: opts.id },
    auth_context:
      opts.actor === null ? undefined : { actor_id: opts.actor ?? "cus_me", actor_type: opts.type ?? "customer" },
    scope: { resolve: () => ({ graph }) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return requireOrderOwner(req as any, res as any, next).then(() => ({ res, next, graph }));
}

describe("GET /store/orders/:id answers only the order's owner", () => {
  it("lets the owner through", async () => {
    const { res, next } = await run({ id: "order_mine" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers someone else's order exactly as it answers one that does not exist", async () => {
    const theirs = await run({ id: "order_theirs" });
    const missing = await run({ id: "order_theirs".replace("theirs", "nowhere") });
    for (const { res, next } of [theirs, missing]) {
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    }
    const said = (r: typeof theirs) => JSON.stringify(r.res.json.mock.calls[0][0]).replace(/order_\w+/, "X");
    expect(said(theirs)).toBe(said(missing));
    // Nothing of the order is in the refusal.
    expect(JSON.stringify(theirs.res.json.mock.calls)).not.toMatch(/cus_other/);
  });

  it("refuses an order that belongs to no customer", async () => {
    const { res, next } = await run({ id: "order_nobody" });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
    // Also for a caller whose own id is somehow empty-ish.
    const odd = await run({ id: "order_nobody", actor: "" });
    expect(odd.res.status).toHaveBeenCalledWith(401);
  });

  it("refuses a caller who is not a signed-in customer, before looking anything up", async () => {
    for (const who of [
      { actor: null },
      { actor: "user_admin", type: "user" },
      { actor: "apk_1", type: "api-key" },
      { actor: "" },
    ]) {
      const { res, next, graph } = await run({ id: "order_mine", ...who });
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(graph).not.toHaveBeenCalled();
    }
  });

  it("does not let the request through when the lookup fails", async () => {
    await expect(run({ id: "order_mine", fail: true })).rejects.toThrow("database down");
  });

  it("switches Medusa's order transfers off, for every method", () => {
    const entries = (middlewares.routes ?? []).filter((r) =>
      (r.middlewares ?? []).includes(refuseOrderTransfers as never),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("/store/orders/:id/transfer/*");
    expect(entries[0].methods).toBeUndefined();
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refuseOrderTransfers({} as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("is mounted on that route, for GET, and on nothing wider", () => {
    const entries = (middlewares.routes ?? []).filter((r) =>
      (r.middlewares ?? []).includes(requireOrderOwner as never),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("/store/orders/:id");
    expect(entries[0].methods).toEqual(["GET"]);
  });
});
