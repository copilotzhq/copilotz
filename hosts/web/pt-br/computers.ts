/**
 * Computers' words in Brazilian Portuguese (a person's plans on their own computers): the keys
 * `hosts/web/WORDS.md` lists, `computers.*`.
 */
import type { Words } from "../words.ts";

export const computers: Words = {
  "computers.anotherComputer": "Outro computador",
  "computers.antigravityAbout":
    "Seus agentes rodam no seu plano do Google AI, pelo Antigravity no seu computador.",
  "computers.antigravityCli": "Antigravity",
  "computers.antigravityPlan": "plano do Google AI",
  "computers.antigravityTitle": "Plano do Google AI, pelo Antigravity",
  "computers.askMeFirst": "Perguntar a mim antes em {spaces}",
  "computers.cancel": "Cancelar",
  "computers.checkAgain": "Verificar de novo",
  "computers.checkFailed": "Não deu para verificar seus computadores: {why}",
  "computers.checkedAt": "verificado por último {time}",
  "computers.checking": "Verificando seus computadores…",
  "computers.claudeAbout":
    "Seus agentes rodam no seu plano do Claude, pelo Claude Code no seu computador.",
  "computers.claudeCli": "Claude Code",
  "computers.claudePlan": "plano do Claude",
  "computers.claudeTitle": "Plano do Claude",
  "computers.close": "Fechar",
  "computers.codeHint": "Se a página mostrar um código depois que você entrar, cole aqui.",
  "computers.codeLabel": "O código da página de login",
  "computers.codePlaceholder": "Cole o código",
  "computers.codeSent": "Código enviado: finalizando…",
  "computers.codexAbout":
    "Seus agentes rodam no seu plano do ChatGPT, pelo Codex no seu computador.",
  "computers.codexCli": "Codex",
  "computers.codexPlan": "plano do ChatGPT",
  "computers.codexTitle": "Plano do ChatGPT, pelo Codex",
  "computers.connectComputer": "Conectar um computador",
  "computers.copyCode": "Copiar o código",
  "computers.done": "Pronto",
  "computers.doneAs": "Conectado como {account}",
  "computers.doneNext":
    "Seus agentes rodam nele a partir de agora, em todas as conversas e espaços daqui.",
  "computers.doneOn": "Em {computer}, pelo {cli}",
  "computers.doneTitle": "Seu {plan} está conectado",
  "computers.failedEnded": "Ele parou sem entrar. Tente de novo, ou leia abaixo o que ele disse.",
  "computers.failedStart": "Não deu para entrar: {why}",
  "computers.failedTitle": "O {cli} não entrou",
  "computers.gotCode": "A página deu um código?",
  "computers.hideInstall": "Ocultar",
  "computers.howToFix": "Como usar",
  "computers.howToInstall": "Como instalar",
  "computers.installAnywhere": "Num terminal nesse computador, rode:",
  "computers.installCommand": "O comando que instala o {cli}",
  "computers.installIn": "Num terminal em {computer}, rode:",
  "computers.installMissing":
    "O {cli} ainda não está instalado em {computer}. Num terminal lá, rode:",
  "computers.installThen": "Depois verifique de novo aqui. É a instalação oficial do {cli}.",
  "computers.keepAsIs": "Deixar como está",
  "computers.listMore": "{rest} e {last}",
  "computers.listPair": "{first} e {second}",
  "computers.moreOn": "Mais de {computer}",
  "computers.noComputerText":
    "Os planos rodam pelos apps deles num computador seu, um Mac, um PC com Linux ou Windows, " +
    "enquanto ele estiver ligado. Conecte um, e entre aqui.",
  "computers.noComputerTitle": "Conecte um computador seu primeiro",
  "computers.notOpened": "Não está nessa tela? Abra aqui",
  "computers.offline": "Offline",
  "computers.offlineNote":
    "{computer} está offline. Ligue-o, ou abra o programa do computador nele, e tente de novo.",
  "computers.openSignIn": "Abrir a página de login",
  "computers.openSpace": "Abrir {space}",
  "computers.optionAsleep": "Dormindo: ele acorda primeiro",
  "computers.optionReady": "Pronto para entrar",
  "computers.output": "O que o {cli} diz",
  "computers.ownSignIn":
    "É o login dos seus agentes: o seu próprio uso do {cli} nesse computador continua como está.",
  "computers.paletteGroup": "Geral",
  "computers.paletteKeywords":
    "plano, assinatura, entrar, login, computador, Claude, ChatGPT, Codex, Gemini, Google",
  "computers.palettePlans": "Planos nos seus computadores",
  "computers.paletteSignIn": "Entrar no seu {plan}",
  "computers.paletteSignedIn": "Conectado em {computer}",
  "computers.paletteSignedInMany": {
    one: "Conectado em {count} computador",
    other: "Conectado em {count} computadores",
  },
  "computers.personal": "seu espaço Pessoal",
  "computers.plansAbout":
    "Seus agentes podem rodar num plano que você já paga, em vez de uma chave de API. Entre uma " +
    "vez, pelo app dele num computador seu, e ele vale em todas as conversas e espaços daqui.",
  "computers.plansPrivate":
    "Nada é cobrado aqui por essas chamadas. O login fica no seu computador: este app nunca o vê.",
  "computers.plansTitle": "Planos nos seus computadores",
  "computers.rowInstalled": "Instalado, sem login",
  "computers.rowMissing": "O {cli} não está instalado",
  "computers.rowOld": "Não respondeu: o programa do computador talvez precise de atualização",
  "computers.rowSharedSomewhere": "Compartilhado com agentes de outros",
  "computers.rowSignedIn": "Conectado",
  "computers.rowSignedInAs": "Conectado como {account}",
  "computers.rowUnchecked": "Ainda não verificado",
  "computers.runsWhileOn":
    "Seus agentes o usam enquanto {computer} estiver ligado; até lá, usam os modelos do app.",
  "computers.send": "Enviar",
  "computers.sharedFix":
    "Para usá-lo no seu plano, faça os agentes deles perguntarem a você antes lá: assim nada roda " +
    "nele sem o seu sim. Ou tire-o de {spaces}, pelo menu dele lá.",
  "computers.sharedNotice":
    "{computer} está compartilhado com agentes de outros em {spaces}, então seus planos não rodam nele.",
  "computers.sharedNoticeSomewhere":
    "{computer} está compartilhado com agentes de outros, então seus planos não rodam nele.",
  "computers.sharedTitle": "{computer} está compartilhado com agentes de outros",
  "computers.sharedWhy":
    "Em {spaces}, os agentes de cada pessoa trabalham em {computer} como você. Com login lá, " +
    "seu plano também seria deles para usar, então ele não pode rodar nele.",
  "computers.sharedWhySomewhere":
    "Agentes de outros trabalham em {computer} como você, onde ele está compartilhado. Com login " +
    "lá, seu plano também seria deles para usar, então ele não pode rodar nele.",
  "computers.signIn": "Entrar",
  "computers.signInAgain": "Entrar de novo",
  "computers.signInOn": "Pelo {cli}, em {computer}.",
  "computers.signInOther": "Entrar em outro computador",
  "computers.signInThrough": "Pelo {cli}, num computador seu.",
  "computers.signInTitle": "Entrar no seu {plan}",
  "computers.signedIn": "Conectado",
  "computers.start": "Começar o login",
  "computers.stepCode": "Cole o código que ela der",
  "computers.stepEnterCode":
    "Abra a página de login, entre com a conta que tem o seu plano, e digite este código lá:",
  "computers.stepSignIn": "Entre no seu {plan}",
  "computers.stepSignInHere": "Abra a página de login, e entre com a conta que tem o seu plano.",
  "computers.stepSignInThere":
    "Uma página de login abre no navegador de {computer}. Entre lá, com a conta que tem o seu plano.",
  "computers.stepSignInWait": "A página de login aparece aqui assim que o {cli} a mostrar.",
  "computers.stepStart": "Abrindo o {cli} em {computer}",
  "computers.stepWake": "Acordando {computer}",
  "computers.tryAgain": "Tentar de novo",
  "computers.version": "versão {version}",
  "computers.waiting": "Esperando o login terminar…",
  "computers.wakeNote": "{computer} acorda primeiro: leva um momento.",
  "computers.whichComputer": "Em qual computador?",
  "computers.whichHint":
    "As chamadas dos seus agentes rodam lá, então ele precisa estar ligado enquanto eles trabalham.",
};
