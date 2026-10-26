//! Local text-to-speech with Piper.
//!
//! The voice model (`models/tts/*.onnx`) and the small `piper.exe` runtime live
//! inside the project, so no cloud service and no extra installation is
//! needed. The audio is returned to the webview as a `data:` URL and played
//! through an `AudioContext`, which is what drives the lip-sync analyser.

use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn search_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("models").join("tts"));
        dirs.push(cwd.join("..").join("models").join("tts"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            dirs.push(dir.join("models").join("tts"));
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("models").join("tts"));
    }
    dirs
}

fn find_piper(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    for dir in search_dirs(app) {
        if !dir.exists() {
            continue;
        }
        let Some(exe) = [dir.join("piper").join("piper.exe"), dir.join("piper.exe")]
            .into_iter()
            .find(|p| p.is_file())
        else {
            continue;
        };

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut voices: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("onnx"))
                        .unwrap_or(false)
            })
            .collect();
        voices.sort();
        if let Some(model) = voices.into_iter().next() {
            return Some((exe, model));
        }
    }
    None
}

pub fn available(app: &AppHandle) -> bool {
    find_piper(app).is_some()
}

fn synth(app: &AppHandle, text: &str) -> Result<String, String> {
    let (exe, model) = find_piper(app).ok_or("Piper voice is not installed")?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("eiwaifu-{stamp}.wav"));

    let mut cmd = Command::new(&exe);
    cmd.arg("--model")
        .arg(&model)
        .arg("--output_file")
        .arg(&out)
        // A slightly slower, softer delivery suits the character.
        .arg("--length_scale")
        .arg("1.05")
        .arg("--noise_scale")
        .arg("0.667")
        .arg("--noise_w")
        .arg("0.8")
        .arg("--sentence_silence")
        .arg("0.2")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // The espeak data and the DLLs are found next to piper.exe.
    if let Some(parent) = exe.parent() {
        cmd.current_dir(parent);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start piper: {e}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("could not send text to piper: {e}"))?;
    }
    // Closing stdin tells piper that the text is complete.
    drop(child.stdin.take());

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = fs::remove_file(&out);
        return Err("piper failed to synthesize the line".into());
    }

    let bytes = fs::read(&out).map_err(|e| format!("could not read the voice file: {e}"))?;
    let _ = fs::remove_file(&out);

    if bytes.len() < 64 {
        return Err("piper produced an empty voice file".into());
    }

    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:audio/wav;base64,{encoded}"))
}

#[tauri::command]
pub async fn speak_local(app: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    tokio::task::spawn_blocking(move || synth(&app, &trimmed))
        .await
        .map_err(|e| e.to_string())?
}

/// True when a Piper voice and runtime are present. Used by the UI to decide
/// whether to offer the local voice.
#[tauri::command]
pub fn tts_available(app: AppHandle) -> bool {
    available(&app)
}

#[allow(dead_code)]
fn is_voice_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("onnx"))
        .unwrap_or(false)
}
