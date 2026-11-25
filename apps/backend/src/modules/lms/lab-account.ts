// Mark an admin account as a lab account, take the mark away, or list who
// has it.
//
// The mark is `klear_role: "lab"` in the USER's metadata.
// `api/admin/lab-gate.ts` reads it from the database on every admin request
// (kept for a few seconds), so a change is felt at once, also by a session
// that is already open, and it holds for every way that user can sign in.
//
// An account is a full admin account until it is marked. So: create the
// user with `npx medusa user`, mark it, and only then hand over the
// password. NEVER invite a lab person from Settings: an invited person sets
// their own password and is a full admin from that moment, before anyone
// can mark them.

import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { LAB_ROLE, forgetLabMarks } from "../../api/admin/lab-gate";

export type LabAccountResult =
  | { outcome: "marked" | "unmarked" | "unchanged"; user_ids: string[] }
  | { outcome: "no_such_user" };

type AdminUser = { id: string; email: string; metadata?: Record<string, unknown> | null };

/** Every admin user. Paged, so none is left out however many there are. */
async function allAdminUsers(container: MedusaContainer): Promise<AdminUser[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = container.resolve(Modules.USER) as any;
  const PAGE = 200;
  const out: AdminUser[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = (await users.listUsers(
      {},
      { take: PAGE, skip, select: ["id", "email", "metadata"], order: { id: "ASC" } },
    )) as AdminUser[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Set or clear the lab mark on the admin user with this email.
 *
 * The email is matched whatever its capitals. Medusa stores an email as it
 * was typed and matches it exactly, so `Lab@x.com` and `lab@x.com` can be
 * two users; a person can sign in as either, so BOTH are marked. Looking
 * only for the exact spelling would leave the other a full admin.
 */
export async function setLabAccount(
  container: MedusaContainer,
  email: string,
  lab: boolean,
): Promise<LabAccountResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = container.resolve(Modules.USER) as any;
  const wanted = email.trim().toLowerCase();
  const matches = (await allAdminUsers(container)).filter(
    (u) => (u.email ?? "").trim().toLowerCase() === wanted,
  );
  if (matches.length === 0) return { outcome: "no_such_user" };

  let changed = 0;
  for (const user of matches) {
    const current = (user.metadata ?? {}) as Record<string, unknown>;
    if ((current.klear_role === LAB_ROLE) === lab) continue;
    // Written as null, not removed: Medusa merges metadata on update, so a
    // key left out of the new value would simply stay.
    await users.updateUsers({
      id: user.id,
      metadata: { ...current, klear_role: lab ? LAB_ROLE : null },
    });
    forgetLabMarks(user.id);
    changed++;
  }
  return {
    outcome: changed === 0 ? "unchanged" : lab ? "marked" : "unmarked",
    user_ids: matches.map((u) => u.id),
  };
}

/** Every admin user, with whether it is a lab account. An account not
 *  marked here is a full admin account. */
export async function listAdminAccounts(
  container: MedusaContainer,
): Promise<Array<{ email: string; lab: boolean }>> {
  return (await allAdminUsers(container))
    .map((u) => ({ email: u.email, lab: u.metadata?.klear_role === LAB_ROLE }))
    .sort((a, b) => a.email.localeCompare(b.email));
}
