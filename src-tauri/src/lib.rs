mod http;
mod llm;
mod win;

use llm::{BackendInfo, ChatMsg};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

pub const MAIN_WINDOW: &str = "waifu";

/// Title of the main window. A second copy of the app uses it to find the
/// window of the instance that is already running.
const MAIN_WINDOW_TITLE: &str = "Ei Waifu";

/// Name of the mutex that keeps a second instance from starting.
const SINGLE_INSTANCE_MUTEX: &str = r"Local\EiWaifuSingleInstance";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub persona_name: String,
    pub user_name: String,
    pub personality: String,
    pub llm_provider: String,
    pub llm_model: String,
    pub ollama_base_url: String,
    pub lmstudio_base_url: String,
    pub temperature: f64,
    /// 0..1 - how warm she is towards the user.
    pub affinity: f64,
    pub scale: f64,
    pub always_on_top: bool,
    pub click_through: bool,
    pub selected_model: String,
    pub bubble_seconds: f64,
    pub greet_on_start: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            persona_name: "Aria".into(),
            user_name: "you".into(),
            personality: "warm, playful and a little teasing. genuinely curious about the user's day".into(),
            llm_provider: "auto".into(),
            llm_model: String::new(),
            ollama_base_url: "http://localhost:11434".into(),
            lmstudio_base_url: "http://localhost:1234".into(),
            temperature: 0.9,
            affinity: 0.25,
            scale: 1.0,
            always_on_top: true,
            click_through: true,
            selected_model: String::new(),
            bubble_seconds: 7.0,
            greet_on_start: true,
        }
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Port of the loopback server that serves the models directory.
    pub model_port: std::sync::atomic::AtomicU16,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// folder name inside the models directory
    pub name: String,
    /// path of the model definition file, relative to the models directory
    pub file: String,
    /// "cubism4" | "cubism2"
    pub kind: String,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_config(app: &AppHandle) -> AppConfig {
    let mut cfg = AppConfig::default();
    if let Some(path) = config_path(app) {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<AppConfig>(&text) {
                cfg = parsed;
            }
        }
    }
    cfg
}

fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("cannot resolve config dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn models_root(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("models"))
            .unwrap_or_else(|| PathBuf::from("models"))
    } else {
        app.path()
            .app_data_dir()
            .map(|d| d.join("models"))
            .unwrap_or_else(|_| PathBuf::from("models"))
    }
}

/// Folders that may hold the bundled Live2D models. They are used to seed
/// the models directory in the app data folder, so the app also finds its
/// models when it is started straight from the build folder.
fn model_sources(app: &AppHandle) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |path: PathBuf| {
        if !out.contains(&path) {
            out.push(path);
        }
    };

    if cfg!(debug_assertions) {
        push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("models"),
        );
    }

    // installed app: the resources sit next to the executable
    if let Ok(res) = app.path().resource_dir() {
        push(res.join("models"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push(dir.join("models"));
            push(dir.join("resources").join("models"));
            // <project>\src-tauri\target\release\ei-waifu.exe -> <project>\models
            push(dir.join("..").join("..").join("models"));
            push(dir.join("..").join("..").join("..").join("models"));
        }
    }

    out
}

/// Creates the models directory and seeds it with the bundled models when it
/// is still empty.
fn ensure_models_dir(app: &AppHandle) -> PathBuf {
    let dir = models_root(app);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    if cfg!(debug_assertions) {
        return dir;
    }

    let empty = fs::read_dir(&dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true);
    if empty {
        for src in model_sources(app) {
            if src == dir || !src.is_dir() {
                continue;
            }
            if copy_dir(&src, &dir).is_ok() {
                break;
            }
        }
    }
    dir
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn window_hwnd(app: &AppHandle) -> Option<isize> {
    let window = app.get_webview_window(MAIN_WINDOW)?;
    let hwnd = window.hwnd().ok()?;
    Some(hwnd.0 as isize)
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// Appends a line to the application log. The frontend uses this to trace its
/// own lifecycle, which makes debugging a transparent window a lot easier.
#[tauri::command]
fn log_line(app: AppHandle, msg: String) {
    let stamp = chrono_like_now();
    let line = format!("[{stamp}] {msg}\n");
    println!("{line}");
    if let Some(path) = app.path().app_data_dir().ok().map(|d| d.join("ei-waifu.log")) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// `YYYY-MM-DD HH:MM:SS` without pulling in the chrono crate.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // civil-from-days (Howard Hinnant's algorithm)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[tauri::command]
fn set_config(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> Result<(), String> {
    let mut guard = state.config.lock().unwrap();
    *guard = config.clone();
    drop(guard);
    save_config(&app, &config)?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_always_on_top(config.always_on_top);
    }
    Ok(())
}

#[tauri::command]
fn models_dir(app: AppHandle) -> String {
    ensure_models_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn list_models(app: AppHandle) -> Vec<ModelEntry> {
    let dir = ensure_models_dir(&app);
    let mut out = Vec::new();

    let folders = match fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect::<Vec<_>>(),
        Err(_) => return out,
    };

    for folder in folders {
        let name = folder
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let entries = match fs::read_dir(&folder) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect::<Vec<_>>(),
            Err(_) => continue,
        };

        for path in entries {
            let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let (kind, file) = if file_name.ends_with(".model3.json") {
                ("cubism4", file_name.clone())
            } else if file_name.ends_with(".model.json") {
                ("cubism2", file_name.clone())
            } else {
                continue;
            };
            out.push(ModelEntry {
                name: name.clone(),
                file: format!("{}/{}", name, file),
                kind: kind.into(),
            });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Base URL of the loopback server that serves the models directory.
#[tauri::command]
fn model_base_url(state: State<'_, AppState>) -> String {
    let port = state.model_port.load(std::sync::atomic::Ordering::Relaxed);
    format!("http://127.0.0.1:{}/", port)
}

#[tauri::command]
fn cursor_pos() -> win::CursorPos {
    win::cursor_pos()
}

/// Toggles click-through. The webview tests the cursor against the model's
/// alpha mask (and the UI rectangles) and calls this with the result. The
/// window is never clipped, so the character keeps her anti-aliased edges and
/// the desktop compositor blends them per pixel.
#[tauri::command]
fn set_passthrough(app: AppHandle, ignore: bool) -> Result<(), String> {
    let hwnd = window_hwnd(&app).ok_or("window not available")?;
    win::set_click_through(hwnd, ignore);
    Ok(())
}

#[tauri::command]
fn window_bounds(app: AppHandle) -> WindowBounds {
    let window = app.get_webview_window(MAIN_WINDOW);
    let scale_factor = window
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    // the *client* area is what the canvas is painted on, so its origin is the
    // one we need to map the cursor onto
    let (x, y) = window
        .as_ref()
        .and_then(|w| w.inner_position().ok())
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    let (width, height) = window
        .as_ref()
        .and_then(|w| w.inner_size().ok())
        .map(|s| (s.width, s.height))
        .unwrap_or((0, 0));

    WindowBounds {
        x,
        y,
        width,
        height,
        scale_factor,
    }
}

#[tauri::command]
fn set_window_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("no window")?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("no window")?;
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("no window")?;
    let visible = window.is_visible().unwrap_or(true);
    if visible {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.show().map_err(|e| e.to_string())
    }
}

/// Shows or hides the character. Hiding it is the "turn the model off"
/// switch: the app stays alive in the tray and can be brought back.
#[tauri::command]
fn set_window_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("no window")?;
    if visible {
        window.show().map_err(|e| e.to_string())
    } else {
        window.hide().map_err(|e| e.to_string())
    }
}

/// True while the character is on screen.
#[tauri::command]
fn window_visible(app: AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true)
}

/// Shuts the whole app down.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_path(_app: AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("not supported on this platform".into())
    }
    Ok(())
}

#[tauri::command]
async fn detect_backend(
    state: State<'_, AppState>,
) -> Result<BackendInfo, String> {
    let cfg = state.config.lock().unwrap().clone();
    Ok(llm::detect_backends(&cfg).await)
}

#[tauri::command]
async fn chat(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<ChatMsg>,
) -> Result<(), String> {
    let cfg = state.config.lock().unwrap().clone();
    let backend = llm::detect_backends(&cfg).await;
    if backend.provider.is_empty() {
        let msg = backend.error.clone();
        let _ = app.emit("chat:error", msg);
        return Ok(());
    }

    tauri::async_runtime::spawn(async move {
        let provider = backend.provider.clone();
        match llm::stream_chat(app.clone(), cfg, backend, messages).await {
            Ok(()) => {
                let _ = app.emit("chat:done", provider);
            }
            Err(e) => {
                let _ = app.emit("chat:error", e);
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/// Handles the flags of a second copy of the app. They are forwarded to the
/// instance that is already running, so the model can be turned off and on
/// from the command line.
///
/// Returns true when the process has done its job and should stop.
fn handle_cli_command() -> bool {
    let mut command: Option<&str> = None;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--hide" | "/hide" => command = Some("hide"),
            "--show" | "/show" => command = Some("show"),
            "--toggle" | "/toggle" => command = Some("toggle"),
            "--quit" | "/quit" => command = Some("quit"),
            _ => {}
        }
    }

    let Some(command) = command else {
        return false;
    };

    let handled = match command {
        "hide" => win::set_window_visible(MAIN_WINDOW_TITLE, false),
        "show" => win::set_window_visible(MAIN_WINDOW_TITLE, true),
        "toggle" => win::toggle_window(MAIN_WINDOW_TITLE),
        "quit" => win::close_window(MAIN_WINDOW_TITLE),
        _ => false,
    };

    if !handled {
        eprintln!("Ei Waifu is not running.");
    }
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A second copy of the app would put a second character on the desktop
    // and there would be no reliable way to turn that one off again. So the
    // extra copies only pass on their command and quit.
    if handle_cli_command() {
        return;
    }

    match win::acquire_single_instance(SINGLE_INSTANCE_MUTEX) {
        Ok(true) => {}
        Ok(false) => {
            // Another instance is already running, bring it back to the
            // screen instead of starting a second character.
            win::set_window_visible(MAIN_WINDOW_TITLE, true);
            return;
        }
        Err(()) => {
            // The mutex could not be created, running is better than not.
        }
    }

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(AppConfig::default()),
            model_port: std::sync::atomic::AtomicU16::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            log_line,
            models_dir,
            list_models,
            model_base_url,
            cursor_pos,
            set_passthrough,
            window_bounds,
            set_window_position,
            set_always_on_top,
            toggle_window,
            set_window_visible,
            window_visible,
            quit_app,
            open_path,
            detect_backend,
            chat,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // load persisted config
            {
                let state = handle.state::<AppState>();
                let cfg = load_config(&handle);
                *state.config.lock().unwrap() = cfg.clone();
                if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
                    let _ = window.set_always_on_top(cfg.always_on_top);
                }
            }

            // Layered windows are required for cross-process click-through, so
            // enable the style once before the first hit test. Only the
            // transparent bit is toggled after this.
            #[cfg(target_os = "windows")]
            if let Some(hwnd) = window_hwnd(&handle) {
                win::set_click_through(hwnd, false);
            }

            let models = ensure_models_dir(&handle);

            // serve the models over loopback so the Live2D runtime can resolve
            // relative resources (moc3, textures, motions, ...) correctly.
            match http::start(models) {
                Ok(port) => {
                    handle
                        .state::<AppState>()
                        .model_port
                        .store(port, std::sync::atomic::Ordering::Relaxed);
                }
                Err(e) => eprintln!("failed to start model server: {e}"),
            }

            // tray menu
            let toggle =
                MenuItem::with_id(&handle, "toggle", "Show / hide character", true, None::<&str>)?;
            let hide = MenuItem::with_id(&handle, "hide", "Hide character", true, None::<&str>)?;
            let show = MenuItem::with_id(&handle, "show", "Show character", true, None::<&str>)?;
            let chat_item = MenuItem::with_id(&handle, "chat", "Toggle chat", true, None::<&str>)?;
            let models_item =
                MenuItem::with_id(&handle, "models", "Open models folder", true, None::<&str>)?;
            let config_item =
                MenuItem::with_id(&handle, "config", "Open config folder", true, None::<&str>)?;
            let quit = PredefinedMenuItem::quit(&handle, Some("Quit Ei Waifu"))?;
            let sep = PredefinedMenuItem::separator(&handle)?;
            let sep2 = PredefinedMenuItem::separator(&handle)?;
            let menu = Menu::with_items(
                &handle,
                &[
                    &toggle,
                    &hide,
                    &show,
                    &chat_item,
                    &sep,
                    &models_item,
                    &config_item,
                    &sep2,
                    &quit,
                ],
            )?;

            TrayIconBuilder::with_id("main")
                .icon(
                    handle
                        .default_window_icon()
                        .cloned()
                        .unwrap_or_else(|| tauri::image::Image::new_owned(Vec::new(), 1, 1)),
                )
                .tooltip("Ei Waifu")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            let visible = window.is_visible().unwrap_or(true);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                            }
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = window.hide();
                        }
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                            let _ = window.show();
                        }
                    }
                    "chat" => {
                        let _ = app.emit("menu:toggle-chat", ());
                    }
                    "models" => {
                        let dir = models_root(app);
                        let _ = app.emit("menu:open-models", dir.to_string_lossy().to_string());
                    }
                    "config" => {
                        if let Ok(p) = app.path().app_config_dir() {
                            let _ = app.emit("menu:open-config", p.to_string_lossy().to_string());
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window(MAIN_WINDOW) {
                            let visible = window.is_visible().unwrap_or(true);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ei-waifu");
}
