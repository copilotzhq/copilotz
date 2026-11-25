import type { Client, Context, Runtime, ViewContext } from "copilotz";

export function caller(runtime: Runtime, ctx: Context, view: ViewContext, client: Client) {
  runtime.call("order.ship");
  ctx.call("person.rename");
  client.call("order.ship");
  runtime.query("order.pending");
  view.db.collection("order").query("pending");
  view.show("screen:orders", {});
  view.show("another-host:supplement", {});

  // @ts-expect-error The Action is misspelled.
  runtime.call("order.sihp");
  // @ts-expect-error The Action is misspelled for a client too.
  client.call("oder.ship");
  // @ts-expect-error This query belongs to a different collection.
  ctx.db.collection("person").query("pending");
  // @ts-expect-error There is no collection by that name.
  view.db.collection("ordres");
  // @ts-expect-error A runtime query uses its qualified name.
  runtime.query("pending");
}
