import { Module } from "@medusajs/framework/utils";
import PrescriptionModuleService, { PRESCRIPTION_MODULE } from "./service";

export default Module(PRESCRIPTION_MODULE, {
  service: PrescriptionModuleService,
});

export { PRESCRIPTION_MODULE };
export type { PrescriptionRef } from "./service";
