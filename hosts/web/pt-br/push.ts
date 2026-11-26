/** Notifications' words in Brazilian Portuguese: the keys `hosts/web/WORDS.md` lists, `push.*`. */
import type { Words } from "../words.ts";

export const push: Words = {
  "push.title": "Notificações",
  "push.about": "Quando algo espera por você (um agente pedindo seu sim, uma resposta numa " +
    "conversa que você começou, alguém escrevendo para você) e o app não está aberto, avisamos " +
    "nos aparelhos em que você as ativar. Nada enquanto você está olhando o app.",
  "push.thisDevice": "Neste aparelho",
  "push.on": "Ativadas",
  "push.off": "Desativadas",
  "push.turnOn": "Ativar",
  "push.turnOff": "Desativar",
  "push.onText": "Você será avisado aqui quando algo esperar por você.",
  "push.offText": "Ative para ser avisado aqui quando algo esperar por você.",
  "push.blocked": "As notificações deste app estão bloqueadas nas configurações do navegador. " +
    "Permita-as lá e volte aqui.",
  "push.install": "No iPhone e no iPad, as notificações chegam só ao app da Tela de Início: " +
    "toque em Compartilhar, depois em Adicionar à Tela de Início, abra-o por lá e ative-as.",
  "push.unsupported": "Este navegador não mostra notificações do app.",
  "push.notSetUp": "As notificações ainda não estão configuradas neste app.",
  "push.others": "Seus aparelhos",
  "push.othersEmpty": "Nenhum aparelho com notificações ativadas ainda.",
  "push.thisOne": "este aparelho",
  "push.since": "ativadas {when}",
  "push.remove": "Desativar em {device}",
};
