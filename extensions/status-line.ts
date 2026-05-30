/**
 * Status line extension.
 *
 * Keeps concise model and turn progress information in the footer without the
 * duplicated demo status extensions that previously lived in this profile.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let turnCount = 0;
  let currentModel = "model: unknown";

  function formatModel(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`;
  }

  function syncModelStatus(ctx: ExtensionContext): void {
    if (ctx.model) {
      currentModel = formatModel(ctx.model);
    }
    ctx.ui.setStatus("model", `🤖 ${currentModel}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("agent", "Ready");
    syncModelStatus(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    syncModelStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    currentModel = formatModel(event.model);
    syncModelStatus(ctx);

    if (event.source !== "restore") {
      ctx.ui.notify(`Model: ${currentModel}`, "info");
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnCount += 1;
    ctx.ui.setStatus("agent", `● Turn ${turnCount}`);
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx.ui.setStatus("agent", `✓ Turn ${turnCount} complete`);
  });
}
