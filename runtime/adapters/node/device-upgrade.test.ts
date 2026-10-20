import { assert, assertEquals } from "@std/assert";
import {
  createHypervisor,
  type HypervisorRequestDecision,
} from "../../../dependencies/oxian-hypervisor.ts";
import { hostedDeviceUpgrade } from "../../subscriptions/hosting.ts";
import { DEVICE_LIMITS } from "../../subscriptions/device.ts";
import { withDeviceUpgrades } from "./device-upgrade.ts";

type Upgrade = Extract<HypervisorRequestDecision, { kind: "upgrade" }>;
type Connection = Parameters<Upgrade["attach"]>[0];
type Observer = Parameters<Connection["subscribe"]>[0];

function fixture() {
  const admission = Promise.withResolvers<void>();
  const bound = Promise.withResolvers<void>();
  let observer: Observer = {};
  let closed = false;
  const messages: unknown[] = [];
  const owner = createHypervisor({
    transports: [{
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    }],
    async fallback(request) {
      if (new URL(request.url).pathname !== "/api/device") {
        return new Response(null, { status: 404 });
      }
      const upgrade = hostedDeviceUpgrade(request)!;
      await admission.promise;
      try {
        const { socket, response } = upgrade(request);
        socket.addEventListener(
          "message",
          (event) => messages.push(event.data),
        );
        return response;
      } finally {
        bound.resolve();
      }
    },
  });
  const host = withDeviceUpgrades(owner);
  const decision = host.prepare(
    new Request("http://localhost/api/device", {
      headers: { upgrade: "websocket" },
    }),
  );
  assert(decision.kind === "upgrade");
  const connection: Connection = {
    protocol: "",
    get state() {
      return closed ? "closed" : "open";
    },
    bufferedAmount: 0,
    send() {},
    close() {
      closed = true;
      observer.close?.({ code: 1000, reason: "", wasClean: true });
    },
    subscribe(next) {
      observer = next;
      return () => {
        observer = {};
      };
    },
  };
  decision.attach(connection);
  return {
    host,
    owner,
    admission,
    bound,
    decision,
    messages,
    receive(data: string | Uint8Array) {
      observer.message?.(data);
    },
    closed: () => closed,
    async finish() {
      admission.resolve();
      await bound.promise;
      decision.cancel();
      await owner.shutdown();
    },
  };
}

Deno.test("Node device upgrade holds early frames until asynchronous admission completes", async () => {
  const test = fixture();
  try {
    test.receive("hello");
    assertEquals(test.messages, []);
    test.admission.resolve();
    await test.bound.promise;
    await Promise.resolve();
    assertEquals(test.messages, ["hello"]);
    test.receive("subscribe");
    assertEquals(test.messages, ["hello", "subscribe"]);
    const ordinary = test.host.prepare(new Request("http://localhost/other"));
    assert(ordinary.kind === "response");
    assertEquals((await ordinary.response).status, 404);
  } finally {
    await test.finish();
  }
});

Deno.test("Node device upgrade discards early frames when admission fails", async () => {
  const test = fixture();
  try {
    test.receive("hello");
    test.admission.reject(new Error("recovery refused"));
    await Promise.resolve();
    await Promise.resolve();
    assert(test.closed());
    assertEquals(test.messages, []);
  } finally {
    test.decision.cancel();
    await test.owner.shutdown();
  }
});

for (const limit of ["bytes", "frames"] as const) {
  Deno.test(`Node device pending admission is bounded by ${limit}`, async () => {
    const test = fixture();
    try {
      if (limit === "bytes") {
        // Each frame is valid; only their accumulated size exceeds the budget.
        const frame = "x".repeat(Math.floor(DEVICE_LIMITS.queuedBytes / 2));
        assert(frame.length <= DEVICE_LIMITS.frame);
        test.receive(frame);
        test.receive(frame);
        assert(!test.closed());
        test.receive("x");
      } else {
        for (let i = 0; i < DEVICE_LIMITS.queuedFrames; i++) {
          test.receive("x");
        }
        assert(!test.closed());
        test.receive("x");
      }
      assert(test.closed());
      assertEquals(test.messages, []);
    } finally {
      await test.finish();
    }
  });
}

for (const data of [new Uint8Array([1]), "x".repeat(DEVICE_LIMITS.frame + 1)]) {
  Deno.test(`Node device refuses ${typeof data === "string" ? "oversized" : "binary"} frames before admission`, async () => {
    const test = fixture();
    try {
      test.receive(data);
      assert(test.closed());
      assertEquals(test.messages, []);
    } finally {
      await test.finish();
    }
  });
}

Deno.test("Node device cancelled upgrade cannot bind after late admission", async () => {
  const test = fixture();
  try {
    test.receive("hello");
    test.decision.cancel();
    test.admission.resolve();
    await test.bound.promise;
    assert(test.closed());
    assertEquals(test.messages, []);
  } finally {
    await test.finish();
  }
});
