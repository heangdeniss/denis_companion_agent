//! Small Win32 helpers implemented with raw FFI so that we never have to
//! care about which version of the `windows` crate tauri happens to depend on.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

#[cfg(target_os = "windows")]
mod imp {
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
