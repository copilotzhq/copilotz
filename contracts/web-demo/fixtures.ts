/**
 * Demo fixture data: three Spaces, nine conversations (two without a Space,
 * one archived), a rich conversation with Markdown, a table, code, math, an
 * image and a PDF, a completed tool call and a live one, and Space members.
 * Times are relative to `now` so recency groups are stable on any day.
 * @module
 */
type Row = { id: string; [field: string]: unknown };

const FUNNEL =
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260"><rect width="480" height="260" rx="14" fill="#f8fafc"/><text x="24" y="38" font-family="system-ui" font-size="16" font-weight="600" fill="#0f172a">Q3 funnel</text><g font-family="system-ui" font-size="12" fill="#334155"><rect x="24" y="60" width="420" height="34" rx="6" fill="#6366f1"/><text x="34" y="82" fill="#fff">Visits 48,200</text><rect x="24" y="104" width="300" height="34" rx="6" fill="#8b5cf6"/><text x="34" y="126" fill="#fff">Trials 12,400</text><rect x="24" y="148" width="186" height="34" rx="6" fill="#a855f7"/><text x="34" y="170" fill="#fff">Paid 7,690 (−38%)</text><rect x="24" y="192" width="96" height="34" rx="6" fill="#c084fc"/><text x="34" y="214" fill="#fff">Retained</text></g></svg>`;

/** Bodies the demo feed adapter returns for persisted attachments. */
export const assets: Record<string, { type: string; body: string }> = {
  "asset-funnel": { type: "image/svg+xml", body: FUNNEL },
  "asset-brief": { type: "application/pdf", body: "%PDF-1.4\n%demo\n" },
  // Tool results Core stored as JSON; the window read leaves them as
  // references, and the chat reads them when their step shows.
  "json-board": {
    type: "application/json",
    body: JSON.stringify({ ok: true, boardId: "b-cycle1", cards: 5 }),
  },
  "json-suite": {
    type: "application/json",
    body: JSON.stringify({
      stdout:
        "running 14 tests from ./tests/launch.test.ts\nok | 14 passed | 0 failed (1s)\n",
      exitCode: 0,
    }),
  },
};

/** A JSON tool result as the message window read returns it: a reference. */
export const jsonResult = (assetId: string) => ({
  assetId,
  kind: "json",
  role: "tool.output",
  mediaType: "application/json",
  resolve: false,
});

const text = (value: string, role = "body") => ({
  assetId: `text-${crypto.randomUUID()}`,
  kind: "text",
  role,
  mediaType: "text/markdown",
  value,
});

export const agents = [
  {
    id: "p-north",
    externalId: "north",
    agentId: "north",
    participantType: "agent",
    name: "North",
    metadata: { description: "Lead strategist; drives the plan" },
  },
  {
    id: "p-south",
    externalId: "south",
    agentId: "south",
    participantType: "agent",
    name: "South",
    metadata: { description: "Critic; stress-tests assumptions" },
  },
  {
    id: "p-east",
    externalId: "east",
    agentId: "east",
    participantType: "agent",
    name: "East",
    metadata: { description: "Builder; runs tools and computers" },
  },
  {
    id: "p-west",
    externalId: "west",
    agentId: "west",
    participantType: "agent",
    name: "West",
    metadata: { description: "Researcher; gathers evidence" },
  },
] as const;

export const people = [
  {
    id: "p-ana",
    externalId: "u-ana",
    participantType: "human",
    name: "Ana Souza",
    email: "ana@example.com",
    metadata: {},
  },
  {
    id: "p-bruno",
    externalId: "u-bruno",
    participantType: "human",
    name: "Bruno Lima",
    email: "bruno@example.com",
    metadata: {},
  },
  {
    id: "p-carla",
    externalId: "u-carla",
    participantType: "human",
    name: "Carla Dias",
    email: "carla@example.com",
    metadata: {},
  },
  {
    id: "p-terminal",
    externalId: "terminal",
    participantType: "tool",
    name: "terminal",
    metadata: {},
  },
  {
    id: "p-kanban",
    externalId: "kanban",
    participantType: "tool",
    name: "kanban",
    metadata: {},
  },
];

/** The signed-in person, as an app supplies `resources.chat.sender`. */
export const sender = {
  id: "u-ana",
  externalId: "u-ana",
  participantType: "human",
  name: "Ana Souza",
  email: "ana@example.com",
};

export function fixtures(now = Date.now()): Record<string, Row[]> {
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  const everyone = ["p-ana", "p-north", "p-south", "p-east", "p-west"];
  const thread = (
    id: string,
    name: string,
    spaceId: string | null,
    minutes: number,
    status = "active",
  ): Row => ({
    id,
    name,
    status,
    ...(spaceId ? { spaceId } : {}),
    participantIds: everyone,
    metadata: {},
    createdAt: ago(minutes + 600),
    updatedAt: ago(minutes),
  });
  const message = (
    id: string,
    threadId: string,
    senderId: string,
    minutes: number,
    content: unknown[],
    metadata: Record<string, unknown> = {},
  ): Row => ({
    id,
    threadId,
    senderId,
    recipientIds: [],
    content,
    metadata,
    createdAt: ago(minutes),
    updatedAt: ago(minutes),
  });
  return {
    space: [
      {
        id: "sp-launch",
        name: "Q4 Launch",
        description:
          "Go-to-market plan, pricing and landing page for the **Q4 release**.",
        ownerId: "p-ana",
        memberIds: ["p-ana", "p-bruno", "p-carla"],
        status: "active",
        revision: 3,
        createdAt: ago(40_000),
        updatedAt: ago(60),
      },
      {
        id: "sp-research",
        name: "Market Research",
        description: "Customer interviews, surveys and competitor teardown.",
        ownerId: "p-ana",
        memberIds: ["p-ana", "p-carla"],
        status: "active",
        revision: 1,
        createdAt: ago(30_000),
        updatedAt: ago(500),
      },
      {
        id: "sp-infra",
        name: "Platform Infra",
        description: "CI, environments and deployment.",
        ownerId: "p-bruno",
        memberIds: ["p-bruno", "p-ana"],
        status: "active",
        revision: 1,
        createdAt: ago(50_000),
        updatedAt: ago(7_300),
      },
    ],
    thread: [
      thread("t-plan", "Launch plan kickoff", "sp-launch", 4),
      thread("t-pricing", "Pricing experiments", "sp-launch", 1_500),
      thread("t-copy", "Landing page copy", "sp-launch", 4_400),
      thread("t-survey", "Customer survey synthesis", "sp-research", 95),
      thread("t-competitors", "Competitor teardown", "sp-research", 2_900),
      thread("t-ci", "CI pipeline migration", "sp-infra", 7_300),
      thread("t-ideas", "Random ideas", null, 30),
      thread("t-notes", "Weekly notes", null, 5_800),
      thread("t-old", "Archived brainstorm", null, 20_000, "archived"),
    ],
    participant: [...agents, ...people] as unknown as Row[],
    message: [
      message("m1", "t-plan", "p-ana", 12, [
        text(
          "Can the team draft a kickoff plan for the Q4 launch? The funnel chart from last quarter is attached.",
        ),
        {
          assetId: "asset-funnel",
          kind: "image",
          role: "attachment",
          mediaType: "image/svg+xml",
          name: "funnel-q3.svg",
          metadata: { byteLength: 1840 },
        },
      ]),
      message("m2", "t-plan", "p-north", 11, [
        text(
          "## Kickoff plan\n\nHere is a first cut. I created the **Launch cycle 1** board in this Space with the first five cards.\n\n| Milestone | Owner | Due |\n|---|---|---|\n| Positioning brief | North | Week 1 |\n| Pricing test | South | Week 2 |\n| Landing page v1 | East | Week 3 |\n\nThe conversion target is modelled as $p = \\frac{c}{v}$, with a 95% interval of\n\n$$\n\\hat p \\pm 1.96\\sqrt{\\frac{\\hat p(1-\\hat p)}{n}}\n$$\n\nA quick helper to track it:\n\n```ts\nexport function conversion(clicks: number, visits: number): number {\n  return visits === 0 ? 0 : clicks / visits;\n}\n```\n\n> South will challenge the pricing assumptions before we lock week 2.",
        ),
      ], {
        copilotzWorkflow: { kind: "agent_output", llmAttemptId: "run-north-1" },
        llmReasoning: [
          text(
            "The goal is a kickoff plan. Split it into scope, milestones and risks, then put the first work cycle on a shared board so the team can track it.",
            "reasoning",
          ),
        ],
        llmToolCalls: [{
          id: "tc1",
          action: "kanban",
          input: {
            action: "create_board",
            spaceId: "sp-launch",
            name: "Launch cycle 1",
            columns: ["Backlog", "To Do", "Doing", "Done"],
          },
        }],
      }),
      message("m2-result", "t-plan", "p-kanban", 11, [
        jsonResult("json-board"),
      ], { toolInvocation: { id: "tc1" }, toolStatus: "completed" }),
      message("m3", "t-plan", "p-south", 10, [
        text(
          "Two risks worth naming early:\n\n1. The Q3 funnel drops **38%** between trial and paid, so the pricing test needs a control.\n2. Landing page v1 depends on the positioning brief; keep them in order.\n\n- [x] Control group defined\n- [ ] Sample size agreed",
        ),
      ], {
        copilotzWorkflow: { kind: "agent_output", llmAttemptId: "run-south-1" },
      }),
      message("m4", "t-plan", "p-ana", 3, [
        text(
          "@East please run the test suite on the launch environment before we share the plan.",
        ),
        {
          assetId: "asset-brief",
          kind: "file",
          role: "attachment",
          mediaType: "application/pdf",
          name: "launch-brief.pdf",
          metadata: { byteLength: 248_000 },
        },
      ]),
      message("m-ideas-1", "t-ideas", "p-ana", 31, [
        text("What if the onboarding email linked straight to the Space?"),
      ]),
      message("m-ideas-2", "t-ideas", "p-west", 30, [
        text(
          "Worth testing. Teams that open a Space in their first session keep using the product **2.3×** more often in week two.",
        ),
      ], {
        copilotzWorkflow: { kind: "agent_output", llmAttemptId: "run-west-1" },
      }),
    ],
  };
}
