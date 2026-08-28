import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  definePromptInstructionResource,
  isPromptInstructionResource,
} from "./index.ts";
import { collectPromptInstructions } from "./internal/collection.ts";

Deno.test("PromptInstructionResource validates, normalizes text, and freezes", () => {
  const instruction = definePromptInstructionResource({
    id: "application.policy",
    type: "prompt_instruction",
    instructions: "\nFollow the application policy.\n",
  });

  assertEquals(instruction, {
    id: "application.policy",
    type: "prompt_instruction",
    instructions: "Follow the application policy.",
  });
  assert(Object.isFrozen(instruction));
  assert(isPromptInstructionResource(instruction));
});

Deno.test("PromptInstructionResource rejects ambiguous or executable declarations", () => {
  assertThrows(
    () =>
      definePromptInstructionResource({
        id: " policy ",
        type: "prompt_instruction",
        instructions: "Follow policy.",
      }),
    TypeError,
    "surrounding whitespace",
  );
  assertThrows(
    () =>
      definePromptInstructionResource({
        id: "policy",
        type: "context",
        instructions: "Follow policy.",
      } as never),
    TypeError,
    "must have type",
  );
  assertThrows(
    () =>
      definePromptInstructionResource({
        id: "policy",
        type: "prompt_instruction",
        instructions: "Follow policy.",
        contribute: () => undefined,
      } as never),
    TypeError,
    "cannot declare 'contribute'",
  );
  const accessor: Record<string, unknown> = {
    type: "prompt_instruction",
    instructions: "Follow policy.",
  };
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assertThrows(
    () => definePromptInstructionResource(accessor as never),
    TypeError,
    "enumerable data property",
  );
  const hidden = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(hidden, {
    id: { value: "policy", enumerable: true },
    type: { value: "prompt_instruction", enumerable: true },
    instructions: { value: "Follow policy.", enumerable: false },
  });
  assertEquals(isPromptInstructionResource(hidden), false);
  assertThrows(
    () => definePromptInstructionResource(hidden as never),
    TypeError,
    "enumerable data property",
  );
  assertEquals(
    isPromptInstructionResource({
      id: "",
      type: "prompt_instruction",
      instructions: "Follow policy.",
    }),
    false,
  );
});

Deno.test("PromptInstructionResource collection uses stable resource identity order", () => {
  const later = definePromptInstructionResource({
    id: "z.later",
    type: "prompt_instruction",
    instructions: "Later policy.",
  });
  const earlier = definePromptInstructionResource({
    id: "a.earlier",
    type: "prompt_instruction",
    instructions: "Earlier policy.",
  });
  assertEquals(
    collectPromptInstructions({
      declaredLater: later,
      declaredEarlier: earlier,
    })
      .map((resource) => resource.id),
    ["a.earlier", "z.later"],
  );
  assertThrows(
    () => collectPromptInstructions({ first: earlier, second: earlier }),
    TypeError,
    "Duplicate",
  );
  assertThrows(
    () =>
      collectPromptInstructions({
        invalid: {
          id: "invalid",
          type: "prompt_instruction",
          instructions: "",
        },
      }),
    TypeError,
    "not a canonical data Resource",
  );
});

Deno.test("PromptInstructionResource remains static and runtime-neutral", async () => {
  const source = await Deno.readTextFile(new URL("index.ts", import.meta.url));
  assertEquals(/\bDeno\.|\bBun\.|\bprocess\./.test(source), false);
  assertEquals(/readTextFile|from\s+["']node:/.test(source), false);
});
