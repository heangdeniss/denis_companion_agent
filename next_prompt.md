Please write the Rust process manager in `src-tauri` and connect the frontend polling state hook. Please implement an auto-spawn and auto-connect lifecycle for our local LLM server (Ollama) in the Tauri backend:

### 1. Auto-Start LLM Server on App Launch (`src-tauri`):
- In `src-tauri/src/main.rs` (or setup hook `tauri::Builder::default().setup(...)`):
  * Check if the LLM server is already responding on `http://127.0.0.1:11434` (e.g., via a fast health check `GET http://127.0.0.1:11434/api/version`).
  * If NOT running, automatically spawn the server process in the background:
    - On Windows, run `ollama serve` (hidden/no-window flag: `CREATE_NO_WINDOW` via `std::os::windows::process::CommandExt`) so no stray command prompt window pops up.
  * Store the spawned child process handle in the Tauri app state so it can be managed cleanly.

### 2. Auto-Polling / Reconnect on Frontend:
- On app launch, have the frontend poll `http://localhost:11434` with exponential backoff / retry (e.g., every 500ms for up to 10 seconds) until the server is ready.
- Update the status label in the UI header:
  * While starting: "Starting LLM server..."
  * Once online: "Connected to ollama (<model_name>)"
  * If startup fails: "Failed to connect to LLM server. Click to retry."

### 3. Graceful Auto-Shutdown on Exit:
- When the user selects "Quit Ei Waifu" from the context menu or closes the window:
  * If the app originally spawned the Ollama process, terminate/kill the child process cleanly so no orphan background server processes linger.

Please write the Rust process manager in `src-tauri` and connect the frontend polling state hook.