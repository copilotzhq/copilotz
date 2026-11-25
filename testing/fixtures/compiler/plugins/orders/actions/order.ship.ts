import { defineAction } from "copilotz";

export default defineAction({
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  run: (ctx, { id }) =>
    ctx.db.collection("order").updateOne({ _id: id, shipped: false }, { $set: { shipped: true } }),
});
