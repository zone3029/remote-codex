param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
$userData = Join-Path $env:PROGRAMDATA 'Remote Codex Agent'
$consentPath = Join-Path $userData 'computer-use-consent.json'

function Write-Result([hashtable]$Value) {
  $Value.ok = $true
  $Value.timestamp = [DateTime]::UtcNow.ToString('o')
  $Value | ConvertTo-Json -Compress -Depth 5
}

function Require-ComputerUseConsent {
  if (-not (Test-Path -LiteralPath $consentPath -PathType Leaf)) {
    throw '远端使用者尚未在 Remote Codex Agent 中开启“允许 Codex 界面控制”'
  }
  $consent = Get-Content -LiteralPath $consentPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($consent.enabled -ne $true -or -not $consent.controllerPid) {
    throw '远端界面控制授权无效'
  }
  try { $null = Get-Process -Id ([int]$consent.controllerPid) -ErrorAction Stop }
  catch { throw 'Remote Codex Agent 授权窗口已退出，请远端使用者重新开启界面控制' }
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class RemoteCodexInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static void SendUnicode(string text) {
        foreach (char value in text) {
            INPUT down = new INPUT(); down.type = 1; down.U.ki.wScan = value; down.U.ki.dwFlags = 0x0004;
            INPUT up = down; up.U.ki.dwFlags = 0x0004 | 0x0002;
            INPUT[] inputs = new INPUT[] { down, up };
            if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput failed");
        }
    }

    public static void Key(ushort virtualKey, bool down) {
        INPUT input = new INPUT(); input.type = 1; input.U.ki.wVk = virtualKey; input.U.ki.dwFlags = down ? 0u : 0x0002u;
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput failed");
    }
}
'@

if (-not ('RemoteCodexInput' -as [type])) { Add-Type -TypeDefinition $nativeSource }
[void][RemoteCodexInput]::SetProcessDPIAware()
Require-ComputerUseConsent

try {
  $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  $payload = $payloadJson | ConvertFrom-Json
} catch { throw '界面控制参数无效' }

$action = [string]$payload.action
$left = [RemoteCodexInput]::GetSystemMetrics(76)
$top = [RemoteCodexInput]::GetSystemMetrics(77)
$width = [RemoteCodexInput]::GetSystemMetrics(78)
$height = [RemoteCodexInput]::GetSystemMetrics(79)
if ($width -lt 1 -or $height -lt 1) { throw '无法读取当前交互桌面尺寸' }

function Require-Point($InputValue) {
  $x = [int]$InputValue.x
  $y = [int]$InputValue.y
  if ($x -lt $left -or $x -ge ($left + $width) -or $y -lt $top -or $y -ge ($top + $height)) {
    throw "坐标超出当前桌面范围：x=$x, y=$y"
  }
  return @($x, $y)
}

function Resolve-VirtualKey([string]$Name) {
  $upper = $Name.Trim().ToUpperInvariant()
  $keys = @{
    'BACKSPACE'=0x08; 'TAB'=0x09; 'ENTER'=0x0D; 'RETURN'=0x0D; 'ESC'=0x1B; 'ESCAPE'=0x1B; 'SPACE'=0x20
    'PAGEUP'=0x21; 'PAGEDOWN'=0x22; 'END'=0x23; 'HOME'=0x24; 'LEFT'=0x25; 'UP'=0x26; 'RIGHT'=0x27; 'DOWN'=0x28
    'INSERT'=0x2D; 'DELETE'=0x2E; 'CTRL'=0x11; 'CONTROL'=0x11; 'SHIFT'=0x10; 'ALT'=0x12; 'WIN'=0x5B; 'WINDOWS'=0x5B
    'F1'=0x70; 'F2'=0x71; 'F3'=0x72; 'F4'=0x73; 'F5'=0x74; 'F6'=0x75; 'F7'=0x76; 'F8'=0x77; 'F9'=0x78; 'F10'=0x79; 'F11'=0x7A; 'F12'=0x7B
  }
  if ($keys.ContainsKey($upper)) { return [uint16]$keys[$upper] }
  if ($upper.Length -eq 1 -and $upper[0] -match '[A-Z0-9]') { return [uint16][char]$upper[0] }
  throw "不支持的按键：$Name"
}

switch ($action) {
  'status' {
    Write-Result @{ action='status'; screen=@{ left=$left; top=$top; width=$width; height=$height }; sessionId=[string]((Get-Content -LiteralPath $consentPath -Raw | ConvertFrom-Json).sessionId) }
  }
  'screenshot' {
    Add-Type -AssemblyName System.Drawing
    $outputPath = [Environment]::ExpandEnvironmentVariables([string]$payload.outputPath)
    $fullPath = [IO.Path]::GetFullPath($outputPath)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fullPath) -notmatch '^remote-codex-computer-use-[a-f0-9-]{36}\.png$') {
      throw '截图输出路径无效'
    }
    $bitmap = New-Object Drawing.Bitmap $width, $height, ([Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object Drawing.Size $width, $height), [Drawing.CopyPixelOperation]::SourceCopy)
      $bitmap.Save($fullPath, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    $file = Get-Item -LiteralPath $fullPath
    Write-Result @{ action='screenshot'; path=$fullPath; size=[long]$file.Length; screen=@{ left=$left; top=$top; width=$width; height=$height }; format='png' }
  }
  'cleanup' {
    $fullPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$payload.path))
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fullPath) -notmatch '^remote-codex-computer-use-[a-f0-9-]{36}\.png$') { throw '清理路径无效' }
    Remove-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
    Write-Result @{ action='cleanup'; removed=$true }
  }
  'move' {
    $point = Require-Point $payload
    if (-not [RemoteCodexInput]::SetCursorPos($point[0], $point[1])) { throw '鼠标移动失败' }
    Write-Result @{ action='move'; x=$point[0]; y=$point[1] }
  }
  'click' {
    $point = Require-Point $payload
    $button = ([string]$payload.button).ToLowerInvariant()
    if (-not $button) { $button = 'left' }
    $count = [int]$payload.count
    if ($count -lt 1) { $count = 1 }
    if ($count -gt 3) { throw '点击次数必须为 1-3' }
    $flags = switch ($button) { 'left' { @(0x0002,0x0004) } 'right' { @(0x0008,0x0010) } 'middle' { @(0x0020,0x0040) } default { throw '鼠标按钮必须是 left、right 或 middle' } }
    if (-not [RemoteCodexInput]::SetCursorPos($point[0], $point[1])) { throw '鼠标移动失败' }
    for ($index = 0; $index -lt $count; $index++) {
      [RemoteCodexInput]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
      [RemoteCodexInput]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
      if ($count -gt 1) { Start-Sleep -Milliseconds 90 }
    }
    Write-Result @{ action='click'; x=$point[0]; y=$point[1]; button=$button; count=$count }
  }
  'type' {
    $text = [string]$payload.text
    if ($text.Length -gt 10000) { throw '单次输入最多 10000 个字符' }
    [RemoteCodexInput]::SendUnicode($text)
    Write-Result @{ action='type'; length=$text.Length }
  }
  'key' {
    $combination = [string]$payload.key
    $parts = @($combination.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -lt 1 -or $parts.Count -gt 5) { throw '组合键格式无效' }
    $virtualKeys = @($parts | ForEach-Object { Resolve-VirtualKey $_ })
    foreach ($virtualKey in $virtualKeys) { [RemoteCodexInput]::Key($virtualKey, $true) }
    [Array]::Reverse($virtualKeys)
    foreach ($virtualKey in $virtualKeys) { [RemoteCodexInput]::Key($virtualKey, $false) }
    Write-Result @{ action='key'; key=$combination }
  }
  'scroll' {
    $steps = [int]$payload.steps
    if ($steps -eq 0 -or [Math]::Abs($steps) -gt 20) { throw '滚轮步数必须是 -20 到 20 之间的非零整数' }
    $axis = ([string]$payload.axis).ToLowerInvariant()
    if (-not $axis) { $axis = 'vertical' }
    $flag = if ($axis -eq 'vertical') { 0x0800 } elseif ($axis -eq 'horizontal') { 0x01000 } else { throw '滚轮方向必须是 vertical 或 horizontal' }
    $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]($steps * 120)), 0)
    [RemoteCodexInput]::mouse_event($flag, 0, 0, $wheelData, [UIntPtr]::Zero)
    Write-Result @{ action='scroll'; axis=$axis; steps=$steps }
  }
  default { throw "不支持的界面控制动作：$action" }
}
