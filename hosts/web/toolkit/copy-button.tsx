/** Copies text to the clipboard, and says so for a moment. */
import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "copy-button",
  `
.copilotz-copy { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--muted-foreground);
  font-size: 12px; cursor: pointer; transition: background-color .15s, color .15s; }
.copilotz-copy:hover { background: var(--accent); color: var(--accent-foreground); }
.copilotz-copy span:empty { display: none; }
/* Touch screens: a target a finger finds */
@media (pointer: coarse) {
  .copilotz-copy { height: 40px; min-width: 40px; justify-content: center; }
}
`,
);

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      {SHEET}
      <button
        type="button"
        className="copilotz-copy"
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : label}
        onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
      >
        <Icon name={copied ? "check" : "copy"} size={15} />
        <span aria-live="polite">{copied ? "Copied" : ""}</span>
      </button>
    </>
  );
}
