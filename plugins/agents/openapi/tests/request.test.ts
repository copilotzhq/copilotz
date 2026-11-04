/**
 * A call's request, from its input: path parameters encoded, query
 * parameters by their style, header and cookie parameters sent, a JSON body
 * only where the method carries one.
 */
import { assertEquals } from "@std/assert";
import { planOf } from "../shared/plan.ts";
import { build } from "../shared/request.ts";
import { operationsOf, read } from "../shared/spec.ts";
import { test } from "../../../../testing/mod.ts";
import spec from "./trips.json" with { type: "json" };

const doc = read(spec);
const planned = (spec: Record<string, unknown>, id: string) => {
  const found = operationsOf(spec).find((f) => f.id === id)!;
  const made = planOf(spec, found);
  if ("skip" in made) throw new Error(made.skip);
  return made.plan;
};
const call = (id: string, input: Record<string, unknown>, query?: Record<string, string>) =>
  build(planned(doc, id), input, "https://eu.trips.test/v1/", query);

test("path parameters are encoded into the path", () => {
  const { url, method, body } = call("getTrip", { tripId: "a b/c?d" });
  assertEquals([method, url, body], [
    "GET",
    "https://eu.trips.test/v1/trips/a%20b%2Fc%3Fd",
    undefined,
  ]);
});

test("query arrays repeat by default (form, explode), or join when they don't explode", () => {
  const { url } = call("listTrips", {
    status: "done",
    tag: ["sea", "a&b"],
    ids: ["t1", "t,2"],
    near: { lat: 1.5, lng: -2 },
    limit: 10,
  });
  assertEquals(
    new URL(url).search,
    "?status=done&tag=sea&tag=a%26b&ids=t1,t%2C2&near[lat]=1.5&near[lng]=-2&limit=10",
  );
  // Nothing given, nothing sent.
  assertEquals(new URL(call("listTrips", {}).url).search, "");
});

test("space- and pipe-delimited arrays, form objects, and JSON parameters", () => {
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/s": {
        get: {
          operationId: "search",
          parameters: [
            { name: "a", in: "query", style: "spaceDelimited", explode: false },
            { name: "b", in: "query", style: "pipeDelimited", explode: false },
            { name: "c", in: "query", schema: { type: "object" } },
            { name: "d", in: "query", explode: false, schema: { type: "object" } },
            { name: "e", in: "query", content: { "application/json": { schema: {} } } },
          ],
        },
      },
    },
  };
  const { url } = build(
    planned(spec, "search"),
    { a: ["x", "y"], b: [1, 2], c: { p: "1", q: "2" }, d: { r: "3" }, e: { f: [1] } },
    "https://s.test",
  );
  assertEquals(
    new URL(url).search,
    "?a=x%20y&b=1%7C2&p=1&q=2&d=r,3&e=%7B%22f%22%3A%5B1%5D%7D",
  );
});

test("header and cookie parameters are sent; the settings' query goes on the URL", () => {
  const { url, headers } = call(
    "listTrips",
    { "X-Request-Id": "r-1", session: "s 1", tag: ["x"] },
    { api_key: "k&1" },
  );
  assertEquals(headers.get("x-request-id"), "r-1");
  assertEquals(headers.get("cookie"), "session=s%201");
  assertEquals(new URL(url).search, "?tag=x&api_key=k%261");
});

test("an object body is the inputs that are its properties, as JSON, with its type", () => {
  const { method, headers, body } = call("createTrip", {
    "Idempotency-Key": "k1",
    name: "Lisbon",
    legs: [{ from: { name: "Porto" }, to: { name: "Lisbon" } }],
    // Not a parameter: the body takes properties it doesn't name.
    pace: "slow",
  });
  assertEquals(method, "POST");
  assertEquals(headers.get("content-type"), "application/json");
  assertEquals(headers.get("idempotency-key"), "k1");
  assertEquals(JSON.parse(body!), {
    name: "Lisbon",
    legs: [{ from: { name: "Porto" }, to: { name: "Lisbon" } }],
    pace: "slow",
  });
});

test("a body that isn't an object is `body`; a method without one sends none", () => {
  const put = call("set_tags", { tripId: "t1", body: ["sea", "sun"] });
  assertEquals([put.method, put.url, put.body], [
    "PUT",
    "https://eu.trips.test/v1/trips/t1/tags",
    '["sea","sun"]',
  ]);
  const del = call("cancelTrip", { tripId: "t1" });
  assertEquals([del.method, del.body, del.headers.get("content-type")], [
    "DELETE",
    undefined,
    null,
  ]);
  // An optional object body with nothing in it isn't sent.
  const spec = {
    openapi: "3.1.0",
    paths: {
      "/n": {
        post: {
          operationId: "nudge",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { why: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    },
  };
  assertEquals(build(planned(spec, "nudge"), { other: 1 }, "https://n.test").body, undefined);
  assertEquals(build(planned(spec, "nudge"), { why: "x" }, "https://n.test").body, '{"why":"x"}');
});
