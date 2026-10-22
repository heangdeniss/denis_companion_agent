//! Small Win32 helpers implemented with raw FFI so that we never have to
//! care about which version of the `windows` crate tauri happens to depend on.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

/// A rectangle of the webview in css pixels.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UiRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Counters of the native hit test, used to see what the window procedure
/// decided without a debugger.
#[derive(Serialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HitStats {
    pub calls: u64,
    pub client: u64,
    pub transparent: u64,
    pub last_x: f32,
    pub last_y: f32,
    pub last_result: i32,
    pub map_updates: u64,
    pub map_bits: usize,
    pub cols: u32,
    pub rows: u32,
    pub cell: f32,
    pub scale: f32,
    pub rects: usize,
    pub enabled: bool,
    pub force: bool,
    pub fresh: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{HitStats, UiRect};
    use std::ffi::c_void;

    pub type HWND = *mut c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongPtrW(hwnd: HWND, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: HWND, index: i32, value: isize) -> isize;
        fn SetWindowPos(
            hwnd: HWND,
            hwnd_insert_after: HWND,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn GetCursorPos(point: *mut POINT) -> i32;
        // window control, used by the single instance / show / hide helpers
        fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> HWND;
        fn ShowWindow(hwnd: HWND, n_cmd_show: i32) -> i32;
        fn SetForegroundWindow(hwnd: HWND) -> i32;
        fn PostMessageW(hwnd: HWND, msg: u32, w_param: usize, l_param: isize) -> i32;
        fn IsWindowVisible(hwnd: HWND) -> i32;
        fn GetWindowThreadProcessId(hwnd: HWND, lpdw_process_id: *mut u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lp_mutex_attributes: *mut c_void,
            b_initial_owner: i32,
            lp_name: *const u16,
        ) -> *mut c_void;
        fn CloseHandle(object: *mut c_void) -> i32;
        fn GetLastError() -> u32;
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;
        fn TerminateProcess(h_process: *mut c_void, u_exit_code: u32) -> i32;
    }

    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_LAYERED: isize = 0x0008_0000;
    const WS_EX_TRANSPARENT: isize = 0x0000_0020;

    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    pub unsafe fn get_cursor_pos() -> (i32, i32) {
        let mut point = POINT::default();
        if GetCursorPos(&mut point) == 0 {
            return (0, 0);
        }
        (point.x, point.y)
    }

    /// Toggles `WS_EX_TRANSPARENT`, which makes the window ignore mouse input
    /// and pass it to whatever is below it. This is only used for hit-testing;
    /// the window itself is never clipped, so WebView2/DWM can blend the
    /// character's anti-aliased alpha channel directly with the desktop.
    ///
    /// `WS_EX_LAYERED` is enabled permanently: Windows needs it to pass input
    /// to a window in another process. It is set once and left alone, only
    /// `WS_EX_TRANSPARENT` changes while the cursor moves.
    pub unsafe fn set_click_through(hwnd: HWND, click_through: bool) {
        let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        style |= WS_EX_LAYERED;
        if click_through {
            style |= WS_EX_TRANSPARENT;
        } else {
            style &= !WS_EX_TRANSPARENT;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        // The new extended style is used by the next hit-test. No frame
        // recalculation is needed, and avoiding it keeps WebView2 from
        // repainting (and flickering) every time the cursor crosses an edge.
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }

    // ------------------------------------------------------------------
    // native hit test
    // ------------------------------------------------------------------
    //
    // The overlay window covers a big part of the screen, but only the
    // character and the little chat panel are actually interactive. Windows
    // asks the window for every mouse position with WM_NCHITTEST, and the
    // answer decides where the click ends up: `HTCLIENT` keeps it inside the
    // window, `HTTRANSPARENT` hands it over to whatever is underneath - even
    // when that is a different process.
    //
    // The webview sends a packed one bit per cell map of the character's
    // silhouette, so the decision is made per pixel and without any delay.

    const WM_NCHITTEST: u32 = 0x0084;
    const HTCLIENT: isize = 1;
    const HTTRANSPARENT: isize = -1;

    pub type SubclassProc =
        unsafe extern "system" fn(HWND, u32, usize, isize, usize, usize) -> isize;

    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(
            hwnd: HWND,
            pfn_subclass: SubclassProc,
            id: usize,
            dw_ref_data: usize,
        ) -> i32;
        fn DefSubclassProc(hwnd: HWND, msg: u32, w_param: usize, l_param: isize) -> isize;
    }

    #[link(name = "user32")]
    extern "system" {
        fn ScreenToClient(hwnd: HWND, point: *mut POINT) -> i32;
    }

    /// Everything the window procedure needs to answer a hit test.
    pub struct HitState {
        /// One bit per cell, `1` means the cell is covered by the character.
        pub bits: Vec<u8>,
        pub cols: u32,
        pub rows: u32,
        /// Size of a cell in css pixels.
        pub cell: f32,
        /// Physical pixels per css pixel.
        pub scale: f32,
        /// Interactive parts of the user interface, in css pixels.
        pub rects: Vec<UiRect>,
        /// While set the whole window reacts to the mouse (dragging).
        pub force: bool,
        /// False when the user turned the click-through off.
        pub enabled: bool,
        /// When the map is older than this the character is considered gone.
        pub updated: Option<std::time::Instant>,
    }

    impl Default for HitState {
        fn default() -> Self {
            Self {
                bits: Vec::new(),
                cols: 0,
                rows: 0,
                cell: 2.0,
                scale: 1.0,
                rects: Vec::new(),
                force: false,
                enabled: true,
                updated: None,
            }
        }
    }

    impl HitState {
        fn is_fresh(&self) -> bool {
            match self.updated {
                Some(at) => at.elapsed() < std::time::Duration::from_secs(3),
                None => false,
            }
        }
    }

    use std::sync::{Arc, Mutex, OnceLock};

    static HIT_STATE: OnceLock<Mutex<Arc<Mutex<HitState>>>> = OnceLock::new();
    static HIT_INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    /// Counters for the debug command.
    static HIT_STATS: Mutex<HitStats> = Mutex::new(HitStats {
        calls: 0,
        client: 0,
        transparent: 0,
        last_x: 0.0,
        last_y: 0.0,
        last_result: 0,
        map_updates: 0,
        map_bits: 0,
        cols: 0,
        rows: 0,
        cell: 0.0,
        scale: 0.0,
        rects: 0,
        enabled: false,
        force: false,
        fresh: false,
    });

    pub fn hit_stats() -> HitStats {
        HIT_STATS.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn with_hit_stats<R>(f: impl FnOnce(&mut HitStats) -> R) -> R {
        let mut stats = HIT_STATS.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut stats)
    }

    fn hit_state() -> &'static Mutex<Arc<Mutex<HitState>>> {
        HIT_STATE.get_or_init(|| Mutex::new(Arc::new(Mutex::new(HitState::default()))))
    }

    pub fn with_hit_state<R>(f: impl FnOnce(&mut HitState) -> R) -> R {
        let shared = hit_state().lock().unwrap_or_else(|e| e.into_inner());
        let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    unsafe extern "system" fn hit_proc(
        hwnd: HWND,
        msg: u32,
        w_param: usize,
        l_param: isize,
        _id: usize,
        _data: usize,
    ) -> isize {
        if msg != WM_NCHITTEST {
            return DefSubclassProc(hwnd, msg, w_param, l_param);
        }

        // The cursor position of the message is in screen coordinates.
        let mut point = POINT {
            x: (l_param & 0xFFFF) as i16 as i32,
            y: ((l_param >> 16) & 0xFFFF) as i16 as i32,
        };
        ScreenToClient(hwnd, &mut point);

        let result = with_hit_state(|state| {
            // Dragging and resizing need the mouse everywhere.
            if state.force || !state.enabled {
                return HTCLIENT;
            }
            // Without a fresh map there is no character to click on.
            if !state.is_fresh() || state.cols == 0 || state.rows == 0 {
                return HTTRANSPARENT;
            }
            let scale = if state.scale > 0.01 { state.scale } else { 1.0 };
            let x = point.x as f32 / scale;
            let y = point.y as f32 / scale;

            // The chat panel, the menu and the resize grip are real controls.
            for rect in &state.rects {
                if x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h {
                    return HTCLIENT;
                }
            }

            // Everything else depends on the silhouette of the character.
            let cell = if state.cell > 0.01 { state.cell } else { 1.0 };
            let col = (x / cell) as i64;
            let row = (y / cell) as i64;
            if col < 0 || row < 0 || col >= state.cols as i64 || row >= state.rows as i64 {
                return HTTRANSPARENT;
            }
            let index = row as usize * state.cols as usize + col as usize;
            let byte = state.bits.get(index >> 3).copied().unwrap_or(0);
            if (byte >> (7 - (index & 7))) & 1 == 1 {
                HTCLIENT
            } else {
                HTTRANSPARENT
            }
        });

        {
            let fresh = with_hit_state(|state| state.is_fresh());
            let mut stats = HIT_STATS.lock().unwrap_or_else(|e| e.into_inner());
            stats.calls += 1;
            if result == HTCLIENT {
                stats.client += 1;
            } else {
                stats.transparent += 1;
            }
            stats.last_x = point.x as f32;
            stats.last_y = point.y as f32;
            stats.last_result = result as i32;
            stats.fresh = fresh;
        }

        result
    }

    /// Installs the hit-test window procedure. Returns false when Windows
    /// refused the subclass, in which case the caller falls back to the
    /// old "make the whole window click-through" behaviour.
    pub unsafe fn install_hit_test(hwnd: HWND) -> bool {
        let ok = SetWindowSubclass(hwnd, hit_proc, 1, 0) != 0;
        HIT_INSTALLED.store(ok, std::sync::atomic::Ordering::Relaxed);
        ok
    }

    pub fn hit_test_installed() -> bool {
        HIT_INSTALLED.load(std::sync::atomic::Ordering::Relaxed)
    }

    // ------------------------------------------------------------------
    // single instance + window control
    // ------------------------------------------------------------------

    const SW_HIDE: i32 = 0;
    const SW_SHOW: i32 = 5;
    const WM_CLOSE: u32 = 0x0010;
    const ERROR_ALREADY_EXISTS: u32 = 183;
    const PROCESS_TERMINATE: u32 = 0x0001;

    /// Null terminated UTF-16 string for the `*W` win32 functions.
    pub fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Finds a top level window by its (exact) title.
    pub unsafe fn find_window_by_title(title: &str) -> Option<HWND> {
        let hwnd = FindWindowW(std::ptr::null(), wide(title).as_ptr());
        if hwnd.is_null() {
            None
        } else {
            Some(hwnd)
        }
    }

    /// Shows or hides a window found by its title.
    pub unsafe fn set_window_visible_by_title(title: &str, visible: bool) -> bool {
        let Some(hwnd) = find_window_by_title(title) else {
            return false;
        };
        if visible {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        } else {
            ShowWindow(hwnd, SW_HIDE);
        }
        true
    }

    /// Flips the visibility of the window found by its title.
    pub unsafe fn toggle_window_by_title(title: &str) -> bool {
        let Some(hwnd) = find_window_by_title(title) else {
            return false;
        };
        if IsWindowVisible(hwnd) != 0 {
            ShowWindow(hwnd, SW_HIDE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        }
        true
    }

    /// Asks the window to close, which shuts the whole app down. When the app
    /// does not react to the close request it is killed, a character that
    /// cannot be switched off is worse than a hard stop.
    pub unsafe fn close_window_by_title(title: &str) -> bool {
        let Some(hwnd) = find_window_by_title(title) else {
            return false;
        };

        PostMessageW(hwnd, WM_CLOSE, 0, 0);

        // Give the app a moment to shut down on its own.
        std::thread::sleep(std::time::Duration::from_millis(600));
        if find_window_by_title(title).is_none() {
            return true;
        }

        // Still there: end the process that owns the window.
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return false;
        }
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return false;
        }
        let killed = TerminateProcess(process, 0) != 0;
        CloseHandle(process);
        killed
    }

    /// Creates a named mutex.
    ///
    /// `Ok(true)` means this process is the first instance, `Ok(false)` means a
    /// mutex with that name already existed (another instance is running) and
    /// `Err(())` means the mutex could not be created at all.
    pub unsafe fn create_named_mutex(name: &str) -> Result<bool, ()> {
        let handle = CreateMutexW(std::ptr::null_mut(), 0, wide(name).as_ptr());
        if handle.is_null() {
            return Err(());
        }
        // GetLastError has to be read right after the call, before anything
        // else can overwrite it.
        let already_exists = GetLastError() == ERROR_ALREADY_EXISTS;
        if already_exists {
            CloseHandle(handle);
            return Ok(false);
        }
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
pub fn cursor_pos() -> CursorPos {
    let (x, y) = unsafe { imp::get_cursor_pos() };
    CursorPos { x, y }
}

#[cfg(not(target_os = "windows"))]
pub fn cursor_pos() -> CursorPos {
    CursorPos { x: 0, y: 0 }
}

/// Enables / disables click-through for the main window. Hit-testing is done
/// in the webview against the model's alpha mask; this only applies the
/// result, it never clips the window.
#[cfg(target_os = "windows")]
pub fn set_click_through(hwnd_raw: isize, click_through: bool) {
    let hwnd = hwnd_raw as *mut std::ffi::c_void;
    unsafe { imp::set_click_through(hwnd, click_through) };
}

#[cfg(not(target_os = "windows"))]
pub fn set_click_through(_hwnd_raw: isize, _click_through: bool) {}

// ---------------------------------------------------------------------------
// native hit test
// ---------------------------------------------------------------------------

/// Installs the `WM_NCHITTEST` window procedure on the main window. From
/// then on the window itself decides per pixel whether a click belongs to the
/// character or to the desktop underneath it.
#[cfg(target_os = "windows")]
pub fn install_hit_test(hwnd_raw: isize) -> bool {
    let hwnd = hwnd_raw as *mut std::ffi::c_void;
    unsafe { imp::install_hit_test(hwnd) }
}

#[cfg(not(target_os = "windows"))]
pub fn install_hit_test(_hwnd_raw: isize) -> bool {
    false
}

/// True when the native hit test is available on this platform.
pub fn hit_test_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        imp::hit_test_installed()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Stores the packed silhouette of the character. `bits` holds one bit per
/// cell, `cell` is the size of a cell in css pixels.
#[cfg(target_os = "windows")]
pub fn set_hit_map(bits: Vec<u8>, cols: u32, rows: u32, cell: f32, scale: f32) {
    let len = bits.len();
    imp::with_hit_state(|state| {
        state.bits = bits;
        state.cols = cols;
        state.rows = rows;
        state.cell = cell;
        state.scale = scale;
        state.updated = Some(std::time::Instant::now());
    });
    imp::with_hit_stats(|stats| {
        stats.map_updates += 1;
        stats.map_bits = len;
        stats.cols = cols;
        stats.rows = rows;
        stats.cell = cell;
        stats.scale = scale;
    });
}

#[cfg(not(target_os = "windows"))]
pub fn set_hit_map(_bits: Vec<u8>, _cols: u32, _rows: u32, _cell: f32, _scale: f32) {}

/// The parts of the user interface that take the mouse, in css pixels.
#[cfg(target_os = "windows")]
pub fn set_ui_rects(rects: Vec<UiRect>) {
    let count = rects.len();
    imp::with_hit_state(|state| state.rects = rects);
    imp::with_hit_stats(|stats| stats.rects = count);
}

#[cfg(not(target_os = "windows"))]
pub fn set_ui_rects(_rects: Vec<UiRect>) {}

/// While forced the whole window reacts to the mouse. This is needed while
/// the character is dragged or the window is resized.
#[cfg(target_os = "windows")]
pub fn set_hit_force(force: bool) {
    imp::with_hit_state(|state| state.force = force);
    imp::with_hit_stats(|stats| stats.force = force);
}

#[cfg(not(target_os = "windows"))]
pub fn set_hit_force(_force: bool) {}

/// Turns the click-through on or off. When it is off the window behaves like
/// a normal window and swallows every click.
#[cfg(target_os = "windows")]
pub fn set_hit_enabled(enabled: bool) {
    imp::with_hit_state(|state| state.enabled = enabled);
    imp::with_hit_stats(|stats| stats.enabled = enabled);
}

#[cfg(not(target_os = "windows"))]
pub fn set_hit_enabled(_enabled: bool) {}

/// A snapshot of the counters, used while debugging the hit test.
pub fn hit_stats() -> HitStats {
    #[cfg(target_os = "windows")]
    {
        imp::hit_stats()
    }
    #[cfg(not(target_os = "windows"))]
    {
        HitStats::default()
    }
}

// ---------------------------------------------------------------------------
// single instance + window control
// ---------------------------------------------------------------------------

/// Tries to become the one and only instance of the app.
///
/// `Ok(true)`  - this process is the first instance, carry on.
/// `Ok(false)` - another instance is already running.
/// `Err(())`   - the mutex could not be created, carry on anyway.
#[cfg(target_os = "windows")]
pub fn acquire_single_instance(name: &str) -> Result<bool, ()> {
    unsafe { imp::create_named_mutex(name) }
}

#[cfg(not(target_os = "windows"))]
pub fn acquire_single_instance(_name: &str) -> Result<bool, ()> {
    Ok(true)
}

/// Shows or hides the window with the given title. Returns false when no such
/// window exists.
#[cfg(target_os = "windows")]
pub fn set_window_visible(title: &str, visible: bool) -> bool {
    unsafe { imp::set_window_visible_by_title(title, visible) }
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_visible(_title: &str, _visible: bool) -> bool {
    false
}

/// Flips the visibility of the window with the given title.
#[cfg(target_os = "windows")]
pub fn toggle_window(title: &str) -> bool {
    unsafe { imp::toggle_window_by_title(title) }
}

#[cfg(not(target_os = "windows"))]
pub fn toggle_window(_title: &str) -> bool {
    false
}

/// Asks the window with the given title to close.
#[cfg(target_os = "windows")]
pub fn close_window(title: &str) -> bool {
    unsafe { imp::close_window_by_title(title) }
}

#[cfg(not(target_os = "windows"))]
pub fn close_window(_title: &str) -> bool {
    false
}
