import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { checkpointSourceRead } from "../../../shared/source.ts";
const read: typeof checkpointSourceRead = defineRead(
  checkpointSourceRead.execute,
);
export default read;
