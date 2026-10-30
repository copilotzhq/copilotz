/**
 * Signing in, before anyone is connected: with Google, or by name on this
 * machine when the server allows it (`dev`). Either sets the session cookie;
 * the page then starts over, connected, where the server lands them (with
 * many orgs, the one they were in last; their own the first time), with a
 * word on where they're going while it does. Beside the form, what the app
 * is: agents that work with you, spaces for you and your team, and every
 * org you belong to behind one sign-in. Drawn with the toolkit, in the
 * app's theme; on a phone, one column.
 */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./toolkit/button.tsx";
import { Card } from "./toolkit/card.tsx";
import { Field } from "./toolkit/field.tsx";
import { Icon, type IconName } from "./toolkit/icon.tsx";
import { Input } from "./toolkit/input.tsx";
import { Logo } from "./toolkit/logo.tsx";
import { Notice } from "./toolkit/notice.tsx";
import { Spinner } from "./toolkit/spinner.tsx";

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
 * The sign-in page's layout: its own CSS, as a front end's is. Behind it, a
 * fine grid that fades out from the middle, under a glow of the focus
 * colour: Copilotz's, in any theme's colours. What the app is sits beside
 * the form, and over it on a phone.
 */
const STYLE = `
.copilotz-signin { position: relative; isolation: isolate; flex: 1 0 auto; display: grid; width: 100%;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; align-content: center; gap: 48px;
  max-width: 1080px; margin: 0 auto; padding: 48px 32px; }
.copilotz-signin-page { height: 100%; overflow: auto; display: flex; flex-direction: column;
  background:
    radial-gradient(900px 520px at 72% -10%, color-mix(in oklab, var(--ring) 15%, transparent), transparent 70%),
    radial-gradient(700px 480px at 0% 110%, color-mix(in oklab, var(--primary) 7%, transparent), transparent 70%),
    var(--background); }
.copilotz-signin-page::before { content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, color-mix(in oklab, var(--foreground) 6%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in oklab, var(--foreground) 6%, transparent) 1px, transparent 1px);
  background-size: 34px 34px; background-position: 50% 0;
  mask-image: radial-gradient(ellipse 70% 62% at 60% 40%, var(--foreground) 25%, transparent 78%); }
.copilotz-signin > * { position: relative; z-index: 1; }
.copilotz-signin-about { display: grid; gap: 26px; align-content: center; }
.copilotz-signin-brand { display: flex; color: var(--foreground); }
.copilotz-signin-about h1 { margin: 0; max-width: 460px; font-family: var(--font-display); font-size: 40px;
  font-weight: 700; line-height: 1.1; letter-spacing: -.035em; }
.copilotz-signin-about h1 span { color: var(--muted-foreground); }
.copilotz-signin-points { list-style: none; display: grid; gap: 18px; margin: 4px 0 0; padding: 0; max-width: 440px; }
.copilotz-signin-points li { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; align-items: start; }
.copilotz-signin-point-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-lg);
  border: 1px solid var(--border); background: var(--card); color: var(--primary-text); box-shadow: var(--shadow-sm); }
.copilotz-signin-points b { display: block; margin: 1px 0 2px; font-size: 14.5px; font-weight: 650; }
.copilotz-signin-points p { margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.5; }
.copilotz-signin-card { justify-self: end; width: 100%; max-width: 420px; padding: 34px 32px 26px;
  border-radius: var(--radius-3xl); box-shadow: var(--shadow-lg); }
.copilotz-signin-card h2 { margin: 0 0 6px; font-family: var(--font-display); font-size: 24px; font-weight: 700;
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
.copilotz-signin-going { display: grid; justify-items: center; gap: 10px; padding: 26px 0 10px; text-align: center; }
.copilotz-signin-going p { margin: 0; color: var(--muted-foreground); }
.copilotz-signin-going b { display: block; color: var(--foreground); font-family: var(--font-display); font-size: 20px;
  font-weight: 680; letter-spacing: -.02em; }
@media (max-width: 880px) {
  .copilotz-signin { grid-template-columns: minmax(0, 1fr); gap: 28px; max-width: 460px; padding: 32px 16px 40px;
    align-content: start; }
  .copilotz-signin-about { gap: 18px; }
  .copilotz-signin-about h1 { font-size: 30px; }
  .copilotz-signin-points { gap: 12px; }
  .copilotz-signin-points p { display: none; }
  .copilotz-signin-points li { grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 12px; }
  .copilotz-signin-point-icon { width: 30px; height: 30px; border-radius: var(--radius-md); }
  .copilotz-signin-points b { margin: 0; font-size: 14px; font-weight: 600; }
  .copilotz-signin-card { justify-self: stretch; max-width: none; padding: 26px 20px 20px; border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-md); }
}
`;

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error ?? response.statusText);
  return answer as T;
};

/** What signing in answers: who, and (with many orgs) the org they land in. */
type SignedIn = { person: string; org?: { name: string; kind: "personal" | "team" } };

/** A name the server takes for signing in by name, or an email (a person with that email). */
const NAME = /^[a-z0-9._-]{1,40}$|^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,64}$/;

/** The app's name: the title the page came with. */
const app = globalThis.document?.title || "Copilotz";

const POINTS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "sparkles",
    title: "Agents that work with you",
    text:
      "In your conversations, on your computer, remembering what matters, and asking before anything they can't undo.",
  },
  {
    icon: "users",
    title: "Spaces for you and your team",
    text: "A Personal space that's yours alone, and shared spaces you invite people to.",
  },
  {
    icon: "building",
    title: "Every organization, one sign-in",
    text:
      "Your own, and your teams': switch between them in a click. Invitations wait for you here.",
  },
];

export function SignIn({ config }: { config: Config }): ReactNode {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [going, setGoing] = useState<SignedIn["org"] | null>();
  const button = useRef<HTMLDivElement>(null);
  const typed = name.trim().toLowerCase();
  const invalid = typed !== "" && !NAME.test(typed);

  /** Signed in: where they land, said a moment, then the page starts over there. */
  const landed = (signed: SignedIn) => {
    setGoing(signed.org ?? null);
    setTimeout(() => location.reload(), signed.org ? 450 : 0);
  };

  useEffect(() => {
    if (!config.google || !button.current) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => {
      google.accounts.id.initialize({
        client_id: config.google!.clientId,
        callback: ({ credential }) =>
          void post<SignedIn>("/signin/google", { idToken: credential }).then(
            landed,
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
      landed(await post<SignedIn>("/signin/dev", { name: typed }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="copilotz-signin-page">
      <main className="copilotz-signin">
        <style href="copilotz-signin" precedence="copilotz">{STYLE}</style>
        <section className="copilotz-signin-about" aria-labelledby="copilotz-signin-title">
          <div className="copilotz-signin-brand">
            <Logo variant="full" name={app} size={40} />
          </div>
          <h1 id="copilotz-signin-title">
            Your agents, <span>with you and your team.</span>
          </h1>
          <ul className="copilotz-signin-points">
            {POINTS.map((point) => (
              <li key={point.title}>
                <span className="copilotz-signin-point-icon">
                  <Icon name={point.icon} size={17} />
                </span>
                <span>
                  <b>{point.title}</b>
                  <p>{point.text}</p>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <Card className="copilotz-signin-card" padding="none">
          {going !== undefined
            ? (
              <div className="copilotz-signin-going" role="status">
                <Spinner variant="dots" size={7} />
                <p>
                  {going ? "Opening" : "Signing you in"}
                  {going
                    ? <b>{going.kind === "personal" ? "your Personal org" : going.name}</b>
                    : null}
                </p>
              </div>
            )
            : (
              <>
                <h2>Sign in</h2>
                <p className="copilotz-signin-lede">
                  {config.google && config.dev
                    ? "With Google, or by name on this machine."
                    : config.google
                    ? "With your Google account."
                    : "By name, on this machine."}
                </p>
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
              </>
            )}
        </Card>
      </main>
    </div>
  );
}
