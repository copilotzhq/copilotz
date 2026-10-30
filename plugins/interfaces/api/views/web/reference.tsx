/**
 * A key's reference, as `GET /api/` says it with the key: each Action it may
 * call (where, what it does, its input's fields), its queries and Views,
 * and following what happens. Descriptions come from the app's catalog,
 * asked for when it's first shown.
 */
import { Fragment, type ReactNode } from "react";
import { Badge, Skeleton } from "../../../../../hosts/web/mod.ts";
import { fieldsOf, useCatalog } from "./catalog.ts";
import type { Allowed } from "./snippet.ts";

function Endpoint({ method, path }: { method: string; path: string }): ReactNode {
  return (
    <div className="api-ref-head">
      <Badge tone={method === "GET" ? "info" : "primary"} variant="outline">{method}</Badge>
      <code>{path}</code>
    </div>
  );
}

export function Reference({ allowed }: { allowed: Allowed }): ReactNode {
  const catalog = useCatalog(allowed.actions.length > 0);
  const known = Array.isArray(catalog) ? catalog : [];
  return (
    <div className="api-ref">
      {allowed.actions.map((name) => {
        const entry = known.find((a) => a.name === name);
        const fields = fieldsOf(entry?.input);
        return (
          <div className="api-ref-item" key={`a:${name}`}>
            <Endpoint method="POST" path={`/api/actions/${name}`} />
            {catalog === "loading" ? <Skeleton height={14} width="60%" /> : null}
            {entry?.description ? <p>{entry.description}</p> : null}
            {catalog === "unavailable" || (Array.isArray(catalog) && !entry)
              ? <p>The body is its input, as JSON.</p>
              : null}
            {fields.length
              ? (
                <dl className="api-ref-fields">
                  {fields.map((f) => (
                    <Fragment key={f.name}>
                      <dt>
                        <code>{f.name}</code>
                        {f.required ? null : <span className="api-ref-optional">?</span>}
                      </dt>
                      <dd>{f.description ? `${f.type}: ${f.description}` : f.type}</dd>
                    </Fragment>
                  ))}
                </dl>
              )
              : null}
          </div>
        );
      })}
      {allowed.queries.map((name) => (
        <div className="api-ref-item" key={`q:${name}`}>
          <Endpoint method="POST" path={`/api/queries/${name}`} />
          <p>The body is the query's params, as JSON; it answers what the query returns.</p>
        </div>
      ))}
      {(allowed.views ?? []).map((name) => (
        <div className="api-ref-item" key={`v:${name}`}>
          <Endpoint method="GET" path={`/api/views/${name}?item=…`} />
          <p>What the View shows, for its item; with follow=1, again each time it changes.</p>
        </div>
      ))}
      <div className="api-ref-item">
        <Endpoint method="GET" path="/api/events" />
        <p>
          Server-sent events: what changes in this space as it happens (a reply written, a
          conversation started), and how this key's own calls end.
        </p>
      </div>
    </div>
  );
}
