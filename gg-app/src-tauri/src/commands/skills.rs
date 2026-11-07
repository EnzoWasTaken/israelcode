//! Skill finder proxies: search, inspect, install, list and remove skills.
//! Every command attaches the window's session and forwards to the sidecar's
//! `/skills/*` routes (`packages/ggcoder/src/app-sidecar/skill-routes.ts`).

use super::agent_admin::json_or_error;
use crate::*;

/// Proxy: `GET /skills/search?q=` → `SkillSearchResponse`.
#[tauri::command]
pub(crate) async fn skills_search(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    query: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .get(format!("{}/skills/search", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .query(&[("q", query.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to search skills").await
}

/// Proxy: `POST /skills/inspect` → `SkillInspection` (summary + scan; nothing runs).
#[tauri::command]
pub(crate) async fn skills_inspect(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    source: String,
    slug: String,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/skills/inspect", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "source": source, "slug": slug }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to inspect skill").await
}

/// Proxy: `POST /skills/install` → `SkillInstallResult`.
///
/// A 409 (scan blocked, or a different version is already installed) comes back
/// as `Ok` with `installed: false` so the modal can show the findings; only
/// bodies without that marker become errors.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn skills_install(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    source: String,
    slug: String,
    scope: String,
    project_cwd: Option<String>,
    r#override: Option<bool>,
    replace: Option<bool>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/skills/install", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({
            "source": source,
            "slug": slug,
            "scope": scope,
            "projectCwd": project_cwd,
            "override": r#override.unwrap_or(false),
            "replace": replace.unwrap_or(false),
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
        let refused = body.get("installed").and_then(|v| v.as_bool()) == Some(false)
            && (body.get("scan").is_some() || status.as_u16() == 409);
        if refused {
            return Ok(body);
        }
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("failed to install skill");
        return Err(msg.to_string());
    }
    Ok(body)
}

/// Proxy: `GET /skills/installed?project=` → `{ skills: InstalledSkillRow[] }`.
#[tauri::command]
pub(crate) async fn skills_installed(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    project_cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let mut req = client
        .get(format!("{}/skills/installed", sidecar_base(port)))
        .header("x-gg-session", &gg_sid);
    if let Some(p) = project_cwd.as_deref().filter(|p| !p.trim().is_empty()) {
        req = req.query(&[("project", p)]);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    json_or_error(res, "failed to list installed skills").await
}

/// Proxy: `POST /skills/remove` → `{ removed: boolean }`.
#[tauri::command]
pub(crate) async fn skills_remove(
    webview: WebviewWindow,
    client: State<'_, reqwest::Client>,
    name: String,
    scope: String,
    project_cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = port_for(&webview).ok_or("daemon not ready")?;
    let gg_sid = session_for(&webview).ok_or("session not ready")?;
    let res = client
        .post(format!("{}/skills/remove", sidecar_base(port)))
        .header("x-gg-session", &gg_sid)
        .json(&serde_json::json!({ "name": name, "scope": scope, "projectCwd": project_cwd }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(res, "failed to remove skill").await
}
