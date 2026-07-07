import type { FeatureEntry } from "@/runtime/loaders/resources.ts";

import activity from "./admin/activity.ts";
import agents from "./admin/agents.ts";
import events from "./admin/events.ts";
import overview from "./admin/overview.ts";
import participants from "./admin/participants.ts";
import threads from "./admin/threads.ts";
import usage from "./admin/usage.ts";

type FeatureAction = FeatureEntry["actions"][string];

export const admin: FeatureEntry = {
  name: "admin",
  actions: {
    activity: activity as FeatureAction,
    agents: agents as FeatureAction,
    events: events as FeatureAction,
    overview: overview as FeatureAction,
    participants: participants as FeatureAction,
    threads: threads as FeatureAction,
    usage: usage as FeatureAction,
  },
};

export default {
  admin,
};
