/**
 * Computers' words in Brazilian Portuguese (a person's plans on their own computers, a
 * computer's Files tab and uploading to it, an agent's calls that move a file between a chat and
 * a computer): the keys `hosts/web/WORDS.md` lists, `computers.*`.
 */
import type { Words } from "../words.ts";

export const computers: Words = {
  "computers.antigravityCli": "Antigravity",
  "computers.antigravityTitle": "Plano do Google AI, pelo Antigravity",
  "computers.askMeFirst": "Perguntar a mim antes em {spaces}",
  "computers.cancel": "Cancelar",
  "computers.checkAgain": "Verificar de novo",
  "computers.checkFailed": "Não deu para verificar seus computadores: {why}",
  "computers.claudeCli": "Claude Code",
  "computers.claudeTitle": "Plano do Claude",
  "computers.close": "Fechar",
  "computers.codeHint": "Se a página mostrar um código depois que você entrar, cole aqui.",
  "computers.codeLabel": "O código da página de login",
  "computers.codePlaceholder": "Cole o código",
  "computers.codeSent": "Código enviado: finalizando…",
  "computers.codexCli": "Codex",
  "computers.codexTitle": "Plano do ChatGPT, pelo Codex",
  "computers.copyCode": "Copiar o código",
  "computers.done": "Pronto",
  "computers.dropTitle": "Solte para enviar",
  "computers.dropTo": "Para {folder} em {computer}",
  "computers.filesDownload": "Baixar {name}",
  "computers.filesEmpty": "Nada aqui ainda",
  "computers.filesEmptyDrop":
    "Solte arquivos aqui para enviá-los. O que você e seus agentes fizerem nesta pasta também aparece aqui.",
  "computers.filesEmptyText": "O que você e seus agentes fizerem nesta pasta aparece aqui.",
  "computers.filesFilter": "Filtrar",
  "computers.filesFilterLabel": "Filtrar esta pasta",
  "computers.filesIn": "Em {folder}",
  "computers.filesItsOwner": "o dono dele",
  "computers.filesJustUploaded": "enviado",
  "computers.filesNoMatch": "Nada aqui corresponde a “{filter}”.",
  "computers.filesOn": "{folder}, em {computer}",
  "computers.filesRefresh": "Atualizar",
  "computers.filesUpTo": "Voltar para {folder}",
  "computers.filesViewOnly":
    "Só {owner} muda arquivos em {computer} aqui. Você pode abri-los e baixá-los.",
  "computers.filesWhere": "Onde, na pasta",
  "computers.folderDropped":
    "“{name}” é uma pasta, e pastas não podem ser enviadas. Solte os arquivos dela, ou um zip dela.",
  "computers.foldersDropped": {
    one:
      "{count} pasta não foi enviada: pastas não podem ser. Solte os arquivos dela, ou um zip dela.",
    other:
      "{count} pastas não foram enviadas: pastas não podem ser. Solte os arquivos delas, ou um zip de cada uma.",
  },
  "computers.gotCode": "A página deu um código?",
  "computers.howToFix": "Como resolver",
  "computers.installCommand": "O comando que instala o {cli}",
  "computers.keepAsIs": "Deixar como está",
  "computers.keepBoth": "Manter os dois",
  "computers.listMore": "{rest} e {last}",
  "computers.listPair": "{first} e {second}",
  "computers.newFile": "Novo arquivo",
  "computers.newFileMake": "Criar o arquivo",
  "computers.newFileName": "O nome do novo arquivo",
  "computers.newFilePlaceholder": "notas.md, ou src/novo.ts",
  "computers.notOpened": "Não está nessa tela? Abra aqui",
  "computers.offline": "Offline",
  "computers.openSignIn": "Abrir a página de login",
  "computers.openSpace": "Abrir {space}",
  "computers.output": "O que o {cli} diz",
  "computers.paletteGroup": "Geral",
  "computers.paletteKeywords":
    "plano, assinatura, entrar, login, computador, Claude, ChatGPT, Codex, Gemini, Google",
  "computers.personal": "seu espaço Pessoal",
  "computers.plansAbout":
    "Seus agentes rodam nos planos de IA que você já paga, em vez dos modelos do app. " +
    "Conecte cada um uma vez, e ele vale em todas as conversas e espaços daqui.",
  "computers.plansPrivate":
    "Seu plano paga a IA. Um computador na nuvem que você usa para ele é cobrado enquanto " +
    "está acordado. Os logins ficam nos seus computadores, ou lacrados no servidor: ninguém mais os vê.",
  "computers.plansTitle": "Seus planos",
  "computers.replace": "Substituir",
  "computers.replaceAll": {
    one: "Fazer o mesmo com o outro arquivo que já está lá",
    other: "Fazer o mesmo com os outros {count} arquivos que já estão lá",
  },
  "computers.replaceFolderText":
    "Um arquivo não substitui uma pasta. Envie o seu ao lado dela com outro nome, ou pule.",
  "computers.replaceFolderTitle": "Já tem uma pasta chamada “{name}”",
  "computers.replaceKeepAs": "Manter os dois envia o seu como “{name}”.",
  "computers.replaceText":
    "{folder} já tem um arquivo chamado “{name}”. Substituir põe o seu no lugar dele.",
  "computers.replaceThere": "O que está lá: {size}, alterado {time}",
  "computers.replaceTitle": "Substituir “{name}”?",
  "computers.replaceYours": "O seu: {size}, alterado {time}",
  "computers.send": "Enviar",
  "computers.shareOwnWarning":
    "Os agentes de {space} rodam em {computer} como você: eles podem ler tudo o que você pode lá, inclusive seus próprios logins (Claude Code, Codex, chaves SSH). Compartilhe só com pessoas de confiança.",
  "computers.shareSignedIn":
    "{computer} está conectado ao seu {plan}. Saia dele primeiro: um computador compartilhado com outros não pode manter logins de planos.",
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
  "computers.signInAgain": "Entrar de novo",
  "computers.signOut": "Sair",
  "computers.signOutFailed": "Não deu para sair em {computer}: {why}",
  "computers.skip": "Pular",
  "computers.stepEnterCode":
    "Abra a página de login, entre com a conta que tem o seu plano, e digite este código lá:",
  "computers.stepSaved": "Salvou {file} em {path}",
  "computers.stepSaves": "Salva {file} em {path}",
  "computers.stepSavesFile": "Salva um arquivo desta conversa em {path}",
  "computers.stepSavesFolder": "Salva um arquivo desta conversa na pasta do espaço",
  "computers.stepSends": "Envia {path} para esta conversa",
  "computers.stepSent": "Enviou {file}",
  "computers.stepSignInHere": "Abra a página de login, e entre com a conta que tem o seu plano.",
  "computers.stepSignInThere":
    "Uma página de login abre no navegador de {computer}. Entre lá, com a conta que tem o seu plano.",
  "computers.stepSignInWait": "A página de login aparece aqui assim que o {cli} a mostrar.",
  "computers.tryAgain": "Tentar de novo",
  "computers.upload": "Enviar",
  "computers.uploadAsking": "Já tem um com este nome",
  "computers.uploadCancel": "Cancelar o envio de {name}",
  "computers.uploadCancelled": "Cancelado",
  "computers.uploadDone": "Enviado",
  "computers.uploadDoneAs": "Enviado como {name}",
  "computers.uploadFailed": "Não foi enviado. Tente de novo.",
  "computers.uploadFinishing": "Salvando em {computer}…",
  "computers.uploadFolderThere": "Já tem uma pasta com esse nome, e um arquivo não a substitui.",
  "computers.uploadForbidden": "Você não pode mudar arquivos neste computador.",
  "computers.uploadFull": "Não tem mais espaço no disco de {computer}.",
  "computers.uploadIn": "em {folder}",
  "computers.uploadInvalid": "Esse nome não pode ser usado aqui.",
  "computers.uploadNetwork": "A conexão caiu. Tente de novo.",
  "computers.uploadNoLength": "O navegador não disse o tamanho dele. Tente de novo.",
  "computers.uploadNoWake": "{computer} não acordou a tempo. Tente de novo.",
  "computers.uploadNotFound": "Este computador não está mais neste espaço.",
  "computers.uploadOffline": "{computer} está offline. Tente de novo quando ele estiver ligado.",
  "computers.uploadOpen": "Abrir {name}",
  "computers.uploadOutdated":
    "O programa do computador de {computer} é antigo demais para receber envios. Ele se atualiza sozinho, ou o dono dele o atualiza: depois tente de novo.",
  "computers.uploadProgress": "{done} de {total}",
  "computers.uploadProgressLabel": "Enviando {name}",
  "computers.uploadQueued": "Esperando para enviar",
  "computers.uploadReplaced": "Enviado no lugar do que estava lá",
  "computers.uploadRestart": "Este envio foi interrompido e precisa começar de novo.",
  "computers.uploadSignedOut": "Você saiu da sua conta. Entre de novo, e tente de novo.",
  "computers.uploadSkipped": "Pulado: o que está lá fica",
  "computers.uploadTooLarge": "Ele tem {size}: um arquivo pode ter no máximo {most}.",
  "computers.uploadTooLargeHere": "Ele tem {size}: grande demais para enviar por este app.",
  "computers.uploadUnavailable": "{computer} não conseguiu acordar. Tente de novo daqui a pouco.",
  "computers.uploadWaiting": "Esperando {computer}…",
  "computers.uploadWaking": "Acordando {computer}…",
  "computers.uploading": {
    one: "Enviando {count} arquivo",
    other: "Enviando {count} arquivos",
  },
  "computers.uploads": "Envios",
  "computers.uploadsAsking": {
    one: "{count} espera por você",
    other: "{count} esperam por você",
  },
  "computers.uploadsCancelAll": "Cancelar todos",
  "computers.uploadsDone": {
    one: "{count} arquivo enviado",
    other: "{count} arquivos enviados",
  },
  "computers.uploadsFailed": {
    one: "{count} não foi enviado",
    other: "{count} não foram enviados",
  },
  "computers.uploadsHide": "Ocultar envios",
  "computers.uploadsLeft": "faltam {size}",
  "computers.connectPlans": "Conectar seus planos",
  "computers.connect": "Conectar",
  "computers.fix": "Resolver",
  "computers.signOutOn": "Sair em {computer}",
  "computers.signOutServer": "Desconectar {plan}",
  "computers.alsoThrough": "Também pelo {cli}, num computador",
  "computers.moreFor": "Mais de {plan}",
  "computers.cardReadyServer": "Conectado como {account}, no servidor: sempre pronto.",
  "computers.cardReady": "Rodando no {computer} ({state}).",
  "computers.cardReadyBackup":
    "Rodando no {computer} ({state}), com o {backup} pronto como reserva.",
  "computers.cardOnline": "ligado",
  "computers.cardAsleep": "dormindo: acorda quando seus agentes precisam",
  "computers.cardAlso": "Também pelo {cli} no {computer}, como reserva.",
  "computers.cardAway": {
    one:
      "Conectado no {computers}, que está desligado. Seus agentes usam os modelos do app até ele ligar.",
    other:
      "Conectado em {computers}, que estão desligados. Seus agentes usam os modelos do app até um ligar.",
  },
  "computers.cardReconnect": "O {plan} precisa que você entre de novo.",
  "computers.cardShared":
    "Conectado só em {computers}, compartilhado com agentes de outras pessoas, então seu plano não roda lá.",
  "computers.cardOff": "Não conectado: seus agentes usam os modelos do app.",
  "computers.cardLimited":
    "No limite desde {time}: seus agentes usam seu próximo plano, ou os modelos do app, até ele voltar.",
  "computers.orderTitle": "Usar meus planos nesta ordem",
  "computers.orderAbout":
    "Quando um modelo roda em mais de um dos seus planos, seus agentes tentam nesta ordem.",
  "computers.moveUp": "Subir",
  "computers.moveDown": "Descer",
  "computers.notConnected": "não conectado",
  "computers.orderFailed": "Não deu para salvar a ordem: {why}",
  "computers.yoursTitle": "Seus computadores",
  "computers.yoursAbout": "Onde seus planos rodam, e o trabalho dos seus agentes.",
  "computers.yoursServes": "Roda {plans}",
  "computers.yoursServesNone": "Nenhum plano conectado aqui",
  "computers.yoursNone":
    "Nenhum computador ainda. Um plano que roda pelo app dele precisa de um: conectá-lo monta um para você.",
  "computers.terminal": "Terminal",
  "computers.signInHere": "Entrar nos seus planos aqui",
  "computers.addComputer": "Adicionar um computador",
  "computers.online": "Online",
  "computers.seenAt": "visto por último {time}",
  "computers.flowTitle": "Conectar seus planos",
  "computers.flowPick":
    "Escolha cada plano que você paga: seus agentes rodam neles em vez dos modelos do app.",
  "computers.flowConnected": "Conectado",
  "computers.flowNext": "Avançar",
  "computers.flowWhere": "Onde eles devem rodar?",
  "computers.flowWhereAbout":
    "{plans} rodam por um app num computador. Nós o montamos, e o mantemos atualizado.",
  "computers.whereCloud": "Na nuvem",
  "computers.whereCloudAbout":
    "Sempre pronto. Dorme quando seus agentes não estão trabalhando, e você paga só enquanto está acordado.",
  "computers.recommended": "Recomendado",
  "computers.whereLocal": "Neste computador",
  "computers.whereLocalAbout":
    "Grátis. Funciona enquanto este computador está ligado. Precisa de uma linha no seu terminal, uma vez.",
  "computers.whereNone": "Abra esta página no seu computador para conectá-lo.",
  "computers.making": "Criando seu computador na nuvem…",
  "computers.makeFailed": "Não deu para criar seu computador na nuvem: {why}",
  "computers.back": "Voltar",
  "computers.lineComputer": "{computer} está pronto",
  "computers.lineWaking": "Acordando {computer}… (uns 30 segundos)",
  "computers.lineGetting": "Preparando {computer}…",
  "computers.lineOld": "{computer} roda um programa mais antigo que este app: seguindo assim.",
  "computers.lineInstall": "O {cli} está instalado",
  "computers.lineInstalling": "Instalando o {cli} em {computer}…",
  "computers.lineSignIn": "Entrar no {plan}",
  "computers.lineSignedInAs": "Conectado como {account}",
  "computers.lineAlready": "Já conectado",
  "computers.lineTest": "O {plan} responde no seu plano",
  "computers.lineTesting": "Fazendo uma pergunta curta…",
  "computers.lineAnswered": "Respondeu: “{text}”",
  "computers.lineLimit":
    "Conectado. Seu {plan} está no limite agora: seus agentes voltam a usá-lo quando ele voltar.",
  "computers.lineModel":
    "Conectado. O {model} não está no seu plano, então seus agentes usam o próximo para ele.",
  "computers.failOff": "{computer} está desligado. Ligue-o, ou use um computador na nuvem.",
  "computers.failShared":
    "{computer} está compartilhado com agentes de outras pessoas, então planos não rodam nele.",
  "computers.failReach": "Não deu para falar com {computer}: {why}",
  "computers.failInstall":
    "O {cli} não instalou em {computer}. O que o instalador disse está abaixo.",
  "computers.failWindows": "Instale o {cli} em {computer} pelo terminal dele, uma vez:",
  "computers.orInstall": "Ou instale pelo terminal de {computer}, e verifique de novo:",
  "computers.openTerminal": "Abrir o terminal de {computer}",
  "computers.failSignIn": "O login no {plan} não terminou.",
  "computers.failGone": "{computer} ficou offline.",
  "computers.failSignedOut": "O {plan} diz que você não está conectado.",
  "computers.failTest": "O {plan} não respondeu: {why}",
  "computers.failOldLaptop":
    "{computer} roda um programa do Copilotz mais antigo e não se atualizou. Feche o Copilotz lá e abra de novo.",
  "computers.failOldCloud":
    "{computer} roda um programa mais antigo que este app. Os computadores na nuvem estão se atualizando: tente de novo em alguns minutos.",
  "computers.useCloud": "Usar um computador na nuvem",
  "computers.flowDone": "Seus agentes agora rodam em {plans}.",
  "computers.flowLeft": "O que falta está abaixo, com o que fazer.",
  "computers.flowNone": "Nada conectado ainda. O que falta está abaixo, com o que fazer.",
  "computers.welcomeNone": "Nenhum destes",
  "computers.welcomeNoneThen": "Seus agentes usam os modelos do app.",
  "computers.welcomeConnect": "Conectar",
  "computers.welcomeLater": "Você pode conectá-los depois, em Sua IA.",
  "computers.paletteConnect": "Conectar seu {plan}",
  "computers.paletteConnected": "Conectado",
};
