import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { threadWindowRead } from "../../../shared/thread-window-read.ts";
const read: typeof threadWindowRead = defineRead(threadWindowRead.execute);
export default read;
