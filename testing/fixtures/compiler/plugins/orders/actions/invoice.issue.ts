import { defineAction } from "copilotz";
import type { Invoice } from "../contract.ts";

export default defineAction({
  transaction: true,
  run: (ctx, invoice: Invoice) => ctx.db.collection("invoice").insertOne(invoice),
});
