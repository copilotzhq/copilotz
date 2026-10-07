import { assert, assertEquals } from "@std/assert";
import type { CollectionNamedQueryRead } from "../../../../runtime/collections/definition.ts";
import { queryCollectionRecords } from "../../../../runtime/collections/query.ts";
import type {
  CollectionQuery,
  CollectionRecord,
  ScopedCollection,
} from "../../../../runtime/collections/index.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
  quoteEventIdentifier,
} from "../../../../runtime/events/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import {
  loadThreadMessageRecordWindow,
  threadMessageWindowFilter,
} from "../../shared/projections.ts";
import { messageCollection } from "./index.ts";
import { provisionCoreHistoryIndexes } from "./storage.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
type CapturedQuery = { sql: string; params: unknown[] };
type Plan = Record<string, unknown> & { Plans?: Plan[] };
function descendants(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(descendants)];
}

Deno.test({
  name:
    "PostgreSQL history indexes preserve pages and bound reads for large and small threads",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `history_pg_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await createTestDatabase({ url: POSTGRES_URL! });
    const tables = createCoreTableNames(schema);
    try {
      await provisionCopilotzSchema(db, schema);
      // A dominant thread, many small threads, other Collections, and large
      // internal snapshots reproduce the JSON selectivity/TOAST failure.
      await db.query(`INSERT INTO ${tables.nodes}
        (id, namespace, type, name, data, created_at, updated_at)
        SELECT 'm' || lpad(i::text, 6, '0'), 'tenant', 'message', '',
          jsonb_build_object(
            'threadId', CASE WHEN i <= 4900 THEN 'large' ELSE 'small-' || (i % 20) END,
            'senderId', 'human', 'content', '[]'::jsonb,
            'historyScopeId', CASE WHEN i % 14 = 0 THEN 'memory' ELSE '' END,
            'visibility', jsonb_build_object(
              'kind', CASE WHEN i % 14 = 0 THEN 'internal'
                          WHEN i % 7 = 0 THEN 'participants' ELSE 'public' END,
              'participantIds', jsonb_build_array('other')),
            'metadata', CASE WHEN i % 14 = 0 THEN jsonb_build_object(
              'copilotzAgentTurn', jsonb_build_object('sourceHistory', repeat(md5(i::text), 10000)))
              ELSE jsonb_build_object('text', repeat(md5(i::text), 90)) END),
          '2026-10-01'::timestamptz + (i / 2) * interval '1 second',
          '2026-10-01'::timestamptz + (i / 2) * interval '1 second'
        FROM generate_series(1, 5740) i`);
      await db.query(`INSERT INTO ${tables.nodes}
        (id, namespace, type, name, data)
        SELECT 'other-' || i, 'tenant', 'tool_plan', '',
          jsonb_build_object('threadId', 'large')
        FROM generate_series(1, 8000) i`);
      await db.query(`ANALYZE ${tables.nodes}`);
      const captured: CapturedQuery[] = [];
      const queries: CollectionQuery[] = [];
      const list = (query: CollectionQuery = {}) => {
        queries.push(query);
        return queryCollectionRecords(
          {
            query: (sql, params = []) => {
              captured.push({ sql, params });
              return db.query(sql, params);
            },
          },
          tables,
          messageCollection,
          "tenant",
          query,
        );
      };
      const read: CollectionNamedQueryRead = {
        get: () => Promise.resolve(null),
        list: (_collection, query) => list(query),
        aggregate: () => {
          throw new Error("No aggregate needed");
        },
      };
      const history = (input: Record<string, unknown>) =>
        messageCollection.queries!.history.select!({
          input: {
            threadId: "large",
            viewerParticipantIds: ["human"],
            limit: 100,
            order: "desc",
            ...input,
          },
          read,
        });
      const explain = async (query: CapturedQuery) => {
        const result = await db.query<
          { "QUERY PLAN": Record<string, unknown>[] }
        >(
          `EXPLAIN (ANALYZE, BUFFERS, TIMING FALSE, FORMAT JSON) ${query.sql}`,
          query.params,
        );
        return result.rows[0]["QUERY PLAN"][0];
      };
      const cases = [
        {},
        { order: "asc" },
        { after: "m004798" },
        { order: "asc", before: "m000200" },
        { threadId: "small-1", limit: 10 },
      ];
      const baseline = [];
      for (const input of cases) baseline.push(await history(input));
      await history({});
      const before = await explain(captured.at(-1)!);
      const agentFilter = threadMessageWindowFilter({
        threadRecord: { id: "large" } as CollectionRecord,
        records: [],
        participantRecords: [],
        anchorActive: true,
        viewerIds: ["human"],
        historyScopeId: "memory",
      });
      const oldAgent = await list({
        filter: agentFilter,
        order: { field: "createdAt", direction: "desc" },
        limit: 100,
      });
      const oldAgentPlan = await explain(captured.at(-1)!);

      await provisionCoreHistoryIndexes(db, schema, { concurrently: true });
      const metrics = [];
      for (let i = 0; i < cases.length; i++) {
        const start = captured.length;
        const rows = await history(cases[i]);
        assertEquals(
          rows,
          baseline[i],
          "Index/statistics installation must not change records or ordering",
        );
        assertEquals(
          captured.length - start,
          cases[i].after || cases[i].before ? 2 : 1,
        );
        const plan = await explain(captured.at(-1)!);
        const nodes = descendants(plan.Plan as Plan);
        if (i < 3) {
          assert(
            !nodes.some((p) => p["Node Type"] === "Sort"),
            "Large page should use index order",
          );
        }
        // PostgreSQL may cheaply sort a small, already bounded index range.
        const scan = nodes.find((p) =>
          ["Index Scan", "Bitmap Heap Scan"].includes(String(p["Node Type"]))
        );
        assert(scan, "Page should use an indexed selection");
        assert(
          Number(scan["Actual Rows"]) +
              Number(scan["Rows Removed by Filter"] ?? 0) < 1200,
          "Both large and small threads should avoid scanning tenant history",
        );
        metrics.push({
          input: cases[i],
          ms: plan["Execution Time"],
          hits: (plan.Plan as Plan)["Shared Hit Blocks"],
        });
      }

      const thread = {
        id: "large",
        namespace: "tenant",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        participantIds: ["human"],
      } as CollectionRecord;
      const context = {
        collections: {
          message: {
            list,
            get: ({ id }: { id: string }) =>
              list({ where: { id }, limit: 1 }).then((r) => r[0] ?? null),
          },
          thread: { get: () => Promise.resolve(thread) },
          participant: { get: () => Promise.resolve(null) },
        } as unknown as Record<string, ScopedCollection>,
      };
      const queryStart = captured.length;
      const agent = await loadThreadMessageRecordWindow(context, "large", {
        viewerIds: ["human"],
        historyScopeId: "memory",
        limit: 100,
      });
      assertEquals(agent.records, [...oldAgent].reverse());
      assertEquals(
        captured.length - queryStart,
        1,
        "Indexed Agent preparation adds no SQL statement",
      );
      assertEquals(queries.at(-1)?.where, { threadId: "large" });
      const agentPlan = await explain(captured.at(-1)!);
      assert(
        !descendants(agentPlan.Plan as Plan).some((p) =>
          p["Node Type"] === "Sort"
        ),
      );
      console.log(
        JSON.stringify({
          publicBeforeMs: before["Execution Time"],
          publicAfter: metrics,
          agentBeforeMs: oldAgentPlan["Execution Time"],
          agentAfterMs: agentPlan["Execution Time"],
          exactPages: cases.length,
          additionalReadStatements: 0,
        }),
      );
    } finally {
      await db.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      );
      await db.close();
    }
  },
});
