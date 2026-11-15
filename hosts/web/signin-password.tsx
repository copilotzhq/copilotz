/**
 * Signing in with a username and a password (password sign-in's
 * `POST /signin/password`, which `GET /signin/password` says is there): one
 * form, for accounts an admin made, with no sign-up and no reset (an admin
 * sets a new password). The words are the app's (`identifier` is what it
 * calls one: a username, a badge number, a CPF); a refusal is said by its
 * code in those words. Signed in, the page goes on (`landed`).
 */
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Password, post, type SignedIn } from "./signin-email.tsx";
import type { SignInWords } from "./signin-words.ts";
import { Button } from "./toolkit/button.tsx";
import { Field } from "./toolkit/field.tsx";
import { Input } from "./toolkit/input.tsx";
import { Notice } from "./toolkit/notice.tsx";

export function PasswordSignIn(
  { words, primary, focus, landed }: {
    words: SignInWords;
    /** The page's main way in (else one beside another, drawn quieter). */
    primary: boolean;
    /** Whether the cursor starts here. */
    focus?: boolean;
    landed(signed: SignedIn): void;
  },
): ReactNode {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field?: "identifier" | "password"; text: string }>();
  const identifierInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  const refused = (shown: { field?: "identifier" | "password"; text: string }) => {
    setProblem(shown);
    setBusy(false);
    const input = shown.field === "identifier" ? identifierInput : passwordInput;
    requestAnimationFrame(() => input.current?.focus());
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!identifier.trim()) return refused({ field: "identifier", text: words.enterIdentifier });
    if (!password) return refused({ field: "password", text: words.enterPassword });
    setBusy(true);
    setProblem(undefined);
    try {
      landed(await post<SignedIn>("/signin/password", { identifier, password }));
    } catch (error) {
      const { code } = error as { code?: string };
      refused(
        code === "unauthorized"
          ? { field: "password", text: words.wrongIdentifier }
          : code === "invalid"
          ? { field: "identifier", text: words.enterIdentifier }
          : {
            text: code === "too_many"
              ? words.tooMany
              : code === "offline"
              ? words.offline
              : words.failed,
          },
      );
    }
  };

  return (
    <form onSubmit={signIn} noValidate>
      <Field
        label={words.identifier}
        error={problem?.field === "identifier" ? problem.text : undefined}
      >
        {(control) => (
          <Input
            {...control}
            ref={identifierInput}
            size="lg"
            icon="person"
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value);
              if (problem?.field === "identifier") setProblem(undefined);
            }}
            placeholder={words.identifierPlaceholder}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            autoFocus={focus}
          />
        )}
      </Field>
      <Password
        words={words}
        label={words.password}
        value={password}
        onChange={(value) => {
          setPassword(value);
          if (problem?.field === "password") setProblem(undefined);
        }}
        autoComplete="current-password"
        error={problem?.field === "password" ? problem.text : undefined}
        input={passwordInput}
      />
      {problem && !problem.field
        ? (
          <Notice tone="destructive" role="alert" className="copilotz-signin-error">
            {problem.text}
          </Notice>
        )
        : null}
      <Button type="submit" variant={primary ? "primary" : "outline"} size="lg" loading={busy}>
        {busy ? words.signingInBusy : words.signIn}
      </Button>
    </form>
  );
}
