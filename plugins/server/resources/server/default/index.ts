/** Default semantic server policy. @module */
import { defineServerFacade } from "../../facade/index.ts";
import type { ServerFacadeResource } from "../../../shared/contracts.ts";
export const defaultServerFacade: ServerFacadeResource = defineServerFacade();
export default defaultServerFacade;
