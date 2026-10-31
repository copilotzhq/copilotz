/**
 * `app.build`: builds and deploys an app being published, as the scheduler
 * runs it, right after `app.publish` (or `app.redeploy`) answered. Its
 * computer sends its folder (an archive, streamed), the host builds an image
 * from it and deploys it as a new revision; then the app is live at its
 * target, and the directory routes its host there. What failed leaves it
 * failed, saying why; an app already live keeps running its last revision,
 * live, saying why the new one failed. The build's minutes are metered
 * either way. An app removed while it built is taken down again.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AppDoc } from "../collections/app.ts";
import { APP_SUBJECTS } from "../contract.ts";
import { archiveOf } from "../shared/archive.ts";
import { claim } from "../shared/claims.ts";
import { failure, messageOf } from "../shared/errors.ts";
import { hostOf } from "../shared/host.ts";
import { meter } from "../shared/meter.ts";
import { settingsOf } from "../shared/settings.ts";

export const buildAction = defineAction({
  description: "Builds and deploys an app being published",
  input: {
    type: "object",
    properties: { app: { type: "string" } },
    required: ["app"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const apps = ctx.as().db.collection<AppDoc>("app");
    const app = await apps.findOne({ _id: input.app });
    if (!app || app.status !== "building") return { status: app?.status ?? "gone" };
    const host = `${app.label}.${settingsOf(ctx).domain}`;
    let minutes = 0;
    try {
      const appHost = hostOf(ctx);
      const archive = await archiveOf(ctx, app);
      const built = await appHost.build({
        app: app.label,
        archive,
        ...(app.source.command ? { command: app.source.command } : {}),
        port: app.source.port,
      }).catch(async (error) => {
        await archive.cancel().catch(() => {});
        throw error;
      });
      minutes = built.minutes;
      const deployed = await appHost.deploy({
        app: app.label,
        image: built.image,
        // The port its image serves on: its front's, for one made for it.
        port: built.port ?? app.source.port,
      });
      const now = await apps.findOne({ _id: app._id });
      if (now?.status !== "building") {
        if (now?.status === "removed") await appHost.remove(app.label).catch(() => {});
        return { status: now?.status ?? "gone" };
      }
      // The front routes its host there first: live means reachable.
      if (!await claim(ctx, host, deployed.target)) {
        throw failure(`Its address, ${host}, is someone else's now.`, "taken");
      }
      const at = new Date().toISOString();
      await apps.updateOne({ _id: app._id }, {
        $set: {
          status: "live",
          service: deployed.service,
          target: deployed.target,
          revision: deployed.revision,
          image: built.image,
          // Live since its first revision: its running is metered from then.
          ...(app.live ? {} : { live: at }),
        },
        $unset: { error: "" },
        $push: { revisions: { revision: deployed.revision, image: built.image, at } },
      });
      return { status: "live", target: deployed.target, revision: deployed.revision };
    } catch (error) {
      minutes ||= Number((error as { minutes?: unknown }).minutes) || 0;
      // An app with a revision still runs it: it stays live, saying why the new one failed.
      const status = app.revision ? "live" : "failed";
      await apps.updateOne({ _id: app._id, status: "building" }, {
        $set: { status, error: messageOf(error) },
      });
      return { status, error: messageOf(error) };
    } finally {
      if (minutes > 0) {
        await meter(ctx, app, APP_SUBJECTS.build, { minutes }).catch(() => {});
      }
    }
  },
});
