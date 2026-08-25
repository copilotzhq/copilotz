import { assertEquals } from "@std/assert";
import { createEndThreadAction } from "../../actions/end-thread/index.ts";
import { createEndThreadToolResource } from "./index.ts";
Deno.test("end-thread Resource exposes its alias", () =>
  assertEquals(
    createEndThreadToolResource(createEndThreadAction()).action,
    "end_thread",
  ));
