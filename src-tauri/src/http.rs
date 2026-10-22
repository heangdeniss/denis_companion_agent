//! A tiny loopback-only HTTP server that exposes the models directory.
//!
//! The Live2D plugin resolves relative resource paths (moc3, textures,
//! motions, ...) with node's legacy `url.resolve`, which mangles `blob:` and
//! `data:` URLs. Serving the models over plain HTTP keeps the resolution
//! rules intact and works both in dev and in a packaged build.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, PathBuf};
use std::thread;
use std::time::Duration;

pub fn start(root: PathBuf) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();

    thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    let root = root.clone();
                    thread::spawn(move || {
                        let _ = handle(stream, root);
                    });
                }
                Err(_) => break,
            }
        }
    });

    Ok(port)
}

fn handle(mut stream: TcpStream, root: PathBuf) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }

    // Drain the headers.
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line.trim().is_empty() {
            break;
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_uppercase();
    let target = parts.next().unwrap_or("/").to_string();

    if method == "OPTIONS" {
        return respond(&mut stream, 204, "text/plain", &[]);
    }

    let path = target.split('?').next().unwrap_or("/");
    let decoded = percent_decode(path);
    let relative = decoded.trim_start_matches('/');

    let Some(safe) = safe_relative_path(&relative) else {
        return respond(&mut stream, 403, "text/plain", b"forbidden");
    };

    let full = root.join(safe);
    if !full.is_file() {
        return respond(&mut stream, 404, "text/plain", b"not found");
    }

    let mut data = Vec::new();
    if File::open(&full)?.read_to_end(&mut data).is_err() {
        return respond(&mut stream, 500, "text/plain", b"read error");
    }

    let mime = mime_for(&full);
    respond(&mut stream, 200, mime, &data)
}

use std::fs::File;

fn respond(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };

    let header = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        status,
        reason,
        mime,
        body.len()
    );

    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// Rejects anything that tries to escape the served root.
fn safe_relative_path(input: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(input);
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_for(path: &PathBuf) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "moc3" | "moc" => "application/octet-stream",
        "mtn" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}
