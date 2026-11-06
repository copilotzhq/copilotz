/**
 * Every word the Usage page says, in English, by key (`usage.spendBy`). An app gives its own in
 * a `words` resource under the full key; blanks are `{name}`s and plurals are by the `count` blank.
 */
import { defineWords } from "../../../../../hosts/web/mod.ts";

export const say = defineWords("usage", {
  // Who and what a row or an item is about
  notTiedToAnyone: "Not tied to anyone",
  you: "You",
  spaceNotRecorded: "Space not recorded",
  spaceNotReached: "A space you don't reach",
  yourPersonalSpace: "Your Personal space",
  personalSpaceOf: "{name}'s Personal space",
  quoted: "“{name}”",

  // The page: filters, errors, loading
  tryAgain: "Try again",
  readError: "We couldn't read this org's usage just now. {error}",
  month: "Month",
  thisMonth: "This month",
  whoseUsage: "Whose usage",
  everyone: "Everyone",
  justYou: "Just you",
  readAgain: "Read it again",
  ownUsage: "Your own usage. The org's owners and admins see everyone's.",

  // The chips that keep the page to one row
  keptTo: "Kept to",
  showingOnly: "Showing only",
  chipWhat: "{what}:",
  showAllNotOnly: "Show all, not only {name}",
  showEverything: "Show everything",

  // Nothing used yet
  nothingUsedThisMonth: "Nothing used this month yet",
  nothingUsedIn: "Nothing used in {month}",
  emptyEveryone:
    "As agents answer, computers run and apps serve in this org, what each was charged shows here, by kind, space, person, agent and model.",
  emptyOwn: "As agents answer and computers run for you, what each was charged shows here.",
  unpriced: {
    one:
      "We don't know what {total} use cost: their models aren't in the price catalog, and the app sets no rate for them, so the spend may leave them out.",
    other:
      "We don't know what {total} uses cost: their models aren't in the price catalog, and the app sets no rate for them, so the spend may leave them out.",
  },

  // The headline
  spentThisMonth: "spent this month",
  spentIn: "spent in {month}",
  spentByYouThisMonth: "spent by you this month",
  spentByYouIn: "spent by you in {month}",
  shareOfAll: "{percent} of all spend",
  shareOfBudget: "{percent} of the {limit} budget",
  budgetUsedUp: "the budget is used up",
  outOfCredits: "out of credits",
  creditsLeft: "{amount} of credits left",
  creditsLeftLasts: "{amount} of credits left, {lasts} at this pace",
  budgetLeft: "{amount} left",
  budgetLeftLasts: "{amount} left, {lasts} at this pace",
  budgetLeftEnough: "{amount} left, enough for the month at this pace",
  meterLabel: "Spent this month, against the budget",
  meterValue: "{spent} of {limit}",
  meterNow: "How far into the month we are",
  versus: "vs. {against}",
  pointLastMonth: "this point last month",
  nothingByPoint: "Nothing by this point last month",
  nothingIn: "Nothing in {against}",
  cachingSaved: "caching saved {amount}",
  cachingCost: "caching cost {amount} more than it saved",
  billing: "Billing",
  staffOnly: "Staff only",
  costOf: "Cost {amount}",
  marginOf: "{percent} margin",
  underCost: "{amount} under cost",
  overCost: "{amount} over cost",

  // How long what's left lasts
  lastsLessThanDay: "less than a day",
  lastsDay: "about a day",
  lastsDays: "about {count} days",
  lastsWeeks: "about {count} weeks",
  lastsMonths: "about {count} months",
  lastsYear: "more than a year",

  // Savings
  savedNothing: "Nothing saved yet",
  saved: "{amount} saved",
  savedNegative: "{amount} more than without it",

  // How long, from seconds
  seconds: "{count} s",
  minutes: "{count} min",
  hoursMinutes: "{hours}h {minutes}m",
  hours: "{hours}h",

  // What it is grouped by
  kind: "Kind",
  space: "Space",
  person: "Person",
  agent: "Agent",
  model: "Model",
  byKind: "kind",
  bySpace: "space",
  byPerson: "person",
  byAgent: "agent",
  byModel: "model",

  // Kinds and what a use was for
  kindAgents: "Agents",
  kindComputers: "Computers",
  kindApps: "Apps",
  purposeHistory: "Summaries",
  purposeMemory: "Memory notes",
  purposeTranscription: "Voice transcribed",
  purposeDraft: "Drafting agents",
  conversationUpkeep: "Conversation upkeep",
  otherModelUse: "Other model use",
  upkeepDetail: "summaries, memory notes, voice",
  beforeSpaces: "used before spaces were recorded",

  // The breakdown: chart and ranked list
  spendBy: "Spend by",
  theRest: "The rest",
  chartLabel: "Spend per day in {month}, by {by}",
  rowsLabel: "By {by}: choose one to see only it",
  showAllAgain: "Show all again",
  seeOnly: "See only {name}",
  rowCost: "Cost {amount}",
  rowCostMargin: "Cost {amount} · {percent} margin",
  showFewer: "Show fewer",
  showAll: "Show all {count}",
  tokens: "{tokens} tokens",
  calls: { one: "{calls} call", other: "{calls} calls" },
  fromInputCache: "{percent} of input from cache",

  // The chart
  chartKeys: "{label}: arrow keys move between days",
  stillToCome: "Still to come",
  hideNumbers: "Hide the numbers",
  showNumbers: "Show the numbers",
  day: "Day",
  spend: "Spend",
  dayAnnounced: "{day}: {spend}",
  seriesAnnounced: "{name} {amount}",

  // Who paid
  yourKey: "Your key",
  yourKeyTitle: "Ran on your own key: no credits used",
  plan: "Plan",
  planTitle: "Ran on a connected plan: no credits used",
  noKnownCost: "No known cost",
  staffCostMargin: "Cost and margin: staff only",

  // Activity
  activity: "Activity",
  activityEveryone: "Everyone's, newest first",
  activityEveryoneFiltered: "Everyone's, newest first, as filtered",
  activityYours: "Yours, newest first",
  activityYoursFiltered: "Yours, newest first, as filtered",
  nothingMatches: "Nothing here matches what's chosen.",
  showOlder: "Show older",
  aConversation: "a conversation",
  aComputer: "a computer",
  anApp: "an app",
  anAgent: "An agent",
  turnTitle: "{agent} in {where}",
  upkeepOf: "Upkeep of {where}",
  modelCalls: "Model calls",
  fromCache: "{percent} from cache",
  diskOf: "Disk of {computer}",
  snapshotOf: "Snapshot of {computer}",
  gbHours: "{amount} GB-hours",
  onDay: "on {day}",
  computerTitle: "Computer {computer} {size}",
  woke: "woke {from}, last {last}",
  appTitle: "App {app}",
  requests: "{requests} requests",
  buildMinutes: { one: "{minutes} build minute", other: "{minutes} build minutes" },
  meterTitle: "{meter}: {model}",
  uses: { one: "{count} use", other: "{count} uses" },
  hideModelCalls: "Hide its model calls",
  showModelCalls: { one: "Show its {count} model call", other: "Show its {count} model calls" },

  // A turn's model calls
  time: "Time",
  inColumn: "In",
  fromCacheColumn: "From cache",
  outColumn: "Out",
  costColumn: "Cost",
});
