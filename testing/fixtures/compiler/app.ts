import { identity } from "copilotz/plugins/access/identity";
import manual from "./plugins/manual/mod.ts";
import orders from "#copilotz/plugins/orders/mod.ts";

export function plugins() {
  return [identity, [orders, manual]];
}
