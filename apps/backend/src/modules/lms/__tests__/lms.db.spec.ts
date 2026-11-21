// The lab module's database tests: one runner, one Medusa module instance
// per test, every suite inside it.
//
// One file on purpose. Medusa's module loader keeps process-wide state that
// does not survive being loaded into a second Jest module registry, so two
// spec files that each start a runner fail in the same process ("Loaders for
// module Custom: lms failed"). Add a new suite as a `*.db-suite.ts` file
// exporting a function, and call it here.

import { moduleIntegrationTestRunner } from "@medusajs/test-utils";
import type LmsModuleService from "../service";
import { LMS_MODULE } from "../service";
import { TEST_DB_NAME, resetDatabase } from "./db-harness";
import { failedSaveSuite } from "./failed-save.db-suite";

jest.setTimeout(120_000);

moduleIntegrationTestRunner<LmsModuleService>({
  moduleName: LMS_MODULE,
  resolve: "./src/modules/lms",
  dbName: TEST_DB_NAME,
  // No models handed to the runner: it would build the schema from them.
  // The schema here comes from the migration files instead.
  moduleModels: [],
  hooks: {
    beforeModuleInit: async () => {
      await resetDatabase();
    },
  },
  testSuite: ({ service }) => {
    failedSaveSuite(service);
  },
});
