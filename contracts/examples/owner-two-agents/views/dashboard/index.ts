import { createElement as h } from "react";
import { defineView } from "@copilotz/copilotz/views";
import type { Dashboard, ReactViewContext } from "../../shared/ui.ts";
export default defineView<Dashboard, ReturnType<typeof h>, ReactViewContext>({
  id: "demo.dashboard",
  shows: { navigation: "demo" },
  renderer: "react",
  modes: ["interactive"],
  render(data, context) {
    const button = (label: string, name: string, disabled = false) =>
      h(
        "button",
        { disabled, onClick: () => context.actions[name]({}) },
        label,
      );
    return h(
      "main",
      null,
      h(
        "header",
        null,
        h("span", { className: "eyebrow" }, "COPILOTZ · OWNER ACCEPTANCE"),
        h("h1", null, "Two agents. One owner."),
        h(
          "p",
          null,
          "The coordinator drafts a release plan. The reviewer improves it. All agent, tool and Processor execution happens in a dedicated browser Worker.",
        ),
      ),
      h(
        "section",
        { className: "status" },
        h("strong", { "data-testid": "connection" }, data.connection),
        h("span", null, `Owner snapshots reset: ${data.resets}`),
        h("small", null, data.packageLabel),
        h(
          "small",
          null,
          "Deterministic acceptance model. No live model provider or API key.",
        ),
      ),
      h(
        "nav",
        { "aria-label": "Demo controls" },
        button(
          "Run two-agent flow",
          "run",
          data.busy || data.connection !== "Browser Worker ready",
        ),
        button(
          "Replay same run",
          "replay",
          data.busy || !data.runId ||
            data.connection !== "Browser Worker ready",
        ),
        button(
          "Disconnect worker",
          "disconnect",
          data.connection !== "Browser Worker ready",
        ),
        button(
          "Reconnect worker",
          "reconnect",
          data.connection === "Browser Worker ready",
        ),
        button("Reconnect Views", "refresh"),
      ),
      h(
        "p",
        { role: "status", "data-testid": "notice" },
        data.notice || "Connect the browser Worker, then run the scenario.",
      ),
      h(
        "section",
        null,
        h("h2", null, "Owner-persisted plans"),
        h(
          "p",
          null,
          "Latest 20 plans. Reloading or restarting the owner with the same schema preserves these records.",
        ),
        ...data.plans.map((row) =>
          h(
            "article",
            {
              key: String(row.id),
              "data-testid": "plan",
              "data-status": row.status,
            },
            h("h3", null, String(row.title)),
            h("strong", { className: "badge" }, String(row.status)),
            h(
              "ol",
              null,
              ...(row.steps as string[]).map((step) =>
                h("li", { key: step }, step)
              ),
            ),
            h("p", null, String(row.review)),
            h(
              "small",
              null,
              `Clock tool: ${row.clock} · ${row.execution} · Run ${row.runId}`,
            ),
          )
        ),
      ),
      h(
        "section",
        null,
        h("h2", null, "Durable execution evidence"),
        h(
          "p",
          null,
          "Latest 60 event summaries, written by the browser Processor through owner commands. No raw private events are exposed.",
        ),
        h(
          "ul",
          { className: "evidence", "data-testid": "evidence" },
          ...data.evidence.map((row) =>
            h(
              "li",
              { key: String(row.id) },
              h("strong", null, String(row.agent)),
              " ",
              String(row.fact),
              h(
                "small",
                null,
                ` ${row.execution} · ${row.at} · Run ${row.runId}`,
              ),
              h(
                "small",
                null,
                `Source ${row.sourceId} · Correlation ${row.correlationId} · Cause ${
                  row.causationId || "none"
                }`,
              ),
            )
          ),
        ),
      ),
    );
  },
});
