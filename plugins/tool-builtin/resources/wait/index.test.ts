import { assertEquals } from "@std/assert";
import { createWaitAction } from "../../actions/wait/index.ts";
import { createWaitToolResource } from "./index.ts";
Deno.test("wait Resource exposes its alias", () =>
  assertEquals(
    createWaitToolResource(createWaitAction(() => Promise.resolve())).action,
    "wait",
  ));
