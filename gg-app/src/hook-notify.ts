import type { HookNotify } from "./agent";
import { toast } from "./toast";

/**
 * The notifyOnFinish preset's "done" message. The sidecar never touches the
 * OS; the window decides: a desktop notification through the web
 * `Notification` API (WebView2 supports it; no Tauri plugin needed) when the
 * window is in the background, a toast otherwise or when permission is
 * missing. Permission is asked once, lazily, the first time it is needed.
 */

let permissionAsked = false;

function hasNotificationApi(): boolean {
  return (
    typeof Notification !== "undefined" && typeof Notification.requestPermission === "function"
  );
}

function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

function show(n: HookNotify): boolean {
  try {
    new Notification(n.title, { body: n.body });
    return true;
  } catch {
    return false;
  }
}

export function notifyDesktop(n: HookNotify): void {
  if (windowFocused() || !hasNotificationApi()) {
    toast(n.body, "info", 6000);
    return;
  }
  if (Notification.permission === "granted") {
    if (!show(n)) toast(n.body, "info", 6000);
    return;
  }
  if (Notification.permission === "denied" || permissionAsked) {
    toast(n.body, "info", 6000);
    return;
  }
  permissionAsked = true;
  void Promise.resolve(Notification.requestPermission())
    .then((result) => {
      if (result !== "granted" || !show(n)) toast(n.body, "info", 6000);
    })
    .catch(() => toast(n.body, "info", 6000));
}

/** Tests only. */
export function resetHookNotifyForTests(): void {
  permissionAsked = false;
}
