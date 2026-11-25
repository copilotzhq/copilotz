import { defineCollection } from "copilotz";

export default defineCollection({
  schema: { type: "object", properties: { shipped: { type: "boolean" } } },
  queries: { pending: (orders) => orders.countDocuments({ shipped: false }) },
});
