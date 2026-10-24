use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
pub struct OllamaManager {
    child: Option<Child>,
    spawned_by_us: bool,
}

impl OllamaManager {
    pub fn new() -> Self {
        Self {
            child: None,
            spawned_by_us: false,
        }
    }

    pub fn spawned_by_us(&self) -> bool {
        self.spawned_by_us && self.child.is_some()
    }

    pub fn kill_spawned(&mut self) {
        if !self.spawned_by_us {
            return;
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.spawned_by_us = false;
    }

    pub async fn ensure_running() -> bool {
        if is_ollama_up().await {
            return true;
        }
        Self::spawn_ollama()
    }

    fn spawn_ollama() -> bool {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("ollama");
            cmd.arg("serve");
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
            match cmd.spawn() {
                Ok(child) => {
                    // We can't easily store in global here without passing state,
                    // but we'll track in AppState
                    let _ = child;
                    return true;
                }
                Err(_) => return false,
            }
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("ollama");
            cmd.arg("serve");
            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
            match cmd.spawn() {
                Ok(child) => {
                    let _ = child;
                    return true;
                }
                Err(_) => false,
            }
        }
    }

    pub fn try_spawn_and_store(state_child: &Arc<Mutex<Option<Child>>>, spawned_flag: &Arc<Mutex<bool>>) -> bool {
        if tokio::runtime::Handle::try_current().is_ok() {
            // avoid blocking in async context from here; best effort
        }
        #[cfg(windows)]
        {
            let mut cmd = Command::new("ollama");
            cmd.arg("serve");
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
            match cmd.spawn() {
                Ok(child) => {
                    if let Ok(mut c) = state_child.lock() {
                        *c = Some(child);
                    }
                    if let Ok(mut f) = spawned_flag.lock() {
                        *f = true;
                    }
                    return true;
                }
                Err(_) => return false,
            }
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("ollama");
            cmd.arg("serve");
            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
            match cmd.spawn() {
                Ok(child) => {
                    if let Ok(mut c) = state_child.lock() {
                        *c = Some(child);
                    }
                    if let Ok(mut f) = spawned_flag.lock() {
                        *f = true;
                    }
                    return true;
                }
                Err(_) => false,
            }
        }
    }
}

pub async fn is_ollama_up() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Try /api/version first, fall back to /api/tags
    if let Ok(resp) = client.get("http://127.0.0.1:11434/api/version").send().await {
        if resp.status().is_success() {
            return true;
        }
    }
    if let Ok(resp) = client.get("http://127.0.0.1:11434/api/tags").send().await {
        if resp.status().is_success() {
            return true;
        }
    }
    false
}

pub fn kill_child(child: &mut Option<Child>, spawned: bool) {
    if !spawned {
        return;
    }
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}
