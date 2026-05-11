import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  createStoresWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows";

// Thailand-only idempotent seed for Klear.
// - No EU regions, no Medusa demo products (catalogue lives in Admin).
// - Safe to re-run: every step checks for existing rows first.
// - Folds the former one-off klear-setup.mjs into source control.
export default async function initial_data_seed({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL);
  const storeModule = container.resolve(Modules.STORE);
  const apiKeyModule = container.resolve(Modules.API_KEY);
  const regionModule = container.resolve(Modules.REGION);
  const taxModule = container.resolve(Modules.TAX);
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);

  // 1. Default Sales Channel
  let [salesChannel] = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  });
  if (!salesChannel) {
    const {
      result: [created],
    } = await createSalesChannelsWorkflow(container).run({
      input: {
        salesChannelsData: [
          {
            name: "Default Sales Channel",
            description: "Klear default sales channel",
          },
        ],
      },
    });
    salesChannel = created;
    logger.info(`Created Default Sales Channel: ${salesChannel.id}`);
  } else {
    logger.info(`Default Sales Channel exists: ${salesChannel.id}`);
  }

  // 2. Default Store with THB only
  const stores = await storeModule.listStores();
  let store = stores[0];
  if (!store) {
    const {
      result: [created],
    } = await createStoresWorkflow(container).run({
      input: {
        stores: [
          {
            name: "Klear",
            supported_currencies: [{ currency_code: "thb", is_default: true }],
            default_sales_channel_id: salesChannel.id,
          },
        ],
      },
    });
    store = created;
    logger.info(`Created Klear store: ${store.id}`);
  } else {
    logger.info(`Store exists: ${store.id}`);
  }

  // 3. Publishable API key + link to sales channel
  const existingKeys = await apiKeyModule.listApiKeys({ type: "publishable" });
  let publishableKey = existingKeys[0];
  if (!publishableKey) {
    const {
      result: [created],
    } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [
          {
            title: "Default Publishable API Key",
            type: "publishable",
            created_by: "seed",
          },
        ],
      },
    });
    publishableKey = created;
    logger.info(`Created publishable key: ${publishableKey.id}`);
  } else {
    logger.info(`Publishable key exists: ${publishableKey.id}`);
  }

  await linkSalesChannelsToApiKeyWorkflow(container)
    .run({
      input: { id: publishableKey.id, add: [salesChannel.id] },
    })
    .catch((e) => {
      const msg = String(e?.message ?? e);
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("unique constraint")
      ) {
        logger.info(`Publishable key already linked to sales channel`);
      } else {
        throw e;
      }
    });

  // 4. Thailand region with THB + 7% inclusive VAT
  const regions = await regionModule.listRegions({ name: "Thailand" });
  let region = regions[0];
  if (!region) {
    const { result: regionResult } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Thailand",
            currency_code: "thb",
            countries: ["th"],
            automatic_taxes: true,
            payment_providers: ["pp_system_default"],
          },
        ],
      },
    });
    region = regionResult[0];
    logger.info(`Created Thailand region: ${region.id}`);
  } else {
    logger.info(`Thailand region exists: ${region.id}`);
  }

  const taxRegions = await taxModule.listTaxRegions({ country_code: "th" });
  if (!taxRegions.length) {
    await createTaxRegionsWorkflow(container).run({
      input: [
        {
          country_code: "th",
          provider_id: "tp_system",
          default_tax_rate: {
            name: "Thailand VAT",
            code: "TH-VAT",
            rate: 7,
          },
        },
      ],
    });
    logger.info(`Created TH tax region (7% inclusive VAT)`);
  } else {
    logger.info(`TH tax region exists`);
  }

  // 5. Bangkok stock location + link to sales channel
  const locations = await stockLocationModule.listStockLocations({
    name: "Bangkok Warehouse",
  });
  let stockLocation = locations[0];
  if (!stockLocation) {
    const { result } = await createStockLocationsWorkflow(container).run({
      input: {
        locations: [
          {
            name: "Bangkok Warehouse",
            address: {
              city: "Bangkok",
              country_code: "TH",
              address_1: "",
            },
          },
        ],
      },
    });
    stockLocation = result[0];
    logger.info(`Created Bangkok Warehouse: ${stockLocation.id}`);
  } else {
    logger.info(`Bangkok Warehouse exists: ${stockLocation.id}`);
  }

  await link
    .create({
      [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
    })
    .catch(() => {
      // idempotent: link may already exist
    });

  await linkSalesChannelsToStockLocationWorkflow(container)
    .run({
      input: { id: stockLocation.id, add: [salesChannel.id] },
    })
    .catch((e) => {
      const msg = String(e?.message ?? e);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        logger.info(`Stock location already linked to sales channel`);
      } else {
        throw e;
      }
    });

  // Product seeding is deliberately omitted — frame catalogue is managed in
  // Medusa Admin (per DECISIONS.md: catalogue migration is Session 3 scope).

  logger.info(`Klear initial seed complete.`);
}
