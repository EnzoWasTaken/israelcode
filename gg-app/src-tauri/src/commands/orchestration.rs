//! Native orchestration proxies: the Worker model and the Orchestrate toggle.

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: pin the Worker model this window's orchestrator hands pieces to, or
/// clear it (`None`) so workers follow the main model. The sidecar validates
/// the model, the provider login and refuses paid tiers.
#[tauri::command]
pub(crate) async fn agent_set_worker_model(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/orchestration/worker-model", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to change the workers' model").await
}

/// Proxy: switch Orchestrate on or off for THIS window's coding session; the
/// choice is also kept as the default for new sessions.
#[tauri::command]
pub(crate) async fn agent_set_orchestrate(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    on: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/orchestration/toggle", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "on": on }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to change Orchestrate").await
}
