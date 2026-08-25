import { assertEquals } from "@std/assert";
import { createCreateThreadAction } from "../../actions/create-thread/index.ts";
import { createCreateThreadToolResource } from "./index.ts";
Deno.test("create-thread Resource exposes its alias", () =>
  assertEquals(
    createCreateThreadToolResource(createCreateThreadAction()).action,
    "create_thread",
  ));
