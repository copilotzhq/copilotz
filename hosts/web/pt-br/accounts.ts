/**
 * Your AI's words in Brazilian Portuguese (the accounts page's frame, and connecting an
 * account, in a dialog or in place): the keys `hosts/web/WORDS.md` lists, `accounts.*`.
 */
import type { Words } from "../words.ts";

export const accounts: Words = {
  "accounts.about":
    "Os planos de IA que você paga, onde rodam, e suas próprias chaves de API. Os " +
    "agentes que trabalham para você os usam; mais ninguém pode: nem as pessoas com quem você " +
    "compartilha espaços, nem os agentes delas.",
  "accounts.cancel": "Cancelar",
  "accounts.closeTab": "Pode fechar a aba do login.",
  "accounts.connect": "Conectar",
  "accounts.connectTitle": "Conectar {provider}",
  "accounts.connectedNotice":
    "{provider} está conectado: os agentes que trabalham para você o usam daqui em diante.",
  "accounts.connectedTitle": "{provider} está conectado",
  "accounts.connectsOnPaste": "Conecta assim que você colar.",
  "accounts.continueTo": "Continuar para {provider}",
  "accounts.dismiss": "Dispensar",
  "accounts.done": "Pronto",
  "accounts.elsewhere": "Esse é o endereço de outra página: ele deve começar com {address}",
  "accounts.foot": "Os logins ficam no servidor, nunca mostrados no app nem aos modelos dos " +
    "agentes. Desconectar os encerra no provedor também.",
  "accounts.noClipboard": "Este navegador não deixou a página ler o que você copiou: cole aqui.",
  "accounts.notYet": "Ainda não parece ser ele: copie o endereço inteiro, da barra de endereço",
  "accounts.nothing": "Nada para conectar ainda",
  "accounts.nothingText": "Este app não oferece contas para conectar.",
  "accounts.nowRuns": "Os agentes que trabalham para você agora rodam no seu plano do {provider}.",
  "accounts.nowUses":
    "Os agentes que trabalham para você agora podem usar sua conta do {provider}.",
  "accounts.otherAccounts": "Outras contas",
  "accounts.paste": "Colar",
  "accounts.pasteHere": "Cole aqui",
  "accounts.planOf": "{provider}, plano {plan}",
  "accounts.reconnect": "Reconectar",
  "accounts.reconnectTitle": "Reconectar {provider}",
  "accounts.sentBack": "{provider} pede que você entre e autorize, e depois traz você de volta.",
  "accounts.signInAgain": "Abrir o login de novo",
  "accounts.signInTo": "Entrar no {provider}",
  "accounts.startAgain": "Começar de novo",
  "accounts.startFailed": "Não deu para começar a conectar: {why}",
  "accounts.stepLand":
    "Você vai cair numa página que não carrega, em {address}. É assim mesmo. Copie o endereço inteiro dessa página, da barra de endereço.",
  "accounts.stepSignIn": "Entre no {provider} e autorize o acesso. Abre numa nova aba.",
  "accounts.title": "Sua IA",
  "accounts.tryAgain": "Tentar de novo",
};
