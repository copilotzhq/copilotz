/** A chat that isn't there, or isn't yours to see: said plainly, with a way on. */
import type { ReactNode } from "react";
import { Button, EmptyState, Title } from "../../../../../hosts/web/mod.ts";
import { say } from "./words.ts";

export function Missing({ fresh }: { fresh: string }): ReactNode {
  return (
    <section className="chat chat-missing" aria-labelledby="chat-missing-title">
      <Title text={say("notFoundTitle")} />
      <EmptyState
        icon="lock"
        heading="h1"
        id="chat-missing-title"
        title={say("missingTitle")}
        action={
          <Button variant="primary" icon="compose" href={fresh}>
            {say("startNewChat")}
          </Button>
        }
      >
        {say("missingBody")}
      </EmptyState>
    </section>
  );
}
