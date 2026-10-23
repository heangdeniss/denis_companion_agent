use crate::AppConfig;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    /// "ollama" | "lmstudio" | ""
    pub provider: String,
    pub base_url: String,
    pub models: Vec<String>,
    pub active_model: String,
    pub error: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .read_timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

/// Ollama only listens on `127.0.0.1`, but on Windows `localhost` resolves to
/// `::1` first. The literal address removes that ambiguity, so a probe can not
/// fail while the server is actually up.
pub fn loopback(url: &str) -> String {
    url.trim().trim_end_matches('/').replace("://localhost", "://127.0.0.1")
}

/// `qwen2.5` and `qwen2.5:latest` are the same model to Ollama.
fn same_model(installed: &str, configured: &str) -> bool {
    installed == configured
        || installed == format!("{configured}:latest")
        || format!("{installed}:latest") == configured
}

/// Probes the known local inference servers. Ollama is preferred, LM Studio is
/// the fallback. Both speak OpenAI-ish protocols so the frontend can treat
/// them uniformly.
pub async fn detect_backends(cfg: &AppConfig) -> BackendInfo {
    let http = match client() {
        Ok(c) => c,
        Err(e) => {
            return BackendInfo {
                error: e,
                ..Default::default()
            }
        }
    };

    let ollama_url = loopback(&cfg.ollama_base_url);
    let lmstudio_url = loopback(&cfg.lmstudio_base_url);

    let mut ollama_models: Vec<String> = Vec::new();
    if let Ok(resp) = http
        .get(format!("{ollama_url}/api/tags"))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(list) = json.get("models").and_then(|m| m.as_array()) {
                    for m in list {
                        if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                            ollama_models.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    let mut lmstudio_models: Vec<String> = Vec::new();
    if let Ok(resp) = http
        .get(format!("{lmstudio_url}/v1/models"))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(list) = json.get("data").and_then(|m| m.as_array()) {
                    for m in list {
                        if let Some(id) = m.get("id").and_then(|n| n.as_str()) {
                            lmstudio_models.push(id.to_string());
                        }
                    }
                }
            }
        }
    }

    let prefer_ollama = cfg.llm_provider != "lmstudio";
    let mut info = BackendInfo::default();

    if prefer_ollama && !ollama_models.is_empty() {
        info.provider = "ollama".into();
        info.base_url = ollama_url.clone();
        info.models = ollama_models;
    } else if !lmstudio_models.is_empty() {
        info.provider = "lmstudio".into();
        info.base_url = lmstudio_url.clone();
        info.models = lmstudio_models;
    } else if !ollama_models.is_empty() {
        info.provider = "ollama".into();
        info.base_url = ollama_url;
        info.models = ollama_models;
    }

    if info.provider.is_empty() {
        info.error = "No local inference server found. Start Ollama or LM Studio.".into();
        return info;
    }

    // The list is sorted, so "the first model" is the same model on every
    // start instead of whatever the server happens to return first.
    info.models.sort();

    // The configured model is the one she always talks to. If it is not
    // installed the reason is reported instead of silently switching to a
    // different model - that would change her voice from one run to the next.
    let configured = cfg.llm_model.trim().to_string();
    info.active_model = if !configured.is_empty() {
        if info.models.iter().any(|m| same_model(m, &configured)) {
            configured
        } else {
            info.error = format!(
                "Model '{configured}' is not installed. Run: ollama pull {configured}"
            );
            configured
        }
    } else {
        info.models.first().cloned().unwrap_or_default()
    };

    info
}

/// Streams a chat completion to the frontend. Chunks are emitted as
/// `chat:delta` events, the run ends with `chat:done` or `chat:error`.
pub async fn stream_chat(
    app: AppHandle,
    cfg: AppConfig,
    backend: BackendInfo,
    messages: Vec<ChatMsg>,
) -> Result<(), String> {
    let http = client()?;
    let model = backend.active_model.clone();

    let mut stream: BoxStream<'static, Result<String, String>> = match backend.provider.as_str() {
        "ollama" => {
            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                // The model is small but a cold load still takes a few
                // seconds. Keeping it in memory between messages makes the
                // first token arrive at the same speed every time.
                "keep_alive": "30m",
                "options": { "temperature": cfg.temperature }
            });
            let resp = http
                .post(format!("{}/api/chat", backend.base_url))
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("Ollama returned {}", resp.status()));
            }
            let bytes = resp.bytes_stream();
            Box::pin(bytes.map(|c| {
                c.map(|b| String::from_utf8_lossy(&b).to_string())
                    .map_err(|e| e.to_string())
            }))
        }
        _ => {
            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                "temperature": cfg.temperature
            });
            let resp = http
                .post(format!("{}/v1/chat/completions", backend.base_url))
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("LM Studio returned {}", resp.status()));
            }
            let bytes = resp.bytes_stream();
            Box::pin(bytes.map(|c| {
                c.map(|b| String::from_utf8_lossy(&b).to_string())
                    .map_err(|e| e.to_string())
            }))
        }
    };

    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&chunk);

        while let Some(idx) = buffer.find('\n') {
            let line: String = buffer.drain(..=idx).collect();
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if let Some(delta) = parse_delta(&backend.provider, &line) {
                if !delta.is_empty() {
                    let _ = app.emit("chat:delta", delta);
                }
            }
        }
    }

    if let Some(delta) = parse_delta(&backend.provider, buffer.trim()) {
        if !delta.is_empty() {
            let _ = app.emit("chat:delta", delta);
        }
    }

    Ok(())
}

fn parse_delta(provider: &str, line: &str) -> Option<String> {
    let payload = if provider == "ollama" {
        line.to_string()
    } else {
        line.strip_prefix("data:")?.trim().to_string()
    };

    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }

    let json: serde_json::Value = serde_json::from_str(&payload).ok()?;

    if provider == "ollama" {
        json.get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
    } else {
        json.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
    }
}
