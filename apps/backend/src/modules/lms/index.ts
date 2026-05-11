import { Module } from "@medusajs/framework/utils";
import LmsModuleService, { LMS_MODULE } from "./service";

export default Module(LMS_MODULE, {
  service: LmsModuleService,
});

export { LMS_MODULE };
export * from "./types";
