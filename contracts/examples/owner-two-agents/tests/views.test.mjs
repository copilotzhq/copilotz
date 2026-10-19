import test from "node:test";
import assert from "node:assert/strict";
import { createReactViewHost } from "../dist/view-host.mjs";
const data = {
  plans: [],
  evidence: [],
  connection: "ready",
  notice: "",
  busy: false,
  runId: null,
  resets: 0,
  packageLabel: "test",
};
function all(node) {
  return !node || typeof node !== "object"
    ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(all)];
}
test("the host resolves a real React View and renders its plan/evidence UI", async () => {
  let element;
  const host = createReactViewHost({
    render(value) {
      element = value;
    },
    unmount() {},
  }, {});
  await host.render({
    ...data,
    plans: [{
      id: "p",
      runId: "p",
      title: "Plan",
      status: "published",
      steps: ["Check"],
      review: "Reviewed",
      clock: "now",
      execution: "browser-worker",
    }],
  });
  assert.equal(element.type, "main");
  assert.ok(
    all(element).some((node) => node.props?.["data-testid"] === "plan"),
  );
  host.close();
});
test("later renders win, action capabilities are revoked on disposal, and no writes occur while rendering", async () => {
  let element, calls = 0, unmounted = 0;
  const host = createReactViewHost({
    render(value) {
      element = value;
    },
    unmount() {
      unmounted++;
    },
  }, {
    run() {
      calls++;
    },
  });
  await Promise.all([
    host.render({ ...data, notice: "old" }),
    host.render({ ...data, notice: "new" }),
  ]);
  assert.equal(
    all(element).find((node) => node.props?.["data-testid"] === "notice").props
      .children,
    "new",
  );
  assert.equal(calls, 0);
  const button = all(element).find((node) => node.type === "button");
  button.props.onClick();
  assert.equal(calls, 1);
  host.close();
  assert.equal(unmounted, 1);
  assert.throws(() => button.props.onClick());
});
test("executable data is rejected before it reaches a View", async () => {
  const host = createReactViewHost({
    render() {
      assert.fail("must not render");
    },
    unmount() {},
  }, {});
  await assert.rejects(() => host.render({ ...data, notice() {} }));
  host.close();
});
