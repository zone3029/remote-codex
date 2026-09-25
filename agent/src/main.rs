use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct Config {
    server: String,
    device_id: String,
    agent_token: String,
    ca_file: Option<String>,
    allow_insecure: bool,
    poll_seconds: u64,
}

struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn main() {
    if let Err(error) = real_main() {
        eprintln!("Remote Codex Agent: {error}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str).unwrap_or("run") {
        "run" => {
            let config_path = option_value(&args, "--config")
                .map(PathBuf::from)
                .unwrap_or_else(default_config_path);
            run_agent(load_config(&config_path)?, args.iter().any(|arg| arg == "--once"))
        }
        "install" => install(&args),
        "uninstall" => uninstall(),
        "version" | "--version" | "-V" => {
            println!("remote-codex-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => Err(format!("unknown command: {other}")),
    }
}

fn print_help() {
    println!(
        "Remote Codex Agent\n\n\
         Commands:\n\
           install --server URL --device-id ID --agent-token TOKEN [--ca-file FILE]\n\
           run [--config FILE] [--once]\n\
           uninstall\n\
           version"
    );
}

fn option_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn default_config_path() -> PathBuf {
    let base = env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("RemoteCodex").join("agent.conf")
}

fn load_config(path: &Path) -> Result<Config, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut values = HashMap::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("invalid config line: {line}"))?;
        values.insert(key.trim().to_string(), value.trim().to_string());
    }
    let server = required(&values, "server")?.trim_end_matches('/').to_string();
    let allow_insecure = values
        .get("allow_insecure")
        .map(|value| value == "true")
        .unwrap_or(false);
    if !server.starts_with("https://") && !allow_insecure {
        return Err("server must use HTTPS unless allow_insecure=true".to_string());
    }
    Ok(Config {
        server,
        device_id: required(&values, "device_id")?,
        agent_token: required(&values, "agent_token")?,
        ca_file: values.get("ca_file").filter(|v| !v.is_empty()).cloned(),
        allow_insecure,
        poll_seconds: values
            .get("poll_seconds")
            .and_then(|value| value.parse().ok())
            .unwrap_or(2),
    })
}

fn required(values: &HashMap<String, String>, key: &str) -> Result<String, String> {
    values
        .get(key)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("missing config value: {key}"))
}

fn run_agent(config: Config, once: bool) -> Result<(), String> {
    ensure_curl()?;
    println!("Remote Codex Agent started for {}", config.device_id);
    loop {
        match poll(&config) {
            Ok(Some(response)) => handle_command(&config, response),
            Ok(None) => {}
            Err(error) => eprintln!("poll failed: {error}"),
        }
        if once {
            return Ok(());
        }
        thread::sleep(Duration::from_secs(config.poll_seconds.max(1)));
    }
}

fn ensure_curl() -> Result<(), String> {
    let status = Command::new("curl.exe")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "curl.exe is required (included with supported Windows 10/11 versions)".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("curl.exe is not working".to_string())
    }
}

fn poll(config: &Config) -> Result<Option<HttpResponse>, String> {
    let hostname = env::var("COMPUTERNAME").unwrap_or_else(|_| "windows".to_string());
    let url = format!(
        "{}/v1/agent/poll?device_id={}&hostname={}",
        config.server,
        url_encode(&config.device_id),
        url_encode(&hostname)
    );
    let response = curl_request(config, "POST", &url, None, &[])?;
    match response.status {
        204 => Ok(None),
        200 => Ok(Some(response)),
        401 | 403 => Err("authentication rejected by relay".to_string()),
        status => Err(format!("relay returned HTTP {status}")),
    }
}

fn handle_command(config: &Config, response: HttpResponse) {
    let id = match response.headers.get("x-command-id") {
        Some(value) => value.clone(),
        None => {
            eprintln!("relay response is missing X-Command-Id");
            return;
        }
    };
    let cwd = response
        .headers
        .get("x-cwd-base64")
        .and_then(|value| decode_base64(value).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|value| !value.is_empty());
    let timeout = response
        .headers
        .get("x-timeout-seconds")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(1, 3600);
    let command = match String::from_utf8(response.body) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("command {id} is not valid UTF-8");
            return;
        }
    };

    println!("Executing command {id}");
    let (exit_code, timed_out, output) = execute_powershell(&command, cwd.as_deref(), timeout);
    if let Err(error) = submit_result(config, &id, exit_code, timed_out, &output) {
        eprintln!("failed to submit result for {id}: {error}");
    }
}

fn execute_powershell(command: &str, cwd: Option<&str>, timeout_seconds: u64) -> (i32, bool, Vec<u8>) {
    let mut process = Command::new("powershell.exe");
    process.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-Command",
        command,
    ]);
    if let Some(directory) = cwd {
        process.current_dir(directory);
    }
    process.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return (-1, false, format!("failed to start PowerShell: {error}\n").into_bytes()),
    };

    let stdout = child.stdout.take().map(|stream| thread::spawn(move || read_capped(stream)));
    let stderr = child.stderr.take().map(|stream| thread::spawn(move || read_capped(stream)));
    let started = Instant::now();
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if started.elapsed() >= Duration::from_secs(timeout_seconds) => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break 124;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                break {
                    eprintln!("failed while waiting for PowerShell: {error}");
                    -1
                };
            }
        }
    };

    let mut output = stdout
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let error_output = stderr
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    if !error_output.is_empty() && output.len() < MAX_OUTPUT {
        output.extend_from_slice(b"\r\n[stderr]\r\n");
        output.extend_from_slice(&error_output[..error_output.len().min(MAX_OUTPUT - output.len())]);
    }
    if timed_out && output.len() < MAX_OUTPUT {
        output.extend_from_slice(b"\r\n[Remote Codex: command timed out]\r\n");
    }
    output.truncate(MAX_OUTPUT);
    (exit_code, timed_out, output)
}

fn read_capped<R: Read>(mut reader: R) -> Vec<u8> {
    let mut result = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => return result,
            Ok(count) if result.len() < MAX_OUTPUT => {
                let keep = count.min(MAX_OUTPUT - result.len());
                result.extend_from_slice(&buffer[..keep]);
            }
            Ok(_) => {}
        }
    }
}

fn submit_result(
    config: &Config,
    id: &str,
    exit_code: i32,
    timed_out: bool,
    output: &[u8],
) -> Result<(), String> {
    let url = format!("{}/v1/agent/result/{}?device_id={}", config.server, url_encode(id), url_encode(&config.device_id));
    let headers = [
        ("X-Exit-Code", exit_code.to_string()),
        ("X-Timed-Out", timed_out.to_string()),
        ("Content-Type", "application/octet-stream".to_string()),
    ];
    let response = curl_request(config, "POST", &url, Some(output), &headers)?;
    if response.status == 204 {
        Ok(())
    } else {
        Err(format!("relay returned HTTP {}", response.status))
    }
}

fn curl_request(
    config: &Config,
    method: &str,
    url: &str,
    body: Option<&[u8]>,
    headers: &[(&str, String)],
) -> Result<HttpResponse, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = env::temp_dir();
    let header_path = temp.join(format!("remote-codex-{nonce}.headers"));
    let body_path = temp.join(format!("remote-codex-{nonce}.body"));
    let upload_path = temp.join(format!("remote-codex-{nonce}.upload"));

    let mut command = Command::new("curl.exe");
    command.args([
        "--silent",
        "--show-error",
        "--connect-timeout",
        "15",
        "--max-time",
        "45",
        "--request",
        method,
        "--header",
        &format!("Authorization: Bearer {}", config.agent_token),
        "--dump-header",
    ]);
    command.arg(&header_path).arg("--output").arg(&body_path);
    if config.allow_insecure {
        command.arg("--insecure");
    } else if let Some(ca_file) = &config.ca_file {
        command.arg("--cacert").arg(ca_file);
    }
    for (name, value) in headers {
        command.arg("--header").arg(format!("{name}: {value}"));
    }
    if let Some(bytes) = body {
        fs::write(&upload_path, bytes).map_err(|error| error.to_string())?;
        command.arg("--data-binary").arg(format!("@{}", upload_path.display()));
    }
    command.arg("--write-out").arg("%{http_code}").arg(url);
    let result = command.output().map_err(|error| format!("cannot run curl.exe: {error}"));
    let status_text = result
        .as_ref()
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    let error_text = result
        .as_ref()
        .map(|output| String::from_utf8_lossy(&output.stderr).to_string())
        .unwrap_or_default();
    let header_bytes = fs::read(&header_path).unwrap_or_default();
    let response_body = fs::read(&body_path).unwrap_or_default();
    let _ = fs::remove_file(header_path);
    let _ = fs::remove_file(body_path);
    let _ = fs::remove_file(upload_path);
    result.map_err(|error| error.to_string())?;
    let status = status_text
        .trim()
        .parse::<u16>()
        .map_err(|_| format!("curl request failed: {error_text}"))?;
    Ok(HttpResponse {
        status,
        headers: parse_headers(&header_bytes),
        body: response_body,
    })
}

fn parse_headers(bytes: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(bytes);
    let last_block = text
        .split("\r\n\r\n")
        .filter(|block| block.starts_with("HTTP/"))
        .last()
        .unwrap_or(&text);
    last_block
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn url_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for byte in value.bytes().filter(|byte| *byte != b'=') {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("invalid base64".to_string()),
        };
        accumulator = (accumulator << 6) | u32::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Ok(output)
}

#[cfg(windows)]
fn install(args: &[String]) -> Result<(), String> {
    let server = option_value(args, "--server").ok_or("--server is required")?;
    let device_id = option_value(args, "--device-id").ok_or("--device-id is required")?;
    let agent_token = option_value(args, "--agent-token").ok_or("--agent-token is required")?;
    let ca_file = option_value(args, "--ca-file");
    let allow_insecure = args.iter().any(|arg| arg == "--allow-insecure");
    if !server.starts_with("https://") && !allow_insecure {
        return Err("--server must use HTTPS".to_string());
    }

    let directory = default_config_path()
        .parent()
        .ok_or("invalid ProgramData path")?
        .to_path_buf();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let installed_exe = directory.join("remote-codex-agent.exe");
    let current_exe = env::current_exe().map_err(|error| error.to_string())?;
    if current_exe != installed_exe {
        fs::copy(&current_exe, &installed_exe).map_err(|error| error.to_string())?;
    }
    let config_path = directory.join("agent.conf");
    let config = format!(
        "server={}\ndevice_id={}\nagent_token={}\nca_file={}\nallow_insecure={}\npoll_seconds=2\n",
        server.trim_end_matches('/'),
        device_id,
        agent_token,
        ca_file.unwrap_or_default(),
        allow_insecure
    );
    fs::write(&config_path, config).map_err(|error| error.to_string())?;

    let task_command = format!(
        "\"{}\" run --config \"{}\"",
        installed_exe.display(),
        config_path.display()
    );
    let status = Command::new("schtasks.exe")
        .args([
            "/Create",
            "/TN",
            "RemoteCodexAgent",
            "/SC",
            "ONLOGON",
            "/RL",
            "LIMITED",
            "/TR",
            &task_command,
            "/F",
        ])
        .status()
        .map_err(|error| format!("cannot create scheduled task: {error}"))?;
    if !status.success() {
        return Err("schtasks.exe failed; run the installer from an Administrator terminal".to_string());
    }
    let _ = Command::new("schtasks.exe")
        .args(["/Run", "/TN", "RemoteCodexAgent"])
        .status();
    println!("Installed Remote Codex Agent for device {device_id}");
    Ok(())
}

#[cfg(not(windows))]
fn install(_: &[String]) -> Result<(), String> {
    Err("install is only supported on Windows".to_string())
}

#[cfg(windows)]
fn uninstall() -> Result<(), String> {
    let _ = Command::new("schtasks.exe")
        .args(["/Delete", "/TN", "RemoteCodexAgent", "/F"])
        .status();
    println!("Scheduled task removed. ProgramData files were retained for recovery.");
    Ok(())
}

#[cfg(not(windows))]
fn uninstall() -> Result<(), String> {
    Err("uninstall is only supported on Windows".to_string())
}
