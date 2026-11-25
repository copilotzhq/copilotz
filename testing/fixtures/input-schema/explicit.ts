import { defineAction } from "../../../runtime/define.ts";

const input = { type: "object", additionalProperties: false } as const;
export default defineAction({ input, run(_ctx, _input: unknown) {} });
