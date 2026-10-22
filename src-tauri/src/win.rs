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
    }

    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TRANSPARENT: isize = 0x0000_0020;

    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    pub unsafe fn get_cursor_pos() -> (i32, i32) {
        let mut point = POINT::default();
        if GetCursorPos(&mut point) == 0 {
            return (0, 0);
        }
        (point.x, point.y)
    }

    /// Toggles `WS_EX_TRANSPARENT` which makes the window fully click-through.
    pub unsafe fn set_click_through(hwnd: HWND, click_through: bool) {
        let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if click_through {
            style |= WS_EX_TRANSPARENT;
        } else {
            style &= !WS_EX_TRANSPARENT;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        // Force the frame to be recalculated so the new hit-test rules apply.
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }

    /// Builds a window region out of the given rectangles and applies it to
    /// the window. Everything outside of the region stops receiving mouse
    /// input, which is exactly what a per pixel click through needs.
    ///
    /// The rectangles are given in client coordinates (physical pixels).
    pub unsafe fn set_window_region(
        hwnd: HWND,
        rects: &[(i32, i32, i32, i32)],
    ) -> Result<(), String> {
        use windows::Win32::Foundation::HWND as Wnd;
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, HRGN, RGN_OR,
        };

        let mut region: Option<HRGN> = None;
        let mut pieces = 0usize;

        for &(x, y, w, h) in rects {
            if w <= 0 || h <= 0 {
                continue;
            }
            let piece = CreateRectRgn(x, y, x.saturating_add(w), y.saturating_add(h));
            if piece.0.is_null() {
                return Err(format!("CreateRectRgn failed for {x},{y},{w},{h}"));
            }
            pieces += 1;
            match region {
                None => region = Some(piece),
                Some(current) => {
                    let merged = CombineRgn(Some(current), Some(current), Some(piece), RGN_OR);
                    let _ = DeleteObject(HGDIOBJ(piece.0));
                    if merged.0 == 0 {
                        let _ = DeleteObject(HGDIOBJ(current.0));
                        return Err(format!("CombineRgn failed after {pieces} pieces"));
                    }
                    region = Some(current);
                }
            }
        }

        let region = region.ok_or("no rectangles given")?;

        // When this succeeds the system owns the region and frees it later.
        // Don't redraw - hit-testing only, avoids DWM stutter with WebView2.
        if SetWindowRgn(Wnd(hwnd), Some(region), false) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("SetWindowRgn failed".into());
        }
        Ok(())
    }

    /// Removes the window region, the window reacts to the mouse everywhere
    /// again.
    pub unsafe fn clear_window_region(hwnd: HWND) {
        use windows::Win32::Foundation::HWND as Wnd;
        use windows::Win32::Graphics::Gdi::SetWindowRgn;
        SetWindowRgn(Wnd(hwnd), None, false);
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

/// Enables / disables click-through for the main window.
#[cfg(target_os = "windows")]
pub fn set_click_through(hwnd_raw: isize, click_through: bool) {
    let hwnd = hwnd_raw as *mut std::ffi::c_void;
    unsafe { imp::set_click_through(hwnd, click_through) };
}

#[cfg(not(target_os = "windows"))]
pub fn set_click_through(_hwnd_raw: isize, _click_through: bool) {}

/// Makes the window only react to the mouse inside the given rectangles.
/// The rectangles are given in physical client pixels.
#[cfg(target_os = "windows")]
pub fn set_window_region(hwnd_raw: isize, rects: &[(i32, i32, i32, i32)]) -> Result<(), String> {
    let hwnd = hwnd_raw as *mut std::ffi::c_void;
    unsafe { imp::set_window_region(hwnd, rects) }
}

#[cfg(not(target_os = "windows"))]
pub fn set_window_region(
    _hwnd_raw: isize,
    _rects: &[(i32, i32, i32, i32)],
) -> Result<(), String> {
    Ok(())
}

/// Removes the window region again.
#[cfg(target_os = "windows")]
pub fn clear_window_region(hwnd_raw: isize) {
    let hwnd = hwnd_raw as *mut std::ffi::c_void;
    unsafe { imp::clear_window_region(hwnd) };
}

#[cfg(not(target_os = "windows"))]
pub fn clear_window_region(_hwnd_raw: isize) {}
