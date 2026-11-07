//! Budget guardrail proxies: token caps, the meter and "Continue anyway".

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: this window's budget caps and the current meter.
#[tauri::command]
pub(crate) async fn agent_get_budget(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/budget", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to read the budget").await
}

/// Proxy: set the project's token caps (`None` = no cap) and the runaway
/// hard stop. Saved per project and applied to this session now.
#[tauri::command]
pub(crate) async fn agent_set_budget(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    session_tokens: Option<u64>,
    day_tokens: Option<u64>,
    hard_stop_on_runaway: bool,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/budget", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "sessionTokens": session_tokens,
            "dayTokens": day_tokens,
            "hardStopOnRunaway": hard_stop_on_runaway,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to save the budget").await
}

/// Proxy: continue past a used-up cap for the rest of this session.
#[tauri::command]
pub(crate) async fn agent_budget_continue(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/budget/continue", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to continue past the budget").await
}
