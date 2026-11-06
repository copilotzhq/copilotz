/**
 * Signing in with an email and a password, in the sign-in page's card, by
 * email sign-in's routes (`/signin/email…`, which `GET /signin/email`
 * says are there). Its screens, one at a time:
 *
 * - **Sign in** (email and password; "Forgot your password?"), with what
 *   else the page offers above it (Google's button) and below (by name);
 * - **Create an account** (a name, an email, a password), when the app lets
 *   people make one;
 * - **Check your email:** the six-digit code a sign-up sent (or a sign-in
 *   refused until the address is confirmed), sent on as soon as it's typed
 *   or pasted, with a new one a click away (every 30 seconds);
 * - **Reset your password:** an email, then its code and a new password;
 * - **Choose your password:** arriving by an invitation's link
 *   (`/#email-invite=<token>`), for the address it shows.
 *
 * Each screen puts the cursor where typing starts, Enter sends it, and a
 * refusal says what to do next beside what it's about (the field, or the
 * form). Signed in, the page goes on as with any sign-in (`landed`).
 */
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./toolkit/button.tsx";
import { Field } from "./toolkit/field.tsx";
import { Icon, type IconName } from "./toolkit/icon.tsx";
import { IconButton } from "./toolkit/icon-button.tsx";
import { Input } from "./toolkit/input.tsx";
import { Notice } from "./toolkit/notice.tsx";
import { Spinner } from "./toolkit/spinner.tsx";

/** What signing in answers: who, and (with many orgs) the org they land in. */
export type SignedIn = { person: string; org?: { name: string; kind: "personal" | "team" } };

/** A refusal as a sign-in route said it: its words, and its code (`unverified`, `too_many`…). */
type Refused = Error & { code?: string };

/** A sign-in route asked: what it answers, or its refusal thrown. */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  if (!response) {
    throw Object.assign(new Error("Couldn't reach the server. Check your connection."), {
      code: "offline",
    });
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(answer.error ?? response.statusText), { code: answer.code });
  }
  return answer as T;
}

/** Where in the page's address an invitation's link carries its token (email sign-in's). */
const INVITE = "email-invite";

/** An invitation's token, when the page was opened by its link. */
export function inviteOf(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get(INVITE);
  return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : undefined;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
/** How long before another code may be asked for (seconds). */
const AGAIN = 30;

type Screen =
  | { name: "signin"; note?: string }
  | { name: "signup" }
  | { name: "code"; email: string; password: string; from: "signin" | "signup"; note?: string }
  | { name: "forgot" }
  | { name: "reset"; email: string }
  | { name: "invite"; token: string };

type Problem = { field?: "email" | "password" | "code" | "name"; text: string; tone?: "warning" };

/** What a refusal says, and beside what: the field it's about, else the form. */
function problemOf(error: unknown, field?: Problem["field"]): Problem {
  const { message, code } = error as Refused;
  if (code === "too_many") return { text: message, tone: "warning" };
  if (code === "invalid" && field) return { field, text: message };
  return { text: message || "Something went wrong. Try again." };
}

/** A password field: shown or hidden at a click, saying when Caps Lock is on. */
function Password(
  { label, value, onChange, autoComplete, hint, error, input, autoFocus }: {
    label: string;
    value: string;
    onChange(value: string): void;
    autoComplete: "current-password" | "new-password";
    hint?: ReactNode;
    error?: string;
    input?: RefObject<HTMLInputElement | null>;
    autoFocus?: boolean;
  },
): ReactNode {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const capsOf = (event: KeyboardEvent<HTMLInputElement>) =>
    setCaps(event.getModifierState?.("CapsLock") ?? false);
  return (
    <Field
      label={label}
      error={error}
      hint={caps
        ? (
          <span className="copilotz-signin-hint copilotz-signin-caps">
            <Icon name="alert" size={13} /> Caps Lock is on
          </span>
        )
        : hint}
    >
      {(control) => (
        <Input
          {...control}
          ref={input}
          size="lg"
          type={shown ? "text" : "password"}
          icon="lock"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyUp={capsOf}
          onKeyDown={capsOf}
          onBlur={() => setCaps(false)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={1024}
          autoFocus={autoFocus}
          end={
            <IconButton
              icon={shown ? "eye-off" : "eye"}
              label={shown ? "Hide password" : "Show password"}
              tooltip={false}
              size="sm"
              aria-pressed={shown}
              onClick={() => setShown(!shown)}
            />
          }
        />
      )}
    </Field>
  );
}

/** A new password's hint: how long it must be, ticked once it is. */
function lengthHint(password: string): ReactNode {
  const long = password.length >= MIN_PASSWORD;
  return (
    <span className={long ? "copilotz-signin-hint copilotz-signin-ok" : "copilotz-signin-hint"}>
      {long ? <Icon name="check" size={13} /> : null}
      At least {MIN_PASSWORD} characters
    </span>
  );
}

/** The six-digit code: digits only, big and spaced, sent on once all six are in. */
function CodeField(
  { value, onChange, error, input }: {
    value: string;
    onChange(code: string): void;
    error?: string;
    input: RefObject<HTMLInputElement | null>;
  },
): ReactNode {
  return (
    <Field label="Code" error={error}>
      {(control) => (
        <Input
          {...control}
          ref={input}
          size="lg"
          className="copilotz-signin-code"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          placeholder="000000"
          aria-label="Six-digit code"
          autoFocus
        />
      )}
    </Field>
  );
}

/** A countdown to when another code may be asked for: seconds left (0: now). */
function useAgain(): [number, () => void] {
  const [until, setUntil] = useState(() => Date.now() + AGAIN * 1000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) return;
    const timer = setTimeout(() => setNow(Date.now()), 250);
    return () => clearTimeout(timer);
  }, [now, until]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return [left, () => {
    setUntil(Date.now() + AGAIN * 1000);
    setNow(Date.now());
  }];
}

/** A badge over a screen's heading: what it's about at a glance. */
const Badge = ({ icon }: { icon: IconName }) => (
  <span className="copilotz-signin-badge" aria-hidden>
    <Icon name={icon} size={20} />
  </span>
);

export function EmailSignIn(
  { signUp, invite, lede, above, below, landed }: {
    /** Whether people make accounts themselves. */
    signUp: boolean;
    /** An invitation's token, when the page was opened by its link. */
    invite?: string;
    /** What the first screen says under its heading. */
    lede: string;
    /** On the first screen, above the form: other ways in (Google's button). */
    above?: ReactNode;
    /** On the first screen, below it: signing in by name, on this machine. */
    below?: ReactNode;
    landed(signed: SignedIn): void;
  },
): ReactNode {
  const [screen, setScreen] = useState<Screen>(
    invite ? { name: "invite", token: invite } : { name: "signin" },
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const [sent, setSent] = useState<string>();
  const [again, restart] = useAgain();
  const [invited, setInvited] = useState<{ email?: string; error?: string }>();
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const typed = email.trim().toLowerCase();

  /** A field typed into: what was said about it goes, as it's being fixed. */
  const edited = <T,>(field: Problem["field"], set: (value: T) => void) => (value: T) => {
    set(value);
    if (problem?.field === field) setProblem(undefined);
  };
  const editEmail = edited("email", setEmail);
  const editPassword = edited("password", setPassword);

  /** To another screen: what was said on this one goes; the email stays. */
  const go = (next: Screen) => {
    setProblem(undefined);
    setSent(undefined);
    setCode("");
    if (next.name === "signin" || next.name === "signup") setPassword("");
    if (next.name === "code" || next.name === "reset") restart();
    setScreen(next);
  };

  /** A refusal shown, and the cursor put where it's about. */
  const refused = (shown: Problem) => {
    setProblem(shown);
    setBusy(false);
    const input = shown.field === "email"
      ? emailInput
      : shown.field === "password"
      ? passwordInput
      : shown.field === "code"
      ? codeInput
      : undefined;
    requestAnimationFrame(() => input?.current?.focus());
  };

  /** Checked here before it's sent: an address that's one, a password long enough. */
  const checked = (needs: { email?: boolean; password?: "any" | "new" }): boolean => {
    if (needs.email && !EMAIL.test(typed)) {
      refused({ field: "email", text: "Enter your email address, such as ana@example.com." });
      return false;
    }
    if (needs.password === "any" && !password) {
      refused({ field: "password", text: "Enter your password." });
      return false;
    }
    if (needs.password === "new" && password.length < MIN_PASSWORD) {
      refused({ field: "password", text: `Use at least ${MIN_PASSWORD} characters.` });
      return false;
    }
    return true;
  };

  /** Sends a step; signed in, the page goes on. */
  const send = async <T,>(path: string, body: unknown): Promise<T> => {
    setBusy(true);
    setProblem(undefined);
    try {
      return await post<T>(path, body);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !checked({ email: true, password: "any" })) return;
    try {
      landed(await send<SignedIn>("/signin/email", { email: typed, password }));
    } catch (error) {
      const { code: why, message } = error as Refused;
      if (why === "unverified") {
        go({ name: "code", email: typed, password, from: "signin", note: message });
      } else if (why === "unauthorized") {
        refused({ field: "password", text: message });
      } else refused(problemOf(error, "email"));
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !checked({ email: true, password: "new" })) return;
    try {
      await send("/signin/email/sign-up", {
        email: typed,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      go({ name: "code", email: typed, password, from: "signup" });
    } catch (error) {
      const said = problemOf(error);
      refused(/password/i.test(said.text) ? { ...said, field: "password" } : said);
    }
  };

  const confirm = async (digits = code) => {
    if (screen.name !== "code" || busy) return;
    if (digits.length !== 6) {
      refused({ field: "code", text: "Enter the six digits from the email." });
      return;
    }
    try {
      landed(await send<SignedIn>("/signin/email/verify", { email: screen.email, code: digits }));
    } catch (error) {
      setCode("");
      refused(problemOf(error, "code"));
    }
  };

  /** Another code for a sign-up: signing in with its password sends one (`unverified`). */
  const newCode = async () => {
    if (screen.name !== "code" || busy || again) return;
    try {
      landed(
        await send<SignedIn>("/signin/email", { email: screen.email, password: screen.password }),
      );
    } catch (error) {
      const { code: why, message } = error as Refused;
      if (why === "unverified") {
        restart();
        setSent(message);
      } else if (why === "unauthorized") {
        refused({ text: "We couldn't send a new code. If you have an account, sign in instead." });
      } else refused(problemOf(error));
    }
  };

  const forgot = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !checked({ email: true })) return;
    try {
      await send("/signin/email/forgot", { email: typed });
      go({ name: "reset", email: typed });
    } catch (error) {
      refused(problemOf(error, "email"));
    }
  };

  const resetCode = async () => {
    if (screen.name !== "reset" || busy || again) return;
    try {
      await send("/signin/email/forgot", { email: screen.email });
      restart();
      setSent("We've sent a new code.");
    } catch (error) {
      refused(problemOf(error));
    }
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (screen.name !== "reset" || busy) return;
    if (code.length !== 6) {
      refused({ field: "code", text: "Enter the six digits from the email." });
      return;
    }
    if (!checked({ password: "new" })) return;
    try {
      landed(
        await send<SignedIn>("/signin/email/reset", { email: screen.email, code, password }),
      );
    } catch (error) {
      const said = problemOf(error, "code");
      refused(/password/i.test(said.text) ? { ...said, field: "password" } : said);
    }
  };

  // Arriving by an invitation's link: which address it's for, while it works.
  useEffect(() => {
    if (screen.name !== "invite" || invited) return;
    post<{ email: string }>("/signin/email/invitation", { token: screen.token }).then(
      ({ email }) => setInvited({ email }),
      (error) => setInvited({ error: (error as Error).message }),
    );
  }, [screen]);

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    if (screen.name !== "invite" || busy || !checked({ password: "new" })) return;
    try {
      const signed = await send<SignedIn>("/signin/email/accept", {
        token: screen.token,
        password,
      });
      // The link is spent: the page starts over without it.
      history.replaceState(null, "", location.pathname + location.search);
      landed(signed);
    } catch (error) {
      refused(problemOf(error, "password"));
    }
  };

  /** Leaves an invitation's screen for signing in: the link goes from the address too. */
  const leaveInvite = () => {
    history.replaceState(null, "", location.pathname + location.search);
    go({ name: "signin" });
  };

  const first = screen.name === "signin";
  const errorOf = (field: Problem["field"]) =>
    problem && problem.field === field ? problem.text : undefined;
  const notice = problem && !problem.field
    ? (
      <Notice
        tone={problem.tone ?? "destructive"}
        role="alert"
        className="copilotz-signin-error"
      >
        {problem.text}
      </Notice>
    )
    : null;

  const emailField = (autoFocus: boolean) => (
    <Field label="Email" error={errorOf("email")}>
      {(control) => (
        <Input
          {...control}
          ref={emailInput}
          size="lg"
          type="email"
          icon="mail"
          value={email}
          onChange={(e) => editEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete={screen.name === "signup" ? "email" : "username"}
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          autoFocus={autoFocus}
        />
      )}
    </Field>
  );

  const back = (to: Screen, label = "Back") => (
    <Button
      variant="link"
      icon="chevron-left"
      className="copilotz-signin-back"
      onClick={() => go(to)}
    >
      {label}
    </Button>
  );

  const switchTo = (question: string, label: string, to: Screen) => (
    <p className="copilotz-signin-switch">
      {question} <Button variant="link" onClick={() => go(to)}>{label}</Button>
    </p>
  );

  return (
    <>
      {screen.name === "signin"
        ? (
          <>
            <h2>Sign in</h2>
            <p className="copilotz-signin-lede">{screen.note ?? lede}</p>
          </>
        )
        : null}
      {/* Kept while other screens show, so Google's button needn't be drawn again. */}
      <div hidden={!first}>{above}</div>

      {screen.name === "signin"
        ? (
          <>
            <form onSubmit={signIn} noValidate>
              {emailField(true)}
              <div className="copilotz-signin-stack">
                <Password
                  label="Password"
                  value={password}
                  onChange={editPassword}
                  autoComplete="current-password"
                  error={errorOf("password")}
                  input={passwordInput}
                />
                <Button
                  variant="link"
                  className="copilotz-signin-aside"
                  onClick={() => go({ name: "forgot" })}
                >
                  Forgot your password?
                </Button>
              </div>
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
            {signUp ? switchTo("New here?", "Create an account", { name: "signup" }) : null}
          </>
        )
        : null}

      {screen.name === "signup"
        ? (
          <>
            {back({ name: "signin" })}
            <h2>Create your account</h2>
            <p className="copilotz-signin-lede">
              We'll email you a code to confirm your address.
            </p>
            <form onSubmit={create} noValidate>
              <Field label="Name" hint="Optional: what people here see.">
                {(control) => (
                  <Input
                    {...control}
                    size="lg"
                    icon="person"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ana Lima"
                    autoComplete="name"
                    maxLength={120}
                    autoFocus
                  />
                )}
              </Field>
              {emailField(false)}
              <Password
                label="Password"
                value={password}
                onChange={editPassword}
                autoComplete="new-password"
                hint={lengthHint(password)}
                error={errorOf("password")}
                input={passwordInput}
              />
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? "Creating your account…" : "Create account"}
              </Button>
            </form>
            {switchTo("Already have an account?", "Sign in", { name: "signin" })}
          </>
        )
        : null}

      {screen.name === "code"
        ? (
          <>
            {back(
              screen.from === "signup" ? { name: "signup" } : { name: "signin" },
              "Use another email",
            )}
            <Badge icon="mail" />
            <h2>Check your email</h2>
            <p className="copilotz-signin-lede">
              {screen.note ? <>{screen.note.replace(/:.*$/, ".")}</> : null}
              We sent a 6-digit code to <b>{screen.email}</b>. Enter it to confirm it's yours.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
              noValidate
            >
              <CodeField
                value={code}
                onChange={(digits) => {
                  setCode(digits);
                  if (problem?.field === "code") setProblem(undefined);
                  if (digits.length === 6) void confirm(digits);
                }}
                error={errorOf("code")}
                input={codeInput}
              />
              {notice}
              {sent && !problem
                ? (
                  <Notice tone="success" role="status" className="copilotz-signin-error">
                    {sent}
                  </Notice>
                )
                : null}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? "Confirming…" : "Confirm"}
              </Button>
            </form>
            <p className="copilotz-signin-switch">
              Didn't get it? Check your spam folder, or{" "}
              <Button variant="link" disabled={again > 0 || busy} onClick={() => void newCode()}>
                {again > 0 ? `send a new code in ${again}s` : "send a new code"}
              </Button>
            </p>
          </>
        )
        : null}

      {screen.name === "forgot"
        ? (
          <>
            {back({ name: "signin" })}
            <Badge icon="lock" />
            <h2>Reset your password</h2>
            <p className="copilotz-signin-lede">
              Enter your account's email, and we'll send you a code to choose a new password.
            </p>
            <form onSubmit={forgot} noValidate>
              {emailField(true)}
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? "Sending…" : "Send code"}
              </Button>
            </form>
          </>
        )
        : null}

      {screen.name === "reset"
        ? (
          <>
            {back({ name: "forgot" })}
            <Badge icon="mail" />
            <h2>Choose a new password</h2>
            <p className="copilotz-signin-lede">
              If <b>{screen.email}</b> has an account, we've sent it a 6-digit code.
            </p>
            <form onSubmit={reset} noValidate>
              <CodeField
                value={code}
                onChange={(digits) => {
                  setCode(digits);
                  if (problem?.field === "code") setProblem(undefined);
                  // All six in: on to the new password at once (typed or pasted).
                  if (digits.length === 6) passwordInput.current?.focus();
                }}
                error={errorOf("code")}
                input={codeInput}
              />
              <Password
                label="New password"
                value={password}
                onChange={editPassword}
                autoComplete="new-password"
                hint={lengthHint(password)}
                error={errorOf("password")}
                input={passwordInput}
              />
              {notice}
              {sent && !problem
                ? (
                  <Notice tone="success" role="status" className="copilotz-signin-error">
                    {sent}
                  </Notice>
                )
                : null}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? "Saving…" : "Set password and sign in"}
              </Button>
            </form>
            <p className="copilotz-signin-switch">
              Didn't get it?{" "}
              <Button variant="link" disabled={again > 0 || busy} onClick={() => void resetCode()}>
                {again > 0 ? `Send a new code in ${again}s` : "Send a new code"}
              </Button>
            </p>
          </>
        )
        : null}

      {screen.name === "invite"
        ? (
          <>
            <Badge icon="sparkles" />
            <h2>Choose your password</h2>
            {!invited
              ? (
                <div className="copilotz-signin-going" role="status">
                  <Spinner variant="dots" size={7} />
                  <p>Opening your invitation</p>
                </div>
              )
              : invited.error
              ? (
                <>
                  <Notice tone="warning" className="copilotz-signin-error">
                    {invited.error}
                  </Notice>
                  <div className="copilotz-signin-actions">
                    <Button variant="primary" size="lg" onClick={leaveInvite}>
                      Go to sign in
                    </Button>
                  </div>
                </>
              )
              : (
                <>
                  <p className="copilotz-signin-lede">
                    Welcome! Set a password for <b>{invited.email}</b>, and you're in.
                  </p>
                  <form onSubmit={accept} noValidate>
                    {/* For password managers: the account this password is for. */}
                    <input
                      type="email"
                      name="username"
                      autoComplete="username"
                      value={invited.email}
                      readOnly
                      hidden
                    />
                    <Password
                      label="Password"
                      value={password}
                      onChange={editPassword}
                      autoComplete="new-password"
                      hint={lengthHint(password)}
                      error={errorOf("password")}
                      input={passwordInput}
                      autoFocus
                    />
                    {notice}
                    <Button type="submit" variant="primary" size="lg" loading={busy}>
                      {busy ? "Saving…" : "Set password and continue"}
                    </Button>
                  </form>
                </>
              )}
          </>
        )
        : null}

      <div hidden={!first}>{below}</div>
    </>
  );
}
