mod http;
mod llm;
mod local_llm;
mod local_tts;
mod ollama;
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

/// The outfit every character starts with.
fn default_outfit() -> String {
    "default".into()
}

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
    /// The outfit she is wearing, e.g. "default" or "bunny".
    #[serde(default = "default_outfit")]
    pub selected_outfit: String,
    pub bubble_seconds: f64,
    pub greet_on_start: bool,
    /// Width of the overlay in css pixels.
    pub window_width: f64,
    /// Height of the overlay in css pixels. `0` means "as tall as needed".
    pub window_height: f64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            persona_name: "Aria".into(),
            user_name: "you".into(),
            personality: "warm, playful and a little teasing. genuinely curious about the user's day".into(),
            llm_provider: "ollama".into(),
            llm_model: "qwen2.5:1.5b".into(),
            ollama_base_url: "http://127.0.0.1:11434".into(),
            lmstudio_base_url: "http://127.0.0.1:1234".into(),
            temperature: 0.9,
            affinity: 0.25,
            scale: 1.0,
            always_on_top: true,
            click_through: true,
            selected_model: String::new(),
            selected_outfit: "default".into(),
            bubble_seconds: 7.0,
            greet_on_start: true,
            window_width: 420.0,
            window_height: 0.0,
        }
    }
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Port of the loopback server that serves the models directory.
    pub model_port: std::sync::atomic::AtomicU16,
    /// Child process spawned by us (Ollama)
    pub ollama_child: Mutex<Option<std::process::Child>>,
    /// True if we spawned ollama
    pub ollama_spawned_by_us: std::sync::atomic::AtomicBool,
    /// Child process of the bundled llama-server, if we started one.
    pub local_child: Mutex<Option<std::process::Child>>,
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

/// The conversation memory lives next to the config, so it survives restarts
/// and is shared between a dev run and the packaged app.
fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create app data folder: {e}"))?;
    Ok(dir.join("memory.json"))
}

#[tauri::command]
fn load_memory(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = memory_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::Value::Array(Vec::new()));
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value.is_array() {
        Ok(value)
    } else {
        Ok(serde_json::Value::Array(Vec::new()))
    }
}

#[tauri::command]
fn save_memory(app: AppHandle, entries: serde_json::Value) -> Result<(), String> {
    let path = memory_path(&app)?;
    let text = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn load_config(app: &AppHandle) -> AppConfig {
    let mut cfg = AppConfig::default();
    if let Some(path) = config_path(app) {
        if let Ok(text) = fs::read_to_string(&path) {
            // A config that was written by an editor with a byte order mark
            // would not parse, and the app would silently fall back to the
            // defaults. The mark is dropped before parsing.
            let text = text.trim_start_matches('\u{feff}');
            if let Ok(parsed) = serde_json::from_str::<AppConfig>(text) {
                cfg = parsed;
            }
        }
    }

    // Configs written before the loopback address was pinned still say
    // `localhost`, which on Windows can resolve to `::1` while the server only
    // listens on `127.0.0.1`. The migration is written back so the file and
    // the running app agree.
    let ollama = llm::loopback(&cfg.ollama_base_url);
    let lmstudio = llm::loopback(&cfg.lmstudio_base_url);
    if ollama != cfg.ollama_base_url || lmstudio != cfg.lmstudio_base_url {
        cfg.ollama_base_url = ollama;
        cfg.lmstudio_base_url = lmstudio;
        let _ = save_config(app, &cfg);
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

/// The root of everything the webview loads. The models and the character
/// assets live in folders below it, and the loopback server serves exactly
/// this folder.
fn server_root(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

fn models_root(app: &AppHandle) -> PathBuf {
    server_root(app).join("models")
}

/// The character assets: `assets/characters/<name>/base` and `.../outfits`.
fn assets_root(app: &AppHandle) -> PathBuf {
    server_root(app).join("assets")
}

/// Folders that may hold the bundled "models" or "assets" trees. They are
/// used to seed those directories in the app data folder, so the app also
/// finds them when it is started straight from the build folder.
fn bundled_sources(app: &AppHandle, folder: &str) -> Vec<PathBuf> {
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
                .join(folder),
        );
    }

    // installed app: the resources sit next to the executable
    if let Ok(res) = app.path().resource_dir() {
        push(res.join(folder));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push(dir.join(folder));
            push(dir.join("resources").join(folder));
            // <project>\src-tauri\target\release\ei-waifu.exe -> <project>\<folder>
            push(dir.join("..").join("..").join(folder));
            push(dir.join("..").join("..").join("..").join(folder));
        }
    }

    out
}

/// Creates a directory and seeds it with the bundled files when it is still
/// empty.
fn ensure_dir_with_sources(dir: PathBuf, sources: Vec<PathBuf>) -> PathBuf {
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
        for src in sources {
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

/// Creates the models directory and seeds it with the bundled models when it
/// is still empty.
fn ensure_models_dir(app: &AppHandle) -> PathBuf {
    ensure_dir_with_sources(models_root(app), bundled_sources(app, "models"))
}

/// Creates the character assets directory and seeds it with the bundled
/// characters when it is still empty.
fn ensure_assets_dir(app: &AppHandle) -> PathBuf {
    ensure_dir_with_sources(assets_root(app), bundled_sources(app, "assets"))
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

/// One texture of an outfit. It replaces the atlas with the same index.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutfitTexture {
    /// The index of the atlas in the model.
    pub index: u32,
    /// The path of the file inside the outfit folder.
    pub file: String,
}

/// One outfit of a character.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutfitEntry {
    /// The id of the folder, e.g. "bunny".
    pub id: String,
    /// The name that is shown in the menu.
    pub label: String,
    /// The group the outfit is sorted into.
    pub category: String,
    /// The folder of the outfit, relative to the server root.
    pub path: String,
    /// The atlases this outfit replaces.
    pub textures: Vec<OutfitTexture>,
    /// False when the assets are missing or do not fit the model.
    pub available: bool,
    /// Why the outfit cannot be used.
    pub problem: String,
}

/// The optional `outfit.json` of an outfit folder.
#[derive(Deserialize, Default, Clone, Debug)]
struct OutfitManifest {
    label: Option<String>,
    category: Option<String>,
    #[serde(default)]
    order: Option<i32>,
}

/// An atlas of the base model.
struct BaseTexture {
    /// The path of the atlas inside the model folder.
    rel: String,
    /// The plain file name, that is what an outfit has to provide.
    name: String,
    width: u32,
    height: u32,
}

/// The atlases a Live2D model uses.
fn model_textures(model_path: &Path) -> Vec<BaseTexture> {
    let Ok(text) = fs::read_to_string(model_path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };

    let entries: Vec<String> = if model_path.to_string_lossy().ends_with(".model3.json") {
        json.get("FileReferences")
            .and_then(|f| f.get("Textures"))
            .and_then(|t| t.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        // Cubism 2 keeps the textures at the top level.
        json.get("textures")
            .and_then(|t| t.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    let dir = model_path.parent().unwrap_or(Path::new(""));
    entries
        .into_iter()
        .map(|rel| {
            let name = rel
                .rsplit('/')
                .next()
                .unwrap_or(rel.as_str())
                .to_string();
            let (width, height) = png_size(&dir.join(&rel)).unwrap_or((0, 0));
            BaseTexture {
                rel,
                name,
                width,
                height,
            }
        })
        .collect()
}

/// The pixel size of a png, read from its header.
fn png_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut head = [0u8; 24];
    file.read_exact(&mut head).ok()?;
    if &head[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    Some((width, height))
}

/// "smart_casual" -> "Smart Casual"
fn pretty_name(id: &str) -> String {
    id.split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The path of a folder relative to the server root, with forward slashes.
fn relative_to(root: &Path, path: &Path) -> String {
    let rest = path.strip_prefix(root).unwrap_or(path);
    rest.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The outfits of the character that owns the given model.
///
/// The model file is given relative to the server root. A character folder
/// may hold a "base" folder with the model and an "outfits" folder next to
/// it, a plain model folder holds its outfits inside itself.
///
/// An outfit replaces the texture page with the clothes, e.g.
/// `outfits/bunny/texture_01.png` for the page `texture_01.png` of the model.
/// The page with the body, the head and the face is never part of an outfit,
/// so the face stays the same in every outfit. An outfit without that file
/// is not an error, it simply wears the base clothes.
#[tauri::command]
fn list_outfits(app: AppHandle, model: String) -> Vec<OutfitEntry> {
    let mut out: Vec<(i32, OutfitEntry)> = Vec::new();
    let root = server_root(&app);
    let model_path = root.join(&model);
    let model_dir = model_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| root.clone());

    let character_dir = match model_dir.file_name().and_then(|n| n.to_str()) {
        Some("base") => model_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| model_dir.clone()),
        _ => model_dir.clone(),
    };
    let outfits_dir = character_dir.join("outfits");
    let character_rel = relative_to(&root, &character_dir);

    let base = model_textures(&model_path);
    if base.is_empty() {
        return Vec::new();
    }

    for folder in read_dirs(&outfits_dir) {
        let id = file_name_of(&folder);
        if id.is_empty() {
            continue;
        }

        let manifest = fs::read_to_string(folder.join("outfit.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<OutfitManifest>(&text).ok())
            .unwrap_or_default();

        let mut textures = Vec::new();
        let mut problem = String::new();

        for (index, atlas) in base.iter().enumerate() {
            // The outfit may hold the atlas under its plain name or under
            // the same path the model uses.
            let candidates = [folder.join(&atlas.name), folder.join(&atlas.rel)];
            let Some(file) = candidates.iter().find(|p| p.is_file()) else {
                // The outfit does not replace this atlas, the base is kept.
                continue;
            };
            let inside = file
                .strip_prefix(&folder)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| atlas.name.clone());

            match png_size(file) {
                Some((w, h)) if w == atlas.width && h == atlas.height => {
                    textures.push(OutfitTexture {
                        index: index as u32,
                        file: inside,
                    });
                }
                Some((w, h)) => {
                    problem = format!(
                        "{} is {}x{} but the model needs {}x{}",
                        atlas.name, w, h, atlas.width, atlas.height
                    );
                }
                None => {
                    problem = format!("{} is not a readable png", atlas.name);
                }
            }
        }

        // An outfit without artwork is not an error: the base clothes stay on
        // and the menu marks the outfit as "no artwork yet". Only a file that
        // does not fit the model is a problem.

        out.push((
            manifest.order.unwrap_or(99),
            OutfitEntry {
                label: manifest.label.unwrap_or_else(|| pretty_name(&id)),
                category: manifest.category.unwrap_or_else(|| "Custom".into()),
                path: format!("{}/outfits/{}", character_rel, id),
                available: problem.is_empty(),
                problem,
                id,
                textures,
            },
        ));
    }

    // The manifest may define the order of the outfits.
    out.sort_by(|a, b| (a.0, &a.1.id).cmp(&(b.0, &b.1.id)));
    out.into_iter().map(|(_, entry)| entry).collect()
}

/// The outfits of the character that owns the given model.
#[tauri::command]
fn assets_dir(app: AppHandle) -> String {
    ensure_assets_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn models_dir(app: AppHandle) -> String {
    ensure_models_dir(&app).to_string_lossy().to_string()
}

/// The folders inside a directory.
fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// The files inside a directory.
fn read_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default()
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// The kind and the file name of a Live2D model file.
fn model_file(path: &Path) -> Option<(&'static str, String)> {
    let name = file_name_of(path);
    if name.ends_with(".model3.json") {
        Some(("cubism4", name))
    } else if name.ends_with(".model.json") {
        Some(("cubism2", name))
    } else {
        None
    }
}

#[tauri::command]
fn list_models(app: AppHandle) -> Vec<ModelEntry> {
    let mut out = Vec::new();
    let _ = ensure_models_dir(&app);
    let _ = ensure_assets_dir(&app);

    // Plain models: models/<character>/<file>.model3.json
    for folder in read_dirs(&models_root(&app)) {
        let name = file_name_of(&folder);
        for path in read_files(&folder) {
            if let Some((kind, file)) = model_file(&path) {
                out.push(ModelEntry {
                    name: name.clone(),
                    file: format!("models/{}/{}", name, file),
                    kind: kind.into(),
                });
            }
        }
    }

    // Characters: assets/characters/<character>/base/<file>.model3.json
    for folder in read_dirs(&assets_root(&app).join("characters")) {
        let name = file_name_of(&folder);
        for path in read_files(&folder.join("base")) {
            if let Some((kind, file)) = model_file(&path) {
                out.push(ModelEntry {
                    name: name.clone(),
                    file: format!("assets/characters/{}/base/{}", name, file),
                    kind: kind.into(),
                });
            }
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

/// True when the native per pixel hit test is available. The webview uses it
/// to decide between the native hit test and the old "make the whole window
/// click-through" fallback.
#[tauri::command]
fn hit_test_available() -> bool {
    win::hit_test_available()
}

/// The packed silhouette of the character, one bit per cell.
#[tauri::command]
fn set_hit_map(
    bits: Vec<u8>,
    cols: u32,
    rows: u32,
    cell: f64,
    scale: f64,
) -> Result<(), String> {
    win::set_hit_map(bits, cols, rows, cell as f32, scale as f32);
    Ok(())
}

/// The parts of the user interface that take the mouse.
#[tauri::command]
fn set_ui_rects(rects: Vec<win::UiRect>) -> Result<(), String> {
    win::set_ui_rects(rects);
    Ok(())
}

/// While forced the whole window reacts to the mouse. Used while the
/// character is dragged or the window is resized.
#[tauri::command]
fn set_hit_force(force: bool) -> Result<(), String> {
    win::set_hit_force(force);
    Ok(())
}

/// Turns the click-through on or off.
#[tauri::command]
fn set_hit_enabled(enabled: bool) -> Result<(), String> {
    win::set_hit_enabled(enabled);
    Ok(())
}

/// A snapshot of the native hit test, used while debugging.
#[tauri::command]
fn hit_test_stats() -> win::HitStats {
    win::hit_stats()
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

/// Resizes the overlay.
///
/// `keep_bottom` keeps the lower edge of the window where it is and grows the
/// window upwards. That is what the automatic size needs, so the character
/// does not jump when the chat panel appears. When it is false the top left
/// corner stays in place and the corner follows the mouse.
#[tauri::command]
fn set_window_size(
    app: AppHandle,
    width: f64,
    height: f64,
    keep_bottom: bool,
) -> Result<(), String> {
    let window = app.get_webview_window(MAIN_WINDOW).ok_or("no window")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let new_height = (height * scale).round() as i32;
    if keep_bottom {
        let new_y = position.y + (inner.height as i32 - new_height);
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(position.x, new_y))
            .map_err(|e| e.to_string())?;
    } else {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

fn cleanup_ollama(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state
        .ollama_spawned_by_us
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        if let Ok(mut child) = state.ollama_child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        state
            .ollama_spawned_by_us
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

fn cleanup_local_model(app: &AppHandle) {
    local_llm::kill(app);
}

/// Shuts the whole app down.
#[tauri::command]
fn quit_app(app: AppHandle) {
    cleanup_ollama(&app);
    cleanup_local_model(&app);
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BackendInfo, String> {
    // The in-folder model is preferred: it needs no installation and is the
    // fastest path for a machine that has the `models/` folder populated.
    if let Some(info) = local_llm::ready_backend(&app).await {
        return Ok(info);
    }
    let cfg = state.config.lock().unwrap().clone();
    Ok(llm::detect_backends(&cfg).await)
}

#[tauri::command]
async fn chat(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<ChatMsg>,
) -> Result<(), String> {
    // Prefer the bundled model. `ensure_started` loads it on the first message
    // and reports an error only if the local stack is incomplete, in which
    // case the normal Ollama/LM Studio detection runs below.
    if let Ok(backend) = local_llm::ensure_started(&app).await {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            match local_llm::stream_chat(handle.clone(), messages, backend).await {
                Ok(()) => {
                    let _ = handle.emit("chat:done", "local");
                }
                Err(e) => {
                    let _ = handle.emit("chat:error", e);
                }
            }
        });
        return Ok(());
    }

    let cfg = state.config.lock().unwrap().clone();
    let backend = llm::detect_backends(&cfg).await;
    // A reachable server is not enough: a missing model is reported as an
    // error too, so the chat never silently runs on a different model.
    if backend.provider.is_empty() || !backend.error.is_empty() {
        let msg = if backend.error.is_empty() {
            "No local inference server found. Start Ollama or LM Studio.".to_string()
        } else {
            backend.error.clone()
        };
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
            ollama_child: Mutex::new(None),
            ollama_spawned_by_us: std::sync::atomic::AtomicBool::new(false),
            local_child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            log_line,
            models_dir,
            assets_dir,
            list_models,
            list_outfits,
            model_base_url,
            cursor_pos,
            set_passthrough,
            hit_test_available,
            set_hit_map,
            set_ui_rects,
            set_hit_force,
            set_hit_enabled,
            hit_test_stats,
            window_bounds,
            set_window_position,
            set_window_size,
            set_always_on_top,
            toggle_window,
            set_window_visible,
            window_visible,
            quit_app,
            open_path,
            detect_backend,
            chat,
            local_llm::list_local_models,
            local_llm::local_status,
            local_tts::speak_local,
            local_tts::tts_available,
            load_memory,
            save_memory,
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
                    // Restore the size of the overlay. A height of zero means
                    // "as tall as the character and the chat need", the
                    // webview calculates that once the model is loaded.
                    if cfg.window_width > 0.0 {
                        let height = if cfg.window_height > 0.0 {
                            cfg.window_height
                        } else {
                            window.inner_size().map(|s| s.height as f64).unwrap_or(720.0)
                                / window.scale_factor().unwrap_or(1.0)
                        };
                        let _ = window.set_size(tauri::LogicalSize::new(cfg.window_width, height));
                    }
                }
            }

            // Layered windows are required for cross-process click-through, so
            // enable the style once before the first hit test. Only the
            // transparent bit is toggled after this.
            #[cfg(target_os = "windows")]
            if let Some(hwnd) = window_hwnd(&handle) {
                win::set_click_through(hwnd, false);
                // The native hit test decides per pixel whether a click
                // belongs to the character or to the desktop underneath.
                if !win::install_hit_test(hwnd) {
                    eprintln!("native hit test unavailable, falling back to the window wide click-through");
                }
            }

            let _ = ensure_models_dir(&handle);
            let _ = ensure_assets_dir(&handle);

            // serve the assets over loopback so the Live2D runtime can resolve
            // relative resources (moc3, textures, motions, ...) correctly.
            match http::start(server_root(&handle)) {
                Ok(port) => {
                    handle
                        .state::<AppState>()
                        .model_port
                        .store(port, std::sync::atomic::Ordering::Relaxed);
                }
                Err(e) => eprintln!("failed to start model server: {e}"),
            }

            // Prefer the model that lives inside the project. When it is there
            // the bundled llama-server is started instead of Ollama, so the
            // app works with nothing installed on the machine.
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                if local_llm::is_installed(&handle_clone) {
                    local_llm::autostart(handle_clone.clone());
                    return;
                }
                let up = ollama::is_ollama_up().await;
                if !up {
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        if let Ok(child) = std::process::Command::new("ollama")
                            .arg("serve")
                            .creation_flags(CREATE_NO_WINDOW)
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                        {
                            let state2 = handle_clone.state::<AppState>();
                            if let Ok(mut c) = state2.ollama_child.lock() {
                                *c = Some(child);
                            }
                            state2
                                .ollama_spawned_by_us
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        if let Ok(child) = std::process::Command::new("ollama")
                            .arg("serve")
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                        {
                            let state2 = handle_clone.state::<AppState>();
                            if let Ok(mut c) = state2.ollama_child.lock() {
                                *c = Some(child);
                            }
                            state2
                                .ollama_spawned_by_us
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                }
            });

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
            let quit = MenuItem::with_id(&handle, "quit", "Quit Ei Waifu", true, None::<&str>)?;
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
                    "quit" => {
                        cleanup_ollama(app);
                        cleanup_local_model(app);
                        let _ = app.emit("menu:quit", ());
                        let _ = app.exit(0);
                    }
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                cleanup_ollama(window.app_handle());
                cleanup_local_model(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ei-waifu");
}
