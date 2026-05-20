import { Module } from "@medusajs/framework/utils";
import ShippingModuleService, { SHIPPING_MODULE } from "./service";

export default Module(SHIPPING_MODULE, {
  service: ShippingModuleService,
});

export { SHIPPING_MODULE };
export * from "./types";
