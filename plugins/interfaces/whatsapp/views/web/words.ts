/**
 * WhatsApp's front end, in words and links: a number's digits, WhatsApp's
 * link to write to it (with a code typed in), a code as people read it, and
 * whether Meta can reach where the app is.
 */

/** A number's digits alone: "+1 555-0100" → "15550100". */
export const digitsOf = (phone: string) => phone.replace(/\D/g, "");

/** WhatsApp's link to write to a number, the text typed in, on a phone or the desktop app. */
export const chatLink = (phone: string, text?: string) =>
  `https://wa.me/${digitsOf(phone)}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

/** A six-digit code in two groups: "482 913". */
export const grouped = (code: string) =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

/** A phone's WhatsApp id as people write numbers: "5511987654321" → "+55 11987654321". */
export const shown = (waId: string) => (waId.startsWith("+") ? waId : `+${waId}`);

/** Whether Meta can't reach an address: this machine, or a private network. */
export const unreachable = (origin: string) => {
  const host = (() => {
    try {
      return new URL(origin).hostname;
    } catch {
      return "";
    }
  })();
  return !host || host === "localhost" || host.endsWith(".localhost") || host === "[::1]" ||
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !origin.startsWith("https:");
};
