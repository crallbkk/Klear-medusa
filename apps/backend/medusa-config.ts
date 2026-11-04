import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const isProduction = process.env.NODE_ENV === 'production'

// In production, missing auth secrets must fail loudly at boot rather than
// silently falling back to a well-known value ("supersecret") that would let
// anyone forge admin sessions. Locally we keep a dev-only fallback so
// `medusa develop` works without extra setup.
function requireSecret(name: 'JWT_SECRET' | 'COOKIE_SECRET'): string {
  const value = process.env[name]
  if (value) return value
  if (isProduction) {
    throw new Error(
      `${name} is required in production but was not set. Refusing to boot with an insecure default. Set ${name} in the Railway service environment.`
    )
  }
  return 'supersecret'
}

const jwtSecret = requireSecret('JWT_SECRET')
const cookieSecret = requireSecret('COOKIE_SECRET')

// Same rule for the rest of the boot-critical config: a missing value in
// production is a misconfigured deploy, and failing at boot (where Railway
// keeps the previous deployment serving) beats booting with CORS that
// rejects the storefront or no database.
function requireInProduction(
  name: 'DATABASE_URL' | 'STORE_CORS' | 'ADMIN_CORS' | 'AUTH_CORS'
): string {
  const value = process.env[name]
  if (!value && isProduction) {
    throw new Error(
      `${name} is required in production but was not set. Set it in the Railway service environment.`
    )
  }
  // Unset outside production behaves exactly as before (undefined).
  return value as string
}

const redisUrl = process.env.REDIS_URL

// "shared" (default) runs the HTTP server and the background worker
// (subscribers, scheduled jobs, workflows) in one process, which is what
// Railway runs today. To scale, run a second service with
// MEDUSA_WORKER_MODE=worker and set this one to "server".
const workerMode = (['shared', 'worker', 'server'] as const).find(
  (m) => m === process.env.MEDUSA_WORKER_MODE
) ?? 'shared'

const redisModules = redisUrl
  ? [
      {
        resolve: "@medusajs/medusa/cache-redis",
        options: { redisUrl },
      },
      {
        resolve: "@medusajs/medusa/event-bus-redis",
        options: { redisUrl },
      },
      {
        resolve: "@medusajs/medusa/workflow-engine-redis",
        options: { redis: { redisUrl } },
      },
      {
        // Without a locking module Medusa locks in process memory. Cart
        // completion takes a lock on the cart, and the storefront can
        // complete the same cart from the payment webhook and from the
        // retry sweep; a Redis lock keeps that exclusive across processes
        // too (a worker/server split, a second replica, an overlapping
        // deploy).
        resolve: "@medusajs/medusa/locking",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/locking-redis",
              id: "locking-redis",
              is_default: true,
              options: { redisUrl },
            },
          ],
        },
      },
    ]
  : []

const klearModules = [
  { resolve: "./src/modules/prescription" },
  { resolve: "./src/modules/lms" },
  { resolve: "./src/modules/shipping" },
  {
    // Override Medusa's built-in fulfillment module so we can register the
    // Shippop provider alongside the default manual provider. Manual stays
    // available so the founder can hand-record a shipment in admin when
    // testing without hitting Shippop.
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [
        { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
        {
          resolve: "./src/modules/shipping/provider",
          id: "shippop",
          options: {
            warehouse: {
              name: process.env.KLEAR_WAREHOUSE_NAME || "Klear HQ",
              phone: process.env.KLEAR_WAREHOUSE_PHONE || "0800000000",
              address: process.env.KLEAR_WAREHOUSE_ADDRESS || "1/1 Sukhumvit 55",
              district: process.env.KLEAR_WAREHOUSE_SUBDISTRICT || "Khlong Tan Nuea",
              state: process.env.KLEAR_WAREHOUSE_DISTRICT || "Watthana",
              province: process.env.KLEAR_WAREHOUSE_PROVINCE || "Bangkok",
              postcode: process.env.KLEAR_WAREHOUSE_POSTCODE || "10110",
            },
            default_parcel: {
              weight_g: 300,
              length_cm: 18,
              width_cm: 8,
              height_cm: 6,
            },
          },
        },
      ],
    },
  },
]

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: requireInProduction('DATABASE_URL'),
    redisUrl,
    workerMode,
    http: {
      storeCors: requireInProduction('STORE_CORS'),
      adminCors: requireInProduction('ADMIN_CORS'),
      authCors: requireInProduction('AUTH_CORS'),
      jwtSecret,
      cookieSecret,
    },
  },
  modules: [...redisModules, ...klearModules],
})
