import { defineRead } from "@copilotz/copilotz/collections/authoring";
import { reservationWindowRead } from "../../../shared/reservation-window.ts";
const read: typeof reservationWindowRead = defineRead(
  reservationWindowRead.execute,
);
export default read;
