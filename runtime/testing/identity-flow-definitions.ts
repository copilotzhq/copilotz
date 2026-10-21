import { externalEffect } from "../actions/external-effect.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import {
  defineProcessor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import type { ActionContext } from "../actions/types.ts";

export type LoginInput = {
  start?: boolean;
  code?: string;
  forged?: boolean;
  principal?: string;
  rollback?: boolean;
  caught?: boolean;
  commandReplay?: boolean;
  changed?: boolean;
  retryUnknown?: boolean;
};
export const identityFlowDefinitions = {
  collections: {
    accounts: defineCollection({
      name: "identity_account",
      schema: { type: "object" },
    }),
    mirrors: defineCollection({
      name: "identity_mirror",
      schema: { type: "object" },
    }),
  },
  actions: {
    login: defineAction({
      id: "identity.login",
      async execute(input: LoginInput, ctx) {
        if (input.start) {
          await ctx.transaction(async (tx) => {
            await tx.flows.start({
              kind: "oidc",
              continuation: "login",
              maxAge: 300,
            });
          });
          return { started: true };
        }
        if (input.retryUnknown) {
          try {
            await ctx.authentication.verify("provider", { code: "valid" });
          } catch { /* Simulate retry after an unknown provider outcome. */ }
          try {
            await ctx.authentication.verify("provider", { code: "valid" });
          } catch (error) {
            return { code: (error as { code?: string }).code };
          }
          throw new Error("Pending exchange ran again.");
        }
        const evidence = input.forged
          ? await externalEffect(
            ctx,
            "provider-identity",
            () => Promise.resolve({ principal: input.principal ?? "admin" }),
          )
          : await ctx.authentication.verify("provider", {
            code: input.code ?? "valid",
          });
        if (!input.forged) {
          const replay = await ctx.authentication.verify("provider", {
            code: input.changed ? "changed" : input.code ?? "valid",
          });
          if (replay.principal !== evidence.principal) {
            throw new Error("Evidence replay changed.");
          }
        }
        if (input.commandReplay) {
          const first = await ctx.directory.command("prepare", {
            account: evidence.principal,
          }, { operationKey: "prepare" });
          const second = await ctx.directory.command("prepare", {
            account: evidence.principal,
          }, { operationKey: "prepare" });
          return { first, second, process: Deno.pid };
        }
        await ctx.transaction(async (tx) => {
          if (!input.forged) {
            try {
              await tx.directory.command("prepare", {
                account: evidence.principal,
                fail: !!input.caught,
              }, { operationKey: "prepare" });
            } catch (error) {
              if (!input.caught) throw error;
            }
            await tx.collections.accounts.create({
              id: evidence.principal,
              issuer: "https://issuer.example",
              subject: "subject",
            });
            await tx.directory.command("membership", {
              account: evidence.principal,
              fail: !!input.rollback,
            }, { operationKey: "membership" });
          }
          await tx.sessions.create({
            principal: evidence.principal,
            maxAge: 3600,
          });
        }, { operationKey: "login" });
        return { account: evidence.principal, process: Deno.pid };
      },
    }),
    child: defineAction({
      id: "identity.child",
      execute() {
        throw new Error("Processor child escaped.");
      },
    }),
  },
  processors: {
    projection: defineProcessor<
      ProcessorContext<
        ActionContext["resources"],
        ActionContext["adapters"],
        ActionContext["actions"]
      >
    >({
      id: "identity.projection",
      settlement: "detached",
      on: [{ eventType: "identity_account.created" }, {
        eventType: "identity_mirror.created",
      }],
      async handle(event, ctx) {
        if (!event.durable) throw new Error("Durable event required.");
        if (event.type === "identity_mirror.created") {
          await ctx.collections.mirrors.create({ id: "outside", blocked: [] });
          return;
        }
        const blocked: string[] = [];
        const refuses = async (name: string, run: () => Promise<unknown>) => {
          try {
            await run();
            throw new Error(`${name} escaped`);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (
              !["forbidden", "action_authorization_refused"].includes(
                code ?? "",
              )
            ) throw error;
            blocked.push(name);
          }
        };
        await refuses(
          "operation",
          () =>
            ctx.operations.start({
              action: "child",
              input: {},
              operationKey: "escape",
            }),
        );
        await refuses("session", () =>
          ctx.transaction(async (tx) => {
            await tx.sessions.create({ principal: "admin", maxAge: 3600 });
          }));
        await refuses(
          "identity",
          () => ctx.authentication.verify("provider", { code: "valid" }),
        );
        await refuses(
          "directory",
          () =>
            ctx.directory.command("prepare", { account: "admin" }, {
              operationKey: "escape",
            }),
        );
        await refuses("action", () => ctx.actions.child({}));
        await ctx.collections.mirrors.create({
          id: `mirror:${event.subject!.id}`,
          blocked,
        });
      },
    }),
  },
};
