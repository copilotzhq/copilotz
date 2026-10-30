/// <reference lib="dom" />
/**
 * Signing in, before anyone is connected: with Google, or by name on this
 * machine when the server allows it (`dev`). Either sets the session cookie;
 * the page then starts over, connected. Drawn with the toolkit, in the
 * app's theme.
 */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./toolkit/button.tsx";
import { Card } from "./toolkit/card.tsx";
import { Field } from "./toolkit/field.tsx";
import { Icon } from "./toolkit/icon.tsx";
import { Input } from "./toolkit/input.tsx";
import { Logo } from "./toolkit/logo.tsx";
import { Notice } from "./toolkit/notice.tsx";

type Config = { google: { clientId: string } | null; dev: boolean };

declare const google: {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback(r: { credential: string }): void }): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
    };
  };
};

/**
 * The sign-in page's layout: its own CSS, as a front end's is. Behind the
 * card, a fine grid that fades out from the middle, under a glow of the focus
 * colour: Copilotz's, in any theme's colours.
 */
const STYLE = `
.copilotz-signin { position: relative; isolation: isolate; min-height: 100%; display: grid; place-items: center;
  padding: 32px 16px;
  background:
    radial-gradient(1000px 520px at 50% -14%, color-mix(in oklab, var(--ring) 16%, transparent), transparent 70%),
    var(--background); }
.copilotz-signin::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    linear-gradient(to right, color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 7%, transparent) 1px, transparent 1px);
  background-size: 34px 34px; background-position: 50% 0;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 42%, var(--foreground) 30%, transparent 78%); }
.copilotz-signin-card { width: 100%; max-width: 400px; padding: 34px 32px 28px; border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-md); }
.copilotz-signin-brand { display: flex; color: var(--card-foreground); }
.copilotz-signin h1 { margin: 30px 0 6px; font-family: var(--font-display); font-size: 27px; font-weight: 700;
  line-height: 1.2; letter-spacing: -.025em; }
.copilotz-signin-lede { margin: 0 0 24px; color: var(--muted-foreground); }
.copilotz-signin-google { display: flex; justify-content: center; min-height: 44px; }
.copilotz-signin-or { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--muted-foreground);
  font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.copilotz-signin-or::before, .copilotz-signin-or::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
.copilotz-signin form { display: grid; gap: 16px; }
.copilotz-signin form .copilotz-button { width: 100%; }
.copilotz-signin-error { margin-top: 16px; }
.copilotz-signin-note { display: flex; gap: 8px; align-items: flex-start; margin: 22px 0 0; padding-top: 16px;
  border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted-foreground); }
@media (max-width: 480px) {
  .copilotz-signin-card { padding: 28px 20px 22px; border-radius: var(--radius-2xl); }
}
`;

const post = async (path: string, body: unknown) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
};

/** A name the server takes for signing in by name, or an email (a person with that email). */
const NAME = /^[a-z0-9._-]{1,40}$|^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,64}$/;

/** The app's name: the title the page came with. */
const app = globalThis.document?.title || "Copilotz";

export function SignIn({ config }: { config: Config }): ReactNode {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLDivElement>(null);
  const typed = name.trim().toLowerCase();
  const invalid = typed !== "" && !NAME.test(typed);

  useEffect(() => {
    if (!config.google || !button.current) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => {
      google.accounts.id.initialize({
        client_id: config.google!.clientId,
        callback: ({ credential }) =>
          void post("/signin/google", { idToken: credential }).then(
            () => location.reload(),
            (e) => setError(e.message),
          ),
      });
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      google.accounts.id.renderButton(button.current!, {
        theme: dark ? "filled_black" : "outline",
        size: "large",
        shape: "pill",
        width: 336,
      });
    };
    document.head.append(script);
  }, []);

  const dev = async (event: FormEvent) => {
    event.preventDefault();
    if (!typed || invalid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await post("/signin/dev", { name: typed });
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="copilotz-signin">
      <style href="copilotz-signin" precedence="copilotz">{STYLE}</style>
      <Card className="copilotz-signin-card" padding="none">
        <div className="copilotz-signin-brand">
          <Logo variant="full" name={app} size={44} />
        </div>
        <h1>Welcome</h1>
        <p className="copilotz-signin-lede">Sign in to talk with your agents.</p>
        {config.google ? <div ref={button} className="copilotz-signin-google" /> : null}
        {config.google && config.dev ? <div className="copilotz-signin-or">or</div> : null}
        {config.dev
          ? (
            <form onSubmit={dev} noValidate>
              <Field
                label="Your name or email"
                hint="Anyone you name here is a person in this app; with an email, invitations to it reach you."
                error={invalid
                  ? "Use letters, digits, dots, dashes or underscores, or an email."
                  : undefined}
              >
                {(control) => (
                  <Input
                    {...control}
                    size="lg"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. ana, or ana@example.com"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={129}
                    autoFocus
                  />
                )}
              </Field>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={busy}
                disabled={!typed || invalid}
              >
                {busy ? "Signing in…" : "Continue"}
              </Button>
            </form>
          )
          : null}
        {!config.google && !config.dev
          ? <p className="copilotz-signin-lede">No way to sign in is configured.</p>
          : null}
        {error
          ? (
            <Notice tone="destructive" role="alert" className="copilotz-signin-error">
              {error}
            </Notice>
          )
          : null}
        {config.dev
          ? (
            <p className="copilotz-signin-note">
              <Icon name="lock" size={15} />
              Signing in by name works on this machine only, for trying things out.
            </p>
          )
          : null}
      </Card>
    </main>
  );
}
