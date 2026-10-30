/**
 * Connected accounts' layout, on the theme's variables: the page's list of
 * providers, each a card (who the account is, beneath), connecting in a
 * dialog of steps, and the quiet line over a chat's composer.
 */
export const STYLE = `
.accounts { display: grid; gap: 14px; }
.accounts-list { list-style: none; display: grid; gap: 12px; margin: 0; padding: 0; }
.accounts-foot { display: flex; align-items: flex-start; gap: 8px; margin: 6px 2px 0; color: var(--muted-foreground);
  font-size: 13px; line-height: 1.5; }
.accounts-foot .copilotz-icon { flex: none; margin-top: 2px; }

.account { overflow: hidden; }
.account-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 14px;
  padding: 18px 18px 16px; }
.account-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: var(--radius-lg);
  background: var(--primary-soft); color: var(--primary-text); }
.account-titles { min-width: 0; }
.account-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0;
  font-family: var(--font-display); font-size: 16.5px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
.account-allows { margin: 3px 0 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.account-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.account-who { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-top: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 45%, var(--card)); }
.account-who-text { flex: 1; min-width: 0; display: grid; gap: 1px; }
.account-label { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.account-facts { color: var(--muted-foreground); font-size: 13px; }
.account-problem { margin: 0 18px 16px; }
.account-skeleton { display: grid; gap: 12px; }
@container copilotz-page (max-width: 560px) {
  .account-head { grid-template-columns: auto minmax(0, 1fr); padding: 16px 16px 14px; }
  .account-actions { grid-column: 1 / -1; justify-content: flex-start; margin-top: 10px; }
  .account-who { padding: 12px 16px; }
  .account-problem { margin: 0 16px 14px; }
}

.accounts-steps { list-style: none; display: grid; gap: 18px; margin: 4px 0 0; padding: 0; }
.accounts-step { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
.accounts-step-number { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--secondary-foreground); font-size: 13px; font-weight: 650;
  transition: background-color .2s, color .2s; }
.accounts-step-done .accounts-step-number { background: var(--success-soft); color: var(--success-text); }
.accounts-step-body { display: grid; gap: 10px; min-width: 0; padding-top: 2px; }
.accounts-step-body > p { margin: 0; line-height: 1.55; }
.accounts-step-body code { font-size: .9em; overflow-wrap: anywhere; }
.accounts-step-later { opacity: .62; transition: opacity .2s; }
.accounts-sign-in { justify-self: start; }
.accounts-say { margin: 0; line-height: 1.55; }
.accounts-quiet { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.accounts-intro { margin: 0 0 18px; }
.accounts-done { display: flex; align-items: center; gap: 14px; padding: 6px 0 2px; }
.accounts-done-icon { display: grid; place-items: center; flex: none; width: 46px; height: 46px;
  border-radius: var(--radius-full); background: var(--success-soft); color: var(--success-text); }
.accounts-done-title { margin: 0; font-size: 16px; font-weight: 650; }
.accounts-done-who { margin: 2px 0 0; color: var(--muted-foreground); font-size: 13.5px; overflow-wrap: anywhere; }
.accounts-done-next { margin: 14px 0 0; line-height: 1.55; }

.accounts-uses { display: flex; justify-content: flex-end; margin: 0 8px -4px; font-size: 12.5px; line-height: 1.4; }
.accounts-uses a { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 9px;
  border-radius: var(--radius-full); color: var(--muted-foreground); text-decoration: none;
  transition: background-color .15s, color .15s; }
.accounts-uses a:hover { background: var(--accent); color: var(--accent-foreground); }
.accounts-uses span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.accounts-uses-plan .copilotz-icon { flex: none; color: var(--primary-text); }
.accounts-uses-reconnect a { color: var(--warning-text); }
`;
