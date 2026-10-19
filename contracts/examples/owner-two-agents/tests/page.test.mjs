import test from "node:test";
import assert from "node:assert/strict";
import { attachPageLifecycle, createDemoPage } from "../dist/page.mjs";
import { createReactViewHost } from "../dist/view-host.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
function nodes(node) {
  return !node || typeof node !== "object"
    ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function harness() {
  const requests = [], roots = [], workers = [], subscriptions = [];
  const stored = new Map();
  const page = createDemoPage({
    createHost(commands) {
      const root = {
        element: undefined,
        renders: 0,
        unmounts: 0,
        render(element) {
          this.element = element;
          this.renders++;
        },
        unmount() {
          this.unmounts++;
        },
      };
      roots.push(root);
      return createReactViewHost(root, commands);
    },
    createWorker() {
      const worker = {
        terminated: 0,
        postMessage(value) {
          this.bootstrap = value;
        },
        terminate() {
          this.terminated++;
        },
      };
      workers.push(worker);
      return worker;
    },
    createClient() {
      return {
        collections: {
          observe(name, query, options) {
            const pending = deferred();
            subscriptions.push({ name, query, ...options, ...pending });
            return pending.promise;
          },
        },
      };
    },
    fetch(url, options) {
      const pending = deferred();
      requests.push({ url, ...options, ...pending });
      return pending.promise;
    },
    storage: {
      getItem: (name) => stored.get(name) ?? null,
      setItem: (name, value) => stored.set(name, value),
    },
    origin: "http://127.0.0.1:48942",
    randomId: () => "run-one",
  });
  const target = new EventTarget();
  const dispose = attachPageLifecycle(target, page);
  const latest = () => roots.at(-1);
  const notice = () =>
    nodes(latest().element).find((node) =>
      node.props?.["data-testid"] === "notice"
    )?.props.children;
  const button = (label) =>
    nodes(latest().element).find((node) =>
      node.type === "button" && node.props.children === label
    );
  const bootstrap = async (index = requests.length - 1) => {
    requests[index].resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          databaseSchema: "test",
          capability: `ephemeral-${index}`,
          workerUrl: "ws://127.0.0.1:48941/workers",
        }),
    });
    await tick();
    workers.at(-1).onmessage({ data: { ready: true } });
    await tick();
  };
  return {
    requests,
    roots,
    workers,
    subscriptions,
    target,
    dispose,
    latest,
    notice,
    button,
    bootstrap,
    stored,
  };
}
test("BFCache restoration recreates the real View host, Worker and live selections; stale run results are fenced", async () => {
  const h = harness();
  try {
    h.target.dispatchEvent(new Event("pageshow"));
    assert.equal(h.roots.length, 1);
    await h.bootstrap();
    assert.equal(h.subscriptions.length, 2);
    const oldRunGesture = h.button("Run two-agent flow").props.onClick;
    const pending = oldRunGesture();
    await tick(); // separate browser gesture turns, after View evaluation
    oldRunGesture(); // repeated gesture while busy does not submit another run
    assert.equal(h.requests.filter((r) => r.url === "/demo/run").length, 1);
    const old = h.latest(), oldRenderCount = old.renders;
    const hide = new Event("pagehide");
    Object.defineProperty(hide, "persisted", { value: true });
    h.target.dispatchEvent(hide);
    assert.equal(old.unmounts, 1);
    assert.equal(h.workers[0].terminated, 1);
    assert.ok(h.requests.every((request) => request.signal.aborted));
    assert.ok(h.subscriptions.every((selection) => selection.signal.aborted));
    assert.throws(oldRunGesture);
    h.target.dispatchEvent(new Event("pageshow"));
    assert.equal(h.roots.length, 2);
    await h.bootstrap();
    assert.equal(h.workers.length, 2);
    assert.equal(h.subscriptions.length, 4);
    // Simulate a transport that delivers despite abort. It must not mutate either host.
    h.requests[1].resolve({
      ok: true,
      json: () =>
        Promise.resolve({ completed: { replies: ["STALE SUCCESS"] } }),
    });
    h.subscriptions[0].onSnapshot({ value: [{ id: "stale" }], reset: true });
    h.workers[0].onmessage({ data: { error: "STALE WORKER" } });
    await pending;
    await tick();
    assert.equal(old.renders, oldRenderCount);
    assert.doesNotMatch(h.notice(), /STALE/);
    assert.match(h.notice(), /owner may have accepted/);
    const replay = h.button("Replay same run").props.onClick();
    assert.equal(JSON.parse(h.requests.at(-1).body).runId, "run-one");
    h.requests.at(-1).resolve({
      ok: true,
      json: () => Promise.resolve({ completed: { replies: ["confirmed"] } }),
    });
    await replay;
    await tick();
    assert.match(h.notice(), /confirmed/);
    assert.ok(
      h.requests.every((request) =>
        ["/bootstrap", "/demo/run"].includes(request.url)
      ),
    );
  } finally {
    h.dispose();
  }
});
test("pagehide during response-body decoding aborts observation and ignores its later result", async () => {
  const h = harness();
  try {
    await h.bootstrap();
    const body = deferred();
    const run = h.button("Run two-agent flow").props.onClick();
    h.requests.at(-1).resolve({ ok: true, json: () => body.promise });
    await tick();
    h.target.dispatchEvent(new Event("pagehide"));
    h.target.dispatchEvent(new Event("pageshow"));
    await h.bootstrap();
    body.resolve({ completed: { replies: ["STALE BODY"] } });
    await run;
    await tick();
    assert.doesNotMatch(h.notice(), /STALE/);
    assert.equal(h.button("Run two-agent flow").props.disabled, false);
  } finally {
    h.dispose();
  }
});
test("late bootstrap cannot restart a disposed lifetime; repeated page events remain bounded", async () => {
  const h = harness();
  try {
    h.target.dispatchEvent(new Event("pagehide"));
    h.target.dispatchEvent(new Event("pagehide"));
    h.target.dispatchEvent(new Event("pageshow"));
    h.target.dispatchEvent(new Event("pageshow"));
    assert.equal(h.roots.length, 2);
    await h.bootstrap(1);
    h.requests[0].resolve({
      ok: true,
      json: () => Promise.resolve({ capability: "stale" }),
    });
    await tick();
    assert.equal(h.workers.length, 1);
    assert.equal(h.subscriptions.length, 2);
    assert.equal(h.roots[0].unmounts, 1);
    h.subscriptions[0].onSnapshot({
      reset: true,
      value: [{ id: "visible", steps: [] }],
    });
    await tick();
    h.subscriptions[0].reject(new Error("authorization expired"));
    await tick();
    assert.equal(
      nodes(h.latest().element).some((n) =>
        n.props?.["data-testid"] === "plan"
      ),
      false,
    );
    assert.match(h.notice(), /authorization expired/);
  } finally {
    h.dispose();
  }
  const count = h.roots.length;
  h.target.dispatchEvent(new Event("pageshow"));
  assert.equal(h.roots.length, count);
});
