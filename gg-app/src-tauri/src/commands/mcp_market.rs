//! MCP marketplace proxies: search the official registry, inspect a listing
//! (run options + static scan) and add it. Every command attaches the window's
//! session and forwards to the sidecar's `/mcp/market/*` routes
//! (`packages/ggcoder/src/app-sidecar/mcp-market-routes.ts`).

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: `GET /mcp/market/search?q=&cursor=` → `{ servers, nextCursor }`.
#[tauri::command]
pub(crate) async fn agent_mcp_market_search(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    query: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut req = client
        .get(format!("{}/mcp/market/search", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .query(&[("q", query.as_str())]);
    if let Some(c) = cursor.as_deref().filter(|c| !c.trim().is_empty()) {
        req = req.query(&[("cursor", c)]);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    json_or_error(res, "failed to search the MCP registry").await
}

/// Proxy: `POST /mcp/market/inspect` → `{ listing, options, scan }` (nothing runs).
#[tauri::command]
pub(crate) async fn agent_mcp_market_inspect(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/market/inspect", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "version": version }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to inspect the MCP server").await
}

/// Proxy: `POST /mcp/market/add` → `{ added, name, scan, ... }`.
///
/// A 409 (scan blocked) comes back as `Ok` with `added: false` so the modal can
/// show the findings; other failing bodies become errors.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn agent_mcp_market_add(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    version: Option<String>,
    choice: serde_json::Value,
    scope: String,
    cwd: Option<String>,
    values: Option<serde_json::Value>,
    r#override: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/mcp/market/add", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "name": name,
            "version": version,
            "choice": choice,
            "scope": scope,
            "cwd": cwd,
            "values": values,
            "override": r#override.unwrap_or(false),
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        let refused = body.get("added").and_then(|v| v.as_bool()) == Some(false)
            && (body.get("scan").is_some() || status.as_u16() == 409);
        if refused {
            return Ok(body);
        }
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to add the MCP server");
        return Err(msg.to_string());
    }
    Ok(body)
}
