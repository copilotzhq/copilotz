/** The words the directory's web side says itself (an org's name, where it shows), in English. */
import { defineWords } from "../../../hosts/web/words.ts";

export const say = defineWords("directory", {
  // What an org is called where it shows: everyone's own
  personalOrg: "Personal",
});
