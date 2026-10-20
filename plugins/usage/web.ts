import type { BrowserPlugin } from "@copilotz/copilotz/web";
import usage from "./views/usage/index.tsx";
export const usageWebPlugin: BrowserPlugin = {
  id: "@copilotz/core-usage",
  collections: { usage: { placement: "server" } },
  views: { usage },
  resources: {
    navigation: { usage: { label: "Usage", shows: "usage", value: null } },
  },
};
