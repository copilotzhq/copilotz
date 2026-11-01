/**
 * `cloud.may` `{}`: whether the person asking may make a cloud computer now
 * (`{ create }`), and why not (`why`: only admins make them here, or this
 * month's budget is spent). Only reads, so it isn't recorded: the sizes
 * people choose from say it too.
 */
import { defineAction, people } from "../../../../runtime/mod.ts";
import { mayCreate } from "../shared/may.ts";

export const mayAction = defineAction({
  description: "Whether you may make a cloud computer now, and why not",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: (ctx) => mayCreate(ctx),
});
