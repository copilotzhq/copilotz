import { test } from "node:test";
import assert from "node:assert/strict";
import { coreWebPlugin, createCoreWebPlugin } from "../../web.ts";

const serverProxies = (plugin: typeof coreWebPlugin) =>
  Object.entries(plugin.actions ?? {}).filter(([, action]) =>
    action.placement === "server"
  ).map(([alias]) => alias).sort();

test("the core plugin declares a server proxy only for Actions its intents call", () => {
  assert.deepEqual(serverProxies(coreWebPlugin), [
    "addThreadParticipant",
    "createThread",
    "createThreadMessage",
    "deleteConversation",
    "reviseMessage",
    "spaces",
    "updateConversation",
  ]);
  // An app that brings its own Space Actions declares no `spaces` proxy.
  const own = () => Promise.resolve(undefined);
  const plugin = createCoreWebPlugin({
    intents: {
      chatMoveThread: own,
      chatCreateSpace: own,
      chatUpdateSpace: own,
      chatDeleteSpace: own,
      chatAddMember: own,
      chatRemoveMember: own,
    },
    actionAliases: { createThread: "startConversation" },
  });
  const aliases = serverProxies(plugin);
  assert.ok(!aliases.includes("spaces"));
  assert.ok(aliases.includes("startConversation"), "aliases still apply");
  assert.ok(!aliases.includes("createThread"));
  // A Space intent still in use keeps the proxy.
  assert.ok(
    serverProxies(createCoreWebPlugin({ intents: { chatMoveThread: own } }))
      .includes("spaces"),
  );
});
