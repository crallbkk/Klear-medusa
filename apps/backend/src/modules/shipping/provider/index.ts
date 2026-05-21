import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { ShippopFulfillmentService } from "./service";

// Registers ShippopFulfillmentService under Medusa's built-in fulfillment
// module. See medusa-config.ts for the consuming options block.

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [ShippopFulfillmentService],
});
