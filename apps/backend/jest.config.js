const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  // `.spec` only: __tests__ also holds helpers (db-harness.ts), not tests.
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "db") {
  // Tests that need a real Postgres (see src/modules/lms/__tests__/db-harness.ts).
  module.exports.testMatch = ["**/src/**/__tests__/**/*.db.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}
