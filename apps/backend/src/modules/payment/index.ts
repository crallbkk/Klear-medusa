import { Module } from "@medusajs/framework/utils";
import PaymentModuleService, { PAYMENT_MODULE } from "./service";

export default Module(PAYMENT_MODULE, {
  service: PaymentModuleService,
});

export { PAYMENT_MODULE };
export * from "./types";
