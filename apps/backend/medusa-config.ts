import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const redisUrl = process.env.REDIS_URL

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
    ]
  : []

const klearModules = [
  { resolve: "./src/modules/prescription" },
  { resolve: "./src/modules/lms" },
  { resolve: "./src/modules/payment" },
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
    databaseUrl: process.env.DATABASE_URL,
    redisUrl,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  modules: [...redisModules, ...klearModules],
})
