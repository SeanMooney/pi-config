/**
 * Native terminal notification when a Pi turn finishes after noticeable work.
 *
 * Set PI_NOTIFY_MIN_SECONDS to tune the threshold. Defaults to 30 seconds.
 * Set PI_NOTIFY_MIN_SECONDS=0 to notify after every completed agent turn.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MIN_SECONDS = 30;

function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const escapedTitle = title.replace(/'/g, "''");
  const escapedBody = body.replace(/'/g, "''");
  return [
    `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
    `$template = [${type}.ToastTemplateType]::ToastText01`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent($template)`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapedBody}')) > $null`,
    `$toast = [${type}.ToastNotification]::new($xml)`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${escapedTitle}').Show($toast)`,
  ].join("; ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${safeText(title)};${safeText(body)}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=1:d=0;${safeText(title)}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${safeText(body)}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(safeText(title), safeText(body))]);
}

function notify(title: string, body: string): void {
  if (process.env.WT_SESSION) notifyWindows(title, body);
  else if (process.env.KITTY_WINDOW_ID) notifyOSC99(title, body);
  else notifyOSC777(title, body);
}

function minDurationMs(): number {
  const configured = Number(process.env.PI_NOTIFY_MIN_SECONDS);
  const seconds = Number.isFinite(configured) ? configured : DEFAULT_MIN_SECONDS;
  return Math.max(0, seconds) * 1000;
}

export default function (pi: ExtensionAPI) {
  let startedAt: number | undefined;

  pi.on("agent_start", async () => {
    startedAt = Date.now();
  });

  pi.on("agent_end", async () => {
    if (startedAt === undefined) return;

    const elapsedMs = Date.now() - startedAt;
    startedAt = undefined;

    if (elapsedMs < minDurationMs()) return;

    const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));
    notify("Pi", `Ready for input after ${elapsedSeconds}s`);
  });
}
