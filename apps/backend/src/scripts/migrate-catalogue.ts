import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  updateProductsWorkflow,
  deleteProductsWorkflow,
  createShippingProfilesWorkflow,
} from "@medusajs/medusa/core-flows";
import { FRAME_SEED, type FrameSeed } from "./frame-seed";

// Klear catalogue migration. Idempotent: re-running upserts by handle.
//
// Default behaviour: warn about any product in the store whose handle is
// NOT in FRAME_SEED (stale demo data left over from earlier seeds).
//
// With env `PURGE=true` (or `--purge` argv) those stale products are
// deleted. Run once with purge to remove the leftover "Medusa T-Shirt".
//
// Invocation (locally or via railway ssh):
//   npx medusa exec ./src/scripts/migrate-catalogue.ts
//   PURGE=true npx medusa exec ./src/scripts/migrate-catalogue.ts

function buildMetadata(f: FrameSeed): Record<string, unknown> {
  return {
    name_th: f.name.th,
    blurb_en: f.blurb.en,
    blurb_th: f.blurb.th,
    description_th: f.description.th,
    shape: f.shape,
    material: f.material,
    size: f.size,
    recommended_face_shapes: f.recommended_face_shapes,
    progressives_supported: f.progressives_supported,
    images: f.images,
    ar_glb_key: f.ar_glb_key,
    spec: f.spec,
    sort_order: f.sort_order,
    klear_status: f.status,
  };
}

function statusFor(f: FrameSeed): ProductStatus {
  return f.status === "active" ? ProductStatus.PUBLISHED : ProductStatus.DRAFT;
}

export default async function migrate_catalogue({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule = container.resolve(Modules.PRODUCT);
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL);
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT);

  const purge =
    process.env.PURGE === "true" || process.argv.includes("--purge");

  // 1. Sales channel + shipping profile (must exist before products)
  const [salesChannel] = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  });
  if (!salesChannel) {
    throw new Error(
      "Default Sales Channel not found — run initial-data-seed.ts first",
    );
  }

  const shippingProfiles = await fulfillmentModule.listShippingProfiles({
    type: "default",
  });
  let shippingProfile = shippingProfiles[0];
  if (!shippingProfile) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: {
        data: [{ name: "Default Shipping Profile", type: "default" }],
      },
    });
    shippingProfile = result[0];
    logger.info(`Created Default Shipping Profile: ${shippingProfile.id}`);
  } else {
    logger.info(`Default Shipping Profile exists: ${shippingProfile.id}`);
  }

  // 2. Upsert each frame by handle
  const seedHandles = new Set(FRAME_SEED.map((f) => f.handle));
  const allProducts = await productModule.listProducts({}, { take: 1000 });
  const byHandle = new Map(allProducts.map((p) => [p.handle, p]));

  let created = 0;
  let updated = 0;

  for (const f of FRAME_SEED) {
    const existing = byHandle.get(f.handle);
    const baseProduct = {
      title: f.name.en,
      handle: f.handle,
      description: f.description.en,
      status: statusFor(f),
      metadata: buildMetadata(f),
    };
    const variantPrice = {
      currency_code: "thb",
      amount: f.price_thb,
    };

    if (existing) {
      // Update product fields. Variants/prices updated separately to avoid
      // accidentally clobbering inventory linkages.
      await updateProductsWorkflow(container).run({
        input: {
          selector: { id: existing.id },
          update: baseProduct,
        },
      });

      // Match the seed variant by SKU and update its price.
      const variants = await productModule.listProductVariants({
        product_id: existing.id,
      });
      const seedVariant = variants.find((v) => v.sku === f.sku);
      if (seedVariant) {
        await updateProductsWorkflow(container).run({
          input: {
            products: [
              {
                id: existing.id,
                variants: [
                  {
                    id: seedVariant.id,
                    title: "Default",
                    prices: [variantPrice],
                    manage_inventory: true,
                  },
                ],
              },
            ],
          },
        });
      } else {
        logger.warn(
          `Product ${f.handle} exists but seed SKU ${f.sku} not found on it — leaving variants untouched`,
        );
      }
      updated++;
      logger.info(`Updated ${f.handle} (${f.sku})`);
    } else {
      await createProductsWorkflow(container).run({
        input: {
          products: [
            {
              ...baseProduct,
              shipping_profile_id: shippingProfile.id,
              options: [{ title: "Default", values: ["Default"] }],
              variants: [
                {
                  title: "Default",
                  sku: f.sku,
                  options: { Default: "Default" },
                  prices: [variantPrice],
                  manage_inventory: true,
                },
              ],
              sales_channels: [{ id: salesChannel.id }],
            },
          ],
        },
      });
      created++;
      logger.info(`Created ${f.handle} (${f.sku})`);
    }
  }

  // 3. Stale-product detection (everything not in the seed)
  const stale = allProducts.filter((p) => !seedHandles.has(p.handle));
  if (stale.length) {
    logger.info(
      `Found ${stale.length} stale product(s) not in seed: ${stale
        .map((p) => `${p.handle} (${p.id})`)
        .join(", ")}`,
    );
    if (purge) {
      await deleteProductsWorkflow(container).run({
        input: { ids: stale.map((p) => p.id) },
      });
      logger.info(`Purged ${stale.length} stale product(s)`);
    } else {
      logger.info(
        `Re-run with PURGE=true to delete stale products. Skipping for now.`,
      );
    }
  } else {
    logger.info("No stale products found.");
  }

  logger.info(
    `Catalogue migration complete. created=${created} updated=${updated} stale=${stale.length} purged=${purge && stale.length ? stale.length : 0}`,
  );
}
