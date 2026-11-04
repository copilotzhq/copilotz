/**
 * What customers on a line are told when what they wrote can't go on, or an
 * agent couldn't answer it: in the number's language, in their terms, never
 * an error's own words.
 */
export type Lines = { turn: string; large: string; kind: string; voice: string; failed: string };

export const CUSTOMERS: Record<"en" | "pt", Lines> = {
  en: {
    turn: "Sorry, something went wrong on my side. Please send that again in a moment.",
    large: "That file is too large. Send a smaller one, or a link to it.",
    kind: "I can't read that kind of message yet: send text, a photo, a document or a voice note.",
    voice: "I couldn't make out that voice note. Could you say it again, or write it?",
    failed: "Sorry, I couldn't take that message. Please try again in a moment.",
  },
  pt: {
    turn: "Desculpe, tive um problema aqui. Pode mandar de novo em instantes?",
    large: "Esse arquivo é grande demais. Envie um menor, ou um link para ele.",
    kind:
      "Ainda não consigo ler esse tipo de mensagem: envie texto, uma foto, um documento ou um áudio.",
    voice: "Não consegui entender esse áudio. Pode repetir, ou escrever?",
    failed: "Desculpe, não consegui receber essa mensagem. Tente de novo em instantes.",
  },
};
