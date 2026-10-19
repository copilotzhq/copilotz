import type { ViewContext } from "@copilotz/copilotz/views";
import type { ReactNode } from "react";
export type Row = Readonly<Record<string, unknown>>;
export type Dashboard = Readonly<{
  plans: readonly Row[];
  evidence: readonly Row[];
  connection: string;
  notice: string;
  busy: boolean;
  runId: string | null;
  resets: number;
  packageLabel: string;
}>;
export type ReactViewContext = ViewContext<ReactNode>;
