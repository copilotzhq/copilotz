import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { toolSourcesRead } from "../../../shared/evidence.ts";
const read: typeof toolSourcesRead = defineRead(toolSourcesRead.execute);
export default read;
