import { assertEquals } from "@std/assert";
import { createGetCurrentTimeAction } from "../../actions/get-current-time/index.ts";
import { createGetCurrentTimeToolResource } from "./index.ts";
Deno.test("current-time Resource exposes its alias", () =>
  assertEquals(
    createGetCurrentTimeToolResource(
      createGetCurrentTimeAction(() => new Date()),
    ).action,
    "get_current_time",
  ));
