import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { turnContextRead } from "../../../shared/turn-context.ts";
const read: typeof turnContextRead = defineRead(turnContextRead.execute);
export default read;
