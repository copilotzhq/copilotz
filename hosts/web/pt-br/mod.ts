/**
 * Brazilian Portuguese for the web, out of the box (`copilotz/web/pt-br`): a
 * plugin of the page's whose `words` say every word Copilotz's web front ends
 * show (chat, spaces, the shell, memory, usage, the palette, the toolkit, the
 * host: every key of hosts/web/WORDS.md), and whose `signInPage` says the
 * sign-in page's, with Copilotz's pitch beside the form in Portuguese.
 *
 * ```ts
 * import { ptBR } from "copilotz/web/pt-br";
 * await web({ root, plugins: [ptBR, webShell, chatWeb, spacesWeb, brand] });
 * // server: page: { title: "Exemplo", lang: "pt-BR", code }
 * ```
 *
 * Put it before the app's own plugins: words and the sign-in page merge in
 * order, so what comes after it has the last word (a phrase the app says its
 * own way, its own pitch). The page's `lang` (the server's `page` resource)
 * is what dates, numbers and plurals follow. Not here: the product packages'
 * front ends (`@copilotz/directory`, `@copilotz/team`, `@copilotz/work`, each
 * with its WORDS.md) and what the server says (emailSignIn's messages).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { about } from "./about.ts";
import { chat } from "./chat.ts";
import { host } from "./host.ts";
import { memory } from "./memory.ts";
import { palette } from "./palette.ts";
import { shell } from "./shell.ts";
import { signIn } from "./sign-in.ts";
import { spaces } from "./spaces.ts";
import { toolkit } from "./toolkit.ts";
import { usage } from "./usage.ts";

export const ptBR: Plugin = definePlugin({
  name: "words-pt-br",
  resources: {
    words: { ...chat, ...host, ...memory, ...palette, ...shell, ...spaces, ...toolkit, ...usage },
    signInPage: { words: signIn, about },
  },
});

export default ptBR;
