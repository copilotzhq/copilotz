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
 * form). Every word is the app's (`words`, the `signInPage` resource's: see
 * signin-words.ts): a refusal is said by its code in those words, never in
 * the server's. Signed in, the page goes on as with any sign-in (`landed`).
 */
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { fill, type SignInWords } from "./signin-words.ts";
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

/** A sign-in route asked: what it answers, or its refusal thrown (`offline`: no answer at all). */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  if (!response) throw Object.assign(new Error("offline"), { code: "offline" });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(answer.error ?? response.statusText), { code: answer.code });
  }
  return answer as T;
}

/**
 * A phrase with blanks filled by what's drawn there (an address in bold, a
 * button): `say("We sent it to {email}.", { email: <b>…</b> })`.
 */
export function say(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{name && name in parts ? parts[name] : piece}</Fragment>;
  });
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
  | { name: "signin" }
  | { name: "signup" }
  | { name: "code"; email: string; password: string; from: "signin" | "signup"; first?: true }
  | { name: "forgot" }
  | { name: "reset"; email: string }
  | { name: "invite"; token: string };

type Problem = { field?: "email" | "password" | "code" | "name"; text: string; tone?: "warning" };

/**
 * What a refusal says, in the app's words, by its code: those a step expects
 * (`expected`), else too many tries, no connection, or that something failed.
 */
function problemOf(
  error: unknown,
  words: SignInWords,
  expected: Partial<Record<string, Problem>> = {},
): Problem {
  const { code } = error as Refused;
  const known = code ? expected[code] : undefined;
  if (known) return known;
  if (code === "too_many") return { text: words.tooMany, tone: "warning" };
  if (code === "offline") return { text: words.offline };
  return { text: words.failed };
}

/** A password field: shown or hidden at a click, saying when Caps Lock is on. */
function Password(
  { words, label, value, onChange, autoComplete, hint, error, input, autoFocus }: {
    words: SignInWords;
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
            <Icon name="alert" size={13} /> {words.capsLock}
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
              label={shown ? words.hidePassword : words.showPassword}
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
function lengthHint(words: SignInWords, password: string): ReactNode {
  const long = password.length >= MIN_PASSWORD;
  return (
    <span className={long ? "copilotz-signin-hint copilotz-signin-ok" : "copilotz-signin-hint"}>
      {long ? <Icon name="check" size={13} /> : null}
      {fill(words.atLeast, { min: MIN_PASSWORD })}
    </span>
  );
}

/** The six-digit code: digits only, big and spaced, sent on once all six are in. */
function CodeField(
  { words, value, onChange, error, input }: {
    words: SignInWords;
    value: string;
    onChange(code: string): void;
    error?: string;
    input: RefObject<HTMLInputElement | null>;
  },
): ReactNode {
  return (
    <Field label={words.code} error={error}>
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
          aria-label={words.codeLabel}
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
  { words, signUp, invite, lede, above, below, landed }: {
    /** What it says: the app's words. */
    words: SignInWords;
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
  const tooShort = fill(words.tooShort, { min: MIN_PASSWORD });

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
      refused({ field: "email", text: words.enterEmail });
      return false;
    }
    if (needs.password === "any" && !password) {
      refused({ field: "password", text: words.enterPassword });
      return false;
    }
    if (needs.password === "new" && password.length < MIN_PASSWORD) {
      refused({ field: "password", text: tooShort });
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
      if ((error as Refused).code === "unverified") {
        go({ name: "code", email: typed, password, from: "signin", first: true });
      } else {
        refused(problemOf(error, words, {
          unauthorized: { field: "password", text: words.wrongPassword },
          invalid: { field: "email", text: words.enterEmail },
        }));
      }
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
      refused(problemOf(error, words, {
        invalid: { field: "email", text: words.enterEmail },
        forbidden: { text: words.byInvitation },
        unavailable: { text: words.notSent },
      }));
    }
  };

  const confirm = async (digits = code) => {
    if (screen.name !== "code" || busy) return;
    if (digits.length !== 6) {
      refused({ field: "code", text: words.enterCode });
      return;
    }
    try {
      landed(await send<SignedIn>("/signin/email/verify", { email: screen.email, code: digits }));
    } catch (error) {
      setCode("");
      refused(problemOf(error, words, { invalid: { field: "code", text: words.wrongCode } }));
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
      if ((error as Refused).code === "unverified") {
        restart();
        setSent(words.codeSent);
      } else {
        refused(problemOf(error, words, { unauthorized: { text: words.codeNotSent } }));
      }
    }
  };

  const forgot = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !checked({ email: true })) return;
    try {
      await send("/signin/email/forgot", { email: typed });
      go({ name: "reset", email: typed });
    } catch (error) {
      refused(problemOf(error, words, { invalid: { field: "email", text: words.enterEmail } }));
    }
  };

  const resetCode = async () => {
    if (screen.name !== "reset" || busy || again) return;
    try {
      await send("/signin/email/forgot", { email: screen.email });
      restart();
      setSent(words.codeSent);
    } catch (error) {
      refused(problemOf(error, words));
    }
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (screen.name !== "reset" || busy) return;
    if (code.length !== 6) {
      refused({ field: "code", text: words.enterCode });
      return;
    }
    if (!checked({ password: "new" })) return;
    try {
      landed(
        await send<SignedIn>("/signin/email/reset", { email: screen.email, code, password }),
      );
    } catch (error) {
      refused(problemOf(error, words, { invalid: { field: "code", text: words.wrongCode } }));
    }
  };

  // Arriving by an invitation's link: which address it's for, while it works.
  useEffect(() => {
    if (screen.name !== "invite" || invited) return;
    post<{ email: string }>("/signin/email/invitation", { token: screen.token }).then(
      ({ email }) => setInvited({ email }),
      (error) =>
        setInvited({
          error: problemOf(error, words, { invalid: { text: words.linkExpired } }).text,
        }),
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
      refused(problemOf(error, words, { invalid: { text: words.linkExpired } }));
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
  const sentNotice = sent && !problem
    ? (
      <Notice tone="success" role="status" className="copilotz-signin-error">
        {sent}
      </Notice>
    )
    : null;

  const emailField = (autoFocus: boolean) => (
    <Field label={words.email} error={errorOf("email")}>
      {(control) => (
        <Input
          {...control}
          ref={emailInput}
          size="lg"
          type="email"
          icon="mail"
          value={email}
          onChange={(e) => editEmail(e.target.value)}
          placeholder={words.emailPlaceholder}
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

  const back = (to: Screen, label = words.back) => (
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

  /** An address in a sentence, in bold. */
  const bold = (address: string | undefined) => ({ email: <b>{address}</b> });

  return (
    <>
      {screen.name === "signin"
        ? (
          <>
            <h2>{words.signIn}</h2>
            <p className="copilotz-signin-lede">{lede}</p>
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
                  words={words}
                  label={words.password}
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
                  {words.forgot}
                </Button>
              </div>
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? words.signingInBusy : words.signIn}
              </Button>
            </form>
            {signUp ? switchTo(words.newHere, words.createAccount, { name: "signup" }) : null}
          </>
        )
        : null}

      {screen.name === "signup"
        ? (
          <>
            {back({ name: "signin" })}
            <h2>{words.signUpTitle}</h2>
            <p className="copilotz-signin-lede">{words.signUpLede}</p>
            <form onSubmit={create} noValidate>
              <Field label={words.name} hint={words.nameHint}>
                {(control) => (
                  <Input
                    {...control}
                    size="lg"
                    icon="person"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={words.namePlaceholder}
                    autoComplete="name"
                    maxLength={120}
                    autoFocus
                  />
                )}
              </Field>
              {emailField(false)}
              <Password
                words={words}
                label={words.password}
                value={password}
                onChange={editPassword}
                autoComplete="new-password"
                hint={lengthHint(words, password)}
                error={errorOf("password")}
                input={passwordInput}
              />
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? words.signUpBusy : words.signUp}
              </Button>
            </form>
            {switchTo(words.haveAccount, words.signIn, { name: "signin" })}
          </>
        )
        : null}

      {screen.name === "code"
        ? (
          <>
            {back(
              screen.from === "signup" ? { name: "signup" } : { name: "signin" },
              words.otherEmail,
            )}
            <Badge icon="mail" />
            <h2>{words.codeTitle}</h2>
            <p className="copilotz-signin-lede">
              {screen.first ? <>{words.confirmFirst}{" "}</> : null}
              {say(words.codeLede, bold(screen.email))}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
              noValidate
            >
              <CodeField
                words={words}
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
              {sentNotice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? words.confirmBusy : words.confirm}
              </Button>
            </form>
            <p className="copilotz-signin-switch">
              {say(words.noCode, {
                link: (
                  <Button
                    variant="link"
                    disabled={again > 0 || busy}
                    onClick={() => void newCode()}
                  >
                    {again > 0 ? fill(words.newCodeIn, { seconds: again }) : words.newCode}
                  </Button>
                ),
              })}
            </p>
          </>
        )
        : null}

      {screen.name === "forgot"
        ? (
          <>
            {back({ name: "signin" })}
            <Badge icon="lock" />
            <h2>{words.forgotTitle}</h2>
            <p className="copilotz-signin-lede">{words.forgotLede}</p>
            <form onSubmit={forgot} noValidate>
              {emailField(true)}
              {notice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? words.sending : words.sendCode}
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
            <h2>{words.resetTitle}</h2>
            <p className="copilotz-signin-lede">{say(words.resetLede, bold(screen.email))}</p>
            <form onSubmit={reset} noValidate>
              <CodeField
                words={words}
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
                words={words}
                label={words.newPassword}
                value={password}
                onChange={editPassword}
                autoComplete="new-password"
                hint={lengthHint(words, password)}
                error={errorOf("password")}
                input={passwordInput}
              />
              {notice}
              {sentNotice}
              <Button type="submit" variant="primary" size="lg" loading={busy}>
                {busy ? words.saving : words.reset}
              </Button>
            </form>
            <p className="copilotz-signin-switch">
              {say(words.noResetCode, {
                link: (
                  <Button
                    variant="link"
                    disabled={again > 0 || busy}
                    onClick={() => void resetCode()}
                  >
                    {again > 0 ? fill(words.resetCodeIn, { seconds: again }) : words.resetCode}
                  </Button>
                ),
              })}
            </p>
          </>
        )
        : null}

      {screen.name === "invite"
        ? (
          <>
            <Badge icon="sparkles" />
            <h2>{words.inviteTitle}</h2>
            {!invited
              ? (
                <div className="copilotz-signin-going" role="status">
                  <Spinner variant="dots" size={7} />
                  <p>{words.inviteOpening}</p>
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
                      {words.toSignIn}
                    </Button>
                  </div>
                </>
              )
              : (
                <>
                  <p className="copilotz-signin-lede">
                    {say(words.inviteLede, bold(invited.email))}
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
                      words={words}
                      label={words.password}
                      value={password}
                      onChange={editPassword}
                      autoComplete="new-password"
                      hint={lengthHint(words, password)}
                      error={errorOf("password")}
                      input={passwordInput}
                      autoFocus
                    />
                    {notice}
                    <Button type="submit" variant="primary" size="lg" loading={busy}>
                      {busy ? words.saving : words.invite}
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
