import { defineCollection } from "copilotz";
import type { Invoice } from "../contract.ts";

export default defineCollection<Invoice>({
  indexes: [["customerId"]],
  queries: {
    customers: async (invoices) =>
      (await invoices.find({})).map((row) => [
        row.customerId.toUpperCase(),
        row._id.toUpperCase(),
      ]),
  },
});
