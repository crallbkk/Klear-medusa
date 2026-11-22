// Mark an admin account as a lab account, take the mark away, or list who
// has it.
//
//   LAB_ACCOUNT=list npx medusa exec ./src/scripts/lab-account.ts
//   LAB_ACCOUNT_EMAIL=someone@example.com LAB_ACCOUNT=lab  npx medusa exec ./src/scripts/lab-account.ts
//   LAB_ACCOUNT_EMAIL=someone@example.com LAB_ACCOUNT=none npx medusa exec ./src/scripts/lab-account.ts
//
// A lab account can use the lab screens and nothing else in Medusa Admin
// (`src/api/admin/lab-gate.ts`). The mark is felt within seconds, also by a
// session that is already open.
//
// An account is a full admin account until it is marked. Create the user
// first (`npx medusa user -e ... -p ...`), mark it, and only then hand over
// the password. NEVER invite a lab person from Settings: an invited person
// is a full admin from the moment they set their password.

import type { ExecArgs } from "@medusajs/framework/types";
import { listAdminAccounts, setLabAccount } from "../modules/lms/lab-account";

export default async function labAccount({ container }: ExecArgs): Promise<void> {
  const want = process.env.LAB_ACCOUNT;
  if (want === "list") {
    const accounts = await listAdminAccounts(container);
    for (const a of accounts) console.log(`${a.lab ? "lab       " : "FULL ADMIN"}  ${a.email}`);
    console.log(`${accounts.length} admin account(s); ${accounts.filter((a) => a.lab).length} lab.`);
    return;
  }
  const email = process.env.LAB_ACCOUNT_EMAIL;
  if (!email || (want !== "lab" && want !== "none")) {
    throw new Error("set LAB_ACCOUNT=list, or LAB_ACCOUNT_EMAIL with LAB_ACCOUNT=lab or LAB_ACCOUNT=none");
  }
  const result = await setLabAccount(container, email, want === "lab");
  if (result.outcome === "no_such_user") throw new Error("no admin user has that email");
  console.log(`lab account: ${result.outcome}. It is felt within a few seconds.`);
}
