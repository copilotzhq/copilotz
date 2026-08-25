import { assert } from "@std/assert";
import {
  createScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  updateScheduledJob,
} from "./index.ts";

Deno.test("Scheduled Job authoring exposes the four Collection operations", () => {
  for (
    const operation of [
      createScheduledJob,
      updateScheduledJob,
      getScheduledJob,
      listScheduledJobs,
    ]
  ) assert(typeof operation === "function");
});
