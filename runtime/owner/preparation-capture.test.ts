import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_PREPARATION_SCHEMA,
  parseOwnerPreparationCapture,
  parsePreparationSourceReference,
  preparationCaptureFromMetadata,
} from "./preparation-capture.ts";
const digest = `sha256:${"1".repeat(64)}`;
const capture = () => ({
  schema: OWNER_PREPARATION_SCHEMA,
  preparation: "channel.text",
  source: {
    source: {
      name: "messages",
      kind: "message",
      path: "content",
      recordId: "message-1",
      namespace: "space",
      digest,
    },
    audience: "channel",
    content: [{
      ref: {
        assetId: "asset-1",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
      version: { byteLength: 5, digest },
    }],
  },
  resources: [{ namespace: "channel", alias: "style", digest }],
  view: {
    shows: "message",
    hints: { mode: "channel", renderer: "text" },
    selection: { kind: "registered", id: "message.channel" },
  },
});
test("preparation capture retains detached original logical provenance and explicit generic fallback", () => {
  const input = capture();
  const parsed = parseOwnerPreparationCapture(input);
  input.source.content[0].ref.assetId = "replacement";
  input.resources[0].digest = `sha256:${"2".repeat(64)}`;
  assert.equal(parsed.source.content[0].ref.assetId, "asset-1");
  assert.equal(parsed.resources[0].digest, digest);
  assert.deepEqual(
    parseOwnerPreparationCapture({
      ...capture(),
      view: { ...capture().view, selection: { kind: "generic" } },
    }).view.selection,
    { kind: "generic" },
  );
});
test("preparation metadata distinguishes absence from every present malformed value", () => {
  assert.equal(
    preparationCaptureFromMetadata({ actionId: "child" }),
    undefined,
  );
  for (
    const preparation of [null, false, 0, "", {}, [], {
      ...capture(),
      schema: "future",
    }]
  ) {
    assert.throws(
      () => preparationCaptureFromMetadata({ preparation }),
      /preparation_capture_invalid/,
    );
  }
  assert.equal(
    preparationCaptureFromMetadata({ preparation: capture() })?.preparation,
    "channel.text",
  );
});
test("preparation capture rejects physical locators, hydrated content, conflicting resources and unbounded provenance", () => {
  const base = capture();
  const bad = [
    { ...base, bodyId: "orphan" },
    {
      ...base,
      source: {
        ...base.source,
        content: [{ ...base.source.content[0], value: "plaintext" }],
      },
    },
    {
      ...base,
      source: {
        ...base.source,
        content: [{
          ...base.source.content[0],
          ref: { ...base.source.content[0].ref, location: {} },
        }],
      },
    },
    { ...base, resources: [base.resources[0], base.resources[0]] },
    { ...base, preparation: "x".repeat(513) },
    {
      ...base,
      source: {
        ...base.source,
        content: Array(101).fill(base.source.content[0]),
      },
    },
    {
      ...base,
      source: {
        ...base.source,
        content: [{
          ...base.source.content[0],
          version: { byteLength: 1_048_577, digest },
        }],
      },
    },
    {
      ...base,
      view: { ...base.view, selection: { kind: "generic", id: "ambiguous" } },
    },
  ];
  for (const value of bad) {
    assert.throws(
      () => parseOwnerPreparationCapture(value),
      /preparation_capture_invalid/,
    );
  }
});
test("preparation capture refuses accessors and malformed integrity facts without executing them", () => {
  let reads = 0;
  const value = Object.defineProperty(capture(), "preparation", {
    enumerable: true,
    get() {
      reads++;
      return "hidden";
    },
  });
  assert.throws(
    () => parseOwnerPreparationCapture(value),
    /preparation_capture_invalid/,
  );
  assert.equal(reads, 0);
  const source = capture().source;
  for (
    const version of [{ byteLength: -1, digest }, { byteLength: 1.5, digest }, {
      byteLength: 5,
      digest: "unspecified",
    }]
  ) {
    assert.throws(
      () =>
        parsePreparationSourceReference({
          ...source,
          content: [{ ...source.content[0], version }],
        }),
      /preparation_capture_invalid/,
    );
  }
});

test("preparation metadata selector refuses own accessors without invoking them", () => {
  let reads = 0;
  const metadata = Object.defineProperty({}, "preparation", {
    enumerable: true,
    get() {
      reads++;
      return capture();
    },
  });
  assert.throws(
    () => preparationCaptureFromMetadata(metadata),
    /preparation_capture_invalid/,
  );
  assert.equal(reads, 0);
});

test("ordinary-record provenance is explicit, detached and cannot adopt content provenance", () => {
  const content = capture().source;
  const before = JSON.stringify(content);
  assert.equal(
    JSON.stringify(parsePreparationSourceReference(content)),
    before,
  );
  const { path: _path, ...source } = content.source;
  const record = {
    source: { ...source, selection: "record" },
    audience: "context",
    content: [],
  };
  const parsed = parsePreparationSourceReference(record);
  record.source.recordId = "changed";
  assert.equal(parsed.source.recordId, "message-1");
  for (
    const invalid of [
      { ...record, source: { ...record.source, path: "content" } },
      { ...record, source: { ...record.source, selection: "unknown" } },
      { ...record, content: content.content },
      { ...record, source },
    ]
  ) {
    assert.throws(
      () => parsePreparationSourceReference(invalid),
      /preparation_capture_invalid/,
    );
  }
});
