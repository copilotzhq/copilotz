/**
 * The org's page (kind `org`, at `/org`), where the app serves many orgs:
 * its name and face, your standing there, then its sections, which front
 * ends add (the `orgSettings` resource: spaces' About and Members, usage's
 * Usage), each a tab the address says (`?tab=members`). A section's View
 * gets item `{ _id }` (the org's id) and hints `{ org, role, staff, mode }`;
 * each shows only to the roles it names (staff see them all). Owners and
 * admins run it from here; the others see what it is, and who's in it.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../runtime/mod.ts";
import {
  Badge,
  Button,
  EmptyState,
  go,
  Icon,
  LazyView,
  orgName,
  Page,
  Skeleton,
  Tabs,
  Title,
  useOrgs,
} from "../../../../hosts/web/mod.ts";
import { chosenSection, runs, sectionsOf, standingName } from "../shared/orgs.ts";
import { useStanding } from "../shared/standing.ts";
import { OrgFace } from "./orgs.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

export const orgView = (_: unknown, ctx: ViewContext<ReactNode>): ReactNode => (
  <OrgPage
    given={ctx.resources.orgSettings}
    tab={(ctx.hints.query as Record<string, string> | undefined)?.tab}
    call={ctx.call}
  />
);

/** The section's address. */
const tabPath = (key: string) => `/org?tab=${encodeURIComponent(key)}`;

function OrgPage({ given, tab, call }: { given: unknown; tab?: string; call: Call }): ReactNode {
  const orgs = useOrgs();
  const ready = orgs.status === "ready";
  const standing = useStanding(call, ready);
  if (orgs.status === "none") {
    return (
      <div className="copilotz-org-missing">
        <Title text="Organization" />
        <EmptyState icon="building" heading="h1" title="One organization here">
          This app serves a single organization, so there's nothing to set here.
        </EmptyState>
      </div>
    );
  }
  if (!ready || !standing) {
    return (
      <Page title={<Skeleton width={200} height={30} />} width="lg">
        <div className="copilotz-org-loading" aria-busy="true">
          <Skeleton height={36} width="60%" />
          <Skeleton height={72} radius="xl" />
          <Skeleton height={72} radius="xl" />
        </div>
      </Page>
    );
  }
  const here = orgs.here;
  if (!here) {
    return (
      <div className="copilotz-org-missing">
        <Title text="Organization" />
        <EmptyState
          icon="building"
          heading="h1"
          title="You're not in an organization"
          action={<Button variant="primary" href="/">Go home</Button>}
        >
          Choose one from the switcher at the top of the sidebar.
        </EmptyState>
      </div>
    );
  }
  const name = orgName(here);
  const sections = sectionsOf(given, standing);
  const section = chosenSection(sections, tab);
  const personal = here.kind === "personal";
  return (
    <Page
      title={name}
      width="lg"
      className="copilotz-org-page"
      leading={<OrgFace org={here} person={orgs.value.person} size={44} />}
      badges={
        <>
          <Badge variant="outline">{personal ? "Personal org" : "Team org"}</Badge>
          {standing.staff && !standing.role
            ? (
              <Badge tone="warning">
                <Icon name="shield" size={12} />
                Staff access
              </Badge>
            )
            : standing.role
            ? <Badge tone={runs(standing) ? "primary" : "neutral"}>{standingName(standing)}</Badge>
            : null}
        </>
      }
      description={standing.staff && !standing.role
        ? `You're here as platform staff: what you do is on ${here.name}'s record.`
        : personal
        ? "Your own organization: just you, and what you make alone."
        : runs(standing)
        ? `Who's in ${here.name}, what it uses, and what it's called.`
        : standing.role === "guest"
        ? `What ${here.name} is. As a guest, you work in the spaces you're invited to.`
        : `What ${here.name} is, and who's in it.`}
    >
      <Title text={section ? `${name}: ${section.title}` : name} />
      {sections.length
        ? (
          <>
            <Tabs
              label={`${name}'s settings`}
              variant="line"
              className="copilotz-org-tabs"
              value={section?.key ?? ""}
              panel="copilotz-org-section"
              onChange={(key) => go(tabPath(key))}
              tabs={sections.map((s) => ({
                value: s.key,
                label: s.title,
                ...(s.icon ? { icon: s.icon } : {}),
                href: tabPath(s.key),
              }))}
            />
            <div
              id="copilotz-org-section"
              role="tabpanel"
              className="copilotz-org-section"
              data-section={section?.key}
            >
              {section
                ? (
                  <LazyView
                    key={section.key}
                    kind={section.view}
                    item={{ _id: here.id }}
                    hints={{
                      org: here,
                      role: standing.role,
                      staff: standing.staff,
                      mode: "page",
                    }}
                    fallback={
                      <div className="copilotz-org-loading" aria-busy="true">
                        <Skeleton height={64} radius="xl" />
                        <Skeleton height={64} radius="xl" />
                      </div>
                    }
                  />
                )
                : null}
            </div>
          </>
        )
        : (
          <EmptyState icon="settings" title="Nothing to set here">
            This app adds no sections to an organization's page.
          </EmptyState>
        )}
    </Page>
  );
}
