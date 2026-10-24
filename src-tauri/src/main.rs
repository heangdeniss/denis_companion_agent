// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn main() {
    // Quick check and auto-start Ollama silently on Windows
    std::thread::spawn(|| {
        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let up = client
            .get("http://127.0.0.1:11434/api/version")
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
            || client
                .get("http://127.0.0.1:11434/api/tags")
                .send()
                .map(|r| r.status().is_success())
                .unwrap_or(false);
        if !up {
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let _ = std::process::Command::new("ollama")
                    .arg("serve")
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("ollama")
                    .arg("serve")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
        }
    });

    ei_waifu_lib::run()
}
