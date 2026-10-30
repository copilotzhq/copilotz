/** The ledger hears every model call (it plugs into the models plugin's `modelUse`) and records it rated. */
import type { UseListener } from "../../../models/contract.ts";
import { recordUse } from "../shared/use.ts";

export const ledger: UseListener = { used: recordUse };
