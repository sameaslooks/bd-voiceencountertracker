/**
 * VoiceEncounterTracker Overlay
 */

const {
    app, BrowserWindow, screen, globalShortcut, Tray, Menu,
    nativeImage, shell, desktopCapturer, ipcMain, clipboard
} = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

// ─── Chromium flags: kill occlusion detection + background throttling ───
app.commandLine.appendSwitch("disable-features",
    "CalculateNativeWinOcclusion,CalculateNativeWinOcclusionOnScreen");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-ipc-flooding-protection");

// ─── Window geometry ───
const WINDOW_WIDTH   = 280;
const MAX_HEIGHT     = 600;
const OPACITY        = 1.0;
const MARGIN_RIGHT   = 20;
const MARGIN_TOP     = 20;

const CHROME_HEIGHT  = 34;
const HEIGHT_OFFLINE   = 78;
const HEIGHT_IDLE      = 66;   // same as one user in voice (CHROME_HEIGHT + ROW_HEIGHT)
const HEIGHT_EMPTY_VC  = 60;
const ROW_HEIGHT       = 32;
const CARD_HEIGHT      = 40;
const NOTE_HEIGHT      = 34;

const NET_BANNER_HEIGHT = 30;

const PORT = 17842;
const PLUGIN_STALE_MS = 30000;
const MONITOR_RETRY_MS = 30_000;

// ─── Network quality thresholds ───
const NET = {
    UNSTABLE_LAST_MS:     200,
    UNSTABLE_AVG_MS:      200,
    UNSTABLE_ACCUM_MS:    5000,
    CRITICAL_LAST_MS:     1000,
    CRITICAL_ACCUM_MS:    3000,
    LOST_LAST_MS:         5000,
    UNSTABLE_HOLD_MS:     10000,
    CRITICAL_HOLD_MS:     10000,
    LOST_HOLD_MS:         3000,
    STALE_PING_MS:        2000
};

// ─── Click-through / cursor / fullscreen state ───
const CURSOR_CHECK_MS     = 300;
const CURSOR_STABLE_TICKS = 1;

// Fullscreen detection tolerance — DWM может давать rect чуть больше монитора
// (невидимые рамки окна). Позволяем разницу вплоть до 2 px по каждой стороне.
const FULLSCREEN_TOLERANCE_PX = 2;

let _clickThroughState  = false;
let _cachedCursorState  = { showing: true, at: 0 };
let _cachedFgState      = { hwnd: 0, pid: 0, cursorShowing: 1, rect: null, at: 0 };
let _cursorStableCount  = 0;
let _cursorStableValue  = true;

// ─── Shared state ───
let state = {
    updatedAt: 0,
    guildId: null,
    channelId: null,
    channelName: null,
    guildName: null,
    users: [],
    prefs: {},
    streamSound: null
};

let speaking = { speakers: [] };
let lastPluginSeen = 0;

let pingState = {
    last: null,
    avg: null,
    updatedAt: 0
};

let netMachine = {
    level: "ok",
    since: 0,
    totalSince: 0,
    lastHighSince: 0,
    lastCriticalSince: 0,
    holds: { unstable: 0, critical: 0, lost: 0 },
    queue: []
};

let commandQueue = [];
let nextCommandId = 1;

let tray = null;
let server = null;

// ─── SSE (server-sent events) ───
const sseClients = new Set();

function sseSend(res, event, data) {
    try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); }
    catch (e) { sseClients.delete(res); }
}

function sseBroadcast(event, data) {
    if (sseClients.size === 0) return;
    for (const res of sseClients) sseSend(res, event, data);
}

// ─── Command long-poll waiters ───
const commandWaiters = new Set();

function flushCommandWaiters() {
    if (commandWaiters.size === 0 || commandQueue.length === 0) return;
    // Hand the whole queue to one waiting poller (normally there is exactly one plugin)
    const waiter = commandWaiters.values().next().value;
    commandWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    const pending = commandQueue;
    commandQueue = [];
    try { jsonReply(waiter.res, 200, { commands: pending }); } catch (e) {}
}

function broadcastState() {
    if (sseClients.size === 0) return;
    try { sseBroadcast("state", buildStateResponse()); } catch (e) {}
}
let isQuitting = false;
let lastAliveState = false;

const windows = new Map();
const waitingWindows = new Map();
let popupWindow = null;
// Stream viewers, one window each. Key: a streamer's user id, "cam:<id>" for a
// camera, "local:<id>" for my own stream captured locally, "own:<id>" for my
// own stream from Discord; with an overlay instance id appended ("@<inst>").
const viewers = new Map();
const notifyWindows = new Map();   // overlay id -> { win, contentH, typing }
let menuWindow = null;
let tipWindow = null;
let senderWindow = null;

let _webrtcIceForSender = [];
let _webrtcIceForReceiver = [];

let _videoAlpha = 1.0;

let _saveWindowsTimer = null;
let _monitorRetryTimer = null;
let _retryScheduled = false;

// =====================================================================
// windows.json
// =====================================================================

function windowsFile() {
    return path.join(app.getPath("userData"), "windows.json");
}

function loadWindowsConfig() {
    try {
        const parsed = readJsonSafe(windowsFile());
        if (parsed && Array.isArray(parsed.windows)) return parsed.windows;
    } catch (e) {}
    return [];
}

function saveWindowsConfig(list) {
    try {
        const data = { version: 1, windows: list };
        writeJsonAtomic(windowsFile(), data);
    } catch (e) {
        console.error("[windows.json] save failed:", e.message);
    }
}

function scheduleSaveWindows() {
    if (_saveWindowsTimer) clearTimeout(_saveWindowsTimer);
    _saveWindowsTimer = setTimeout(() => {
        _saveWindowsTimer = null;
        const list = [];
        for (const rec of windows.values()) {
            list.push({
                id: rec.id,
                monitor: rec.monitor,
                x: rec.x,
                y: rec.y,
                width: rec.width,
                height: rec.height
            });
        }
        for (const rec of waitingWindows.values()) list.push(rec);
        saveWindowsConfig(list);
    }, 500);
}

// Write via temp file + rename so a crash mid-write never leaves a broken file;
// the previous version is kept as <file>.bak.
function writeJsonAtomic(file, data) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch (e) {}
    fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
    for (const f of [file, file + ".bak"]) {
        try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
    }
    return null;
}

function settingsFile() {
    return path.join(app.getPath("userData"), "settings.json");
}

let settings = {
    preferredSourceId: "screen:0:0",
    preferredSourceName: null,
    streamSound: true,
    clickThroughOnGameFocus: true
};

function loadSettings() {
    try {
        const parsed = readJsonSafe(settingsFile());
        if (parsed && typeof parsed === "object") {
            settings = Object.assign(settings, parsed);
        }
    } catch (e) {}
}

let _saveSettingsTimer = null;
function saveSettingsSoon() {
    if (_saveSettingsTimer) clearTimeout(_saveSettingsTimer);
    _saveSettingsTimer = setTimeout(() => { _saveSettingsTimer = null; saveSettings(); }, 400);
}

function saveSettings() {
    try {
        writeJsonAtomic(settingsFile(), settings);
    } catch (e) {
        console.error("[settings.json] save failed:", e.message);
    }
}

// =====================================================================
// Cursor + foreground window check (single PowerShell call)
// =====================================================================

// One long-lived PowerShell process prints the foreground/cursor state every
// FG_POLL_MS. Spawning PowerShell (and compiling Add-Type) per check took
// over a second and timed out under load (e.g. while a stream was decoding),
// leaving the click-through state stale.
const FG_POLL_MS = 150;
let _fgProc = null;
let _fgBuf = "";

function parseFgLine(raw) {
    const parts = String(raw || "").trim().split("|");
    if (parts.length !== 8) return;
    const [hwnd, pid, cursorShowing, l, t, r, b, clipped] = parts.map(Number);
    if (![hwnd, pid, cursorShowing, l, t, r, b, clipped].every(Number.isFinite)) return;
    _cachedFgState = {
        hwnd, pid, cursorShowing, clipped: clipped === 1,
        rect: { x: l, y: t, width: r - l, height: b - t },
        at: Date.now()
    };
}

function startFgProbe() {
    if (_fgProc) return;
    const ps = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VetFg {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public int ptX;
        public int ptY;
    }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static string GetInfo() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);

        RECT r;
        GetWindowRect(hwnd, out r);

        CURSORINFO ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(ci);
        GetCursorInfo(ref ci);
        int cursorShowing = (ci.flags & 1) != 0 ? 1 : 0;

        // Games lock the cursor to their window (ClipCursor); a clip rect smaller
        // than the virtual screen means the mouse is captured.
        RECT c;
        int clipped = 0;
        if (GetClipCursor(out c)) {
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
            int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            if (c.Left > vx || c.Top > vy || c.Right < vx + vw || c.Bottom < vy + vh) clipped = 1;
        }

        return hwnd.ToInt64() + "|" + pid + "|" + cursorShowing + "|"
             + r.Left + "|" + r.Top + "|" + r.Right + "|" + r.Bottom + "|" + clipped;
    }
}
"@
while ($true) {
    [Console]::Out.WriteLine([VetFg]::GetInfo())
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds ${FG_POLL_MS}
}
`.trim();
    try {
        const encoded = Buffer.from(ps, "utf16le").toString("base64");
        _fgProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { _fgProc = null; return; }
    _fgProc.stdout.setEncoding("utf8");
    _fgProc.stdout.on("data", (chunk) => {
        _fgBuf += chunk;
        const lines = _fgBuf.split(/\r?\n/);
        _fgBuf = lines.pop();
        if (lines.length) parseFgLine(lines[lines.length - 1]);
    });
    const restart = () => {
        _fgProc = null;
        _fgBuf = "";
        setTimeout(startFgProbe, 1000);
    };
    _fgProc.on("exit", restart);
    _fgProc.on("error", () => {});
}

function stopFgProbe() {
    if (!_fgProc) return;
    const p = _fgProc;
    _fgProc = null;
    p.removeAllListeners("exit");
    try { p.kill(); } catch (e) {}
}

function checkForegroundAndCursor() {
    startFgProbe();
    return Promise.resolve(_cachedFgState);
}

// Проверяет, покрывает ли rect активного окна bounds одного из мониторов
// (с допуском FULLSCREEN_TOLERANCE_PX на каждую сторону).
function rectCoversAnyMonitor(rect) {
    if (!rect) return false;
    const displays = screen.getAllDisplays();
    const T = FULLSCREEN_TOLERANCE_PX;
    for (const d of displays) {
        const b = d.bounds;
        const coversX = rect.x <= b.x + T && rect.x + rect.width  >= b.x + b.width  - T;
        const coversY = rect.y <= b.y + T && rect.y + rect.height >= b.y + b.height - T;
        if (coversX && coversY) return true;
    }
    return false;
}

function setClickThrough(enabled) {
    if (_clickThroughState === enabled) return;
    _clickThroughState = enabled;
    console.log("[click-through]", enabled ? "ON" : "OFF");
    videoLog("[click-through]", enabled ? "ON" : "OFF");

    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        try {
            rec.win.setIgnoreMouseEvents(enabled, { forward: false });
        } catch (e) {}
        try {
            rec.win.webContents.executeJavaScript(
                `document.body.classList.toggle("click-through", ${enabled});`
            ).catch(() => {});
        } catch (e) {}
    }
    applyVideoClickThrough();
    applyNotifyClickThrough();
}

// The stream viewer follows the same state: while the overlay is dimmed the
// mouse must not hover or click it either.
function applyVideoClickThrough() {
    for (const v of viewers.values()) {
        if (!v.win || v.win.isDestroyed()) continue;
        try { v.win.setIgnoreMouseEvents(_clickThroughState, { forward: false }); } catch (e) {}
        try { v.win.setFocusable(!_clickThroughState); } catch (e) {}
    }
}

let _lastFgSig = "";
function startCursorWatchdog() {
    setInterval(async () => {
        try {
            if (setupMode) {
                if (_clickThroughState) setClickThrough(false);
                _cursorStableCount = 0;
                return;
            }
            if (!settings.clickThroughOnGameFocus) {
                if (_clickThroughState) setClickThrough(false);
                _cursorStableCount = 0;
                return;
            }

            const info = await checkForegroundAndCursor();
            // Our own windows (stream viewer, overlay) in the foreground say nothing
            // about the game: keep the current state instead of turning it off.
            const own = info.pid === process.pid;
            const cursorHidden = info.cursorShowing === 0;
            const isFullscreen = rectCoversAnyMonitor(info.rect);
            const sig = `pid=${info.pid} own=${own} cursorHidden=${cursorHidden} fullscreen=${isFullscreen} clipped=${!!info.clipped} rect=${JSON.stringify(info.rect)}`;
            if (sig !== _lastFgSig) { _lastFgSig = sig; videoLog("[click-through check]", sig, "state=" + _clickThroughState); }
            if (own) return;
            // A game = the app owns the mouse (cursor hidden) and is fullscreen or
            // has the cursor locked to it. A maximized browser is not a game.
            noteForegroundForProfiles(info.pid, cursorHidden && (isFullscreen || !!info.clipped));

            // Click-through (any voice/stream state) when the cursor is hidden AND
            // a game owns the mouse: the foreground window covers a monitor, or
            // the cursor is clipped to it (windowed/borderless games). A cursor
            // hidden by a video player or while typing alone doesn't count.
            const fresh = Date.now() - info.at < 2000;
            const wantClickThrough = fresh && cursorHidden && (isFullscreen || !!info.clipped);

            if (wantClickThrough === _cursorStableValue) {
                _cursorStableCount++;
            } else {
                _cursorStableValue = wantClickThrough;
                _cursorStableCount = 1;
            }

            if (_cursorStableCount >= CURSOR_STABLE_TICKS) {
                if (_clickThroughState !== _cursorStableValue) {
                    setClickThrough(_cursorStableValue);
                }
                _cursorStableCount = CURSOR_STABLE_TICKS;
            }
        } catch (e) {}
    }, CURSOR_CHECK_MS);
}

// =====================================================================
// Sources cache
// =====================================================================

let cachedSources = [];
let cachedSourcesAt = 0;
const SOURCES_TTL_MS = 5000;

let _cachedMonitorHandles = null;
let _cachedMonitorHandlesAt = 0;
const MONITOR_HANDLES_TTL_MS = 30_000;

function getNativeMonitorHandles() {
    const now = Date.now();
    if (_cachedMonitorHandles && (now - _cachedMonitorHandlesAt) < MONITOR_HANDLES_TTL_MS) {
        return Promise.resolve(_cachedMonitorHandles);
    }
    return new Promise((resolve) => {
        const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VetMon {
    [DllImport("user32.dll")]
    public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static void Enum() {
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr d) => {
            Console.WriteLine(hMon.ToInt64() + "|" + r.Left + "|" + r.Top + "|" + r.Right + "|" + r.Bottom);
            return true;
        }, IntPtr.Zero);
    }
}
"@
[VetMon]::Enum()
        `.trim();

        execFile("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true }, (err, stdout) => {
            if (err) { console.error("[monitors] failed:", err.message); return resolve([]); }
            const lines = String(stdout || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const result = [];
            for (const line of lines) {
                const parts = line.split("|").map(Number);
                if (parts.length !== 5) continue;
                const [h, l, t, r, b] = parts;
                if (![h, l, t, r, b].every(Number.isFinite)) continue;
                result.push({ hMonitor: h, bounds: { x: l, y: t, width: r - l, height: b - t } });
            }
            _cachedMonitorHandles = result;
            _cachedMonitorHandlesAt = Date.now();
            resolve(result);
        });
    });
}

function prettyAppName(exeName) {
    if (!exeName) return "";
    let name = exeName.replace(/\.exe$/i, "");
    name = name.replace(/[-_]+/g, " ");
    name = name.replace(/\b\w/g, c => c.toUpperCase());
    return name;
}

function getWindowProcessInfo(hwnds) {
    return new Promise((resolve) => {
        if (!Array.isArray(hwnds) || !hwnds.length) return resolve({});
        const list = hwnds.join(",");
        const ps = `
$hwnds = @(${list})
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VetWin {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder buf, ref uint size);
}
"@
Add-Type $sig
foreach ($h in $hwnds) {
    try {
        $hwnd = [IntPtr]$h
        $procId = 0
        [VetWin]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
        if ($procId -eq 0) { Write-Output "$h|0|"; continue }
        $proc = [VetWin]::OpenProcess(0x1000, $false, $procId)
        if ($proc -eq [IntPtr]::Zero) { Write-Output "$h|$procId|"; continue }
        $sb = New-Object System.Text.StringBuilder 1024
        $size = [uint32]1024
        $ok = [VetWin]::QueryFullProcessImageName($proc, 0, $sb, [ref]$size)
        [VetWin]::CloseHandle($proc) | Out-Null
        if ($ok) { Write-Output "$h|$procId|$($sb.ToString())" }
        else { Write-Output "$h|$procId|" }
    } catch { Write-Output "$h|0|" }
}
        `.trim();

        execFile("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-OutputFormat", "Text", "-Command", ps
        ], { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (err, stdout) => {
            if (err) { console.error("[window-proc] failed:", err.message); return resolve({}); }
            const result = {};
            const raw = String(stdout || "");
            const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const parts = line.split("|");
                if (parts.length < 3) continue;
                const hwnd = Number(parts[0]);
                const pid = Number(parts[1]);
                const exePath = parts.slice(2).join("|").trim();
                if (!Number.isFinite(hwnd)) continue;
                result[hwnd] = {
                    pid: Number.isFinite(pid) ? pid : 0,
                    exePath: exePath || "",
                    exeName: exePath ? exePath.split(/[\\/]/).pop() : ""
                };
            }
            resolve(result);
        });
    });
}

// Top-level app windows as Windows sees them, including minimized ones that
// Chromium's desktopCapturer leaves out (borderless "fullscreen" games that
// minimize on Alt+Tab). Discord itself captures by HWND, so these work.
function enumerateTopWindows() {
    return new Promise((resolve) => {
        const ps = `
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VetEnum {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    public static string List() {
        var sb = new StringBuilder();
        EnumWindows((h, l) => {
            // Same rule Windows uses for the taskbar: visible, not cloaked, and
            // either WS_EX_APPWINDOW, or unowned and neither WS_EX_TOOLWINDOW
            // nor WS_EX_NOACTIVATE. Frame, size and transparency don't matter,
            // so borderless games that fully minimize still count.
            if (!IsWindowVisible(h)) return true;
            int ex = GetWindowLong(h, -20);
            bool appWindow = (ex & 0x40000) != 0;
            bool owned = GetWindow(h, 4) != IntPtr.Zero;
            if (!appWindow && (owned || (ex & 0x80) != 0 || (ex & 0x08000000) != 0)) return true;
            // Layered + WS_EX_TRANSPARENT = the mouse goes through it: an
            // on-screen overlay (Medal, FPS counters...), never an app window.
            if ((ex & 0x80000) != 0 && (ex & 0x20) != 0) return true;
            int cloaked = 0;
            DwmGetWindowAttribute(h, 14, out cloaked, 4);
            if (cloaked != 0) return true;                                 // hidden UWP / other desktop
            var t = new StringBuilder(512);
            GetWindowText(h, t, 512);
            if (t.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            sb.Append(h.ToInt64()).Append('|').Append(pid).Append('|').Append(IsIconic(h) ? 1 : 0)
              .Append('|').Append(t.ToString().Replace((char)13, ' ').Replace((char)10, ' ')).Append((char)10);
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }
}
"@
Add-Type $sig
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[VetEnum]::List()
        `.trim();
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
            { windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 8000 },
            (err, stdout) => {
                if (err) { resolve([]); return; }
                const out = [];
                for (const line of String(stdout || "").split(/\r?\n/)) {
                    const m = /^(\d+)\|(\d+)\|([01])\|(.*)$/.exec(line.trim());
                    if (m) out.push({ hwnd: Number(m[1]), pid: Number(m[2]), iconic: m[3] === "1", title: m[4] });
                }
                resolve(out);
            });
    });
}

async function refreshSources(force = false) {
    const now = Date.now();
    if (!force && now - cachedSourcesAt < SOURCES_TTL_MS) return cachedSources;
    try {
        const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false
        });
        const displays = screen.getAllDisplays();
        const nativeMonitors = await getNativeMonitorHandles();

        // Chromium drops minimized windows (and some fullscreen games while
        // minimized) from getSources. Keep windows seen earlier as long as their
        // HWND still belongs to a live process.
        const freshIds = new Set(sources.map(s => s.id));
        const carried = cachedSources.filter(c => c.type === "window" && !freshIds.has(c.id));
        const hwnds = sources.map(s => /^window:(\d+):/.exec(s.id)?.[1]).filter(Boolean).map(Number);
        for (const c of carried) {
            const m = /^window:(\d+):/.exec(c.id);
            if (m) hwnds.push(Number(m[1]));
        }
        // Only windows that have a taskbar button (what Discord's own picker
        // shows). If the enumeration failed, don't filter at all.
        const taskbarWins = await enumerateTopWindows();
        const onTaskbar = taskbarWins.length ? new Set(taskbarWins.map(w => w.hwnd)) : null;
        const hwndOf = (id) => Number(/^window:(\d+):/.exec(id)?.[1] || 0);
        if (onTaskbar) {
            for (let i = sources.length - 1; i >= 0; i--) {
                if (sources[i].id.startsWith("window:") && !onTaskbar.has(hwndOf(sources[i].id))) sources.splice(i, 1);
            }
            for (let i = carried.length - 1; i >= 0; i--) {
                if (!onTaskbar.has(hwndOf(carried[i].id))) carried.splice(i, 1);
            }
        }
        // Windows Chromium didn't list (minimized and the like)
        const seenHwnd = new Set(hwnds);
        const extra = taskbarWins.filter(w => !seenHwnd.has(w.hwnd) && w.pid !== process.pid);
        for (const w of extra) hwnds.push(w.hwnd);
        const windowProcMap = await getWindowProcessInfo(hwnds);

        const hMonitorForDisplay = (display) => {
            const b = display.bounds;
            for (const m of nativeMonitors) {
                if (m.bounds.x === b.x && m.bounds.y === b.y &&
                    m.bounds.width === b.width && m.bounds.height === b.height) {
                    return m.hMonitor;
                }
            }
            return null;
        };

        cachedSources = sources.map(s => {
            if (s.id.startsWith("window:")) {
                let hwnd = 0;
                const m = /^window:(\d+):/.exec(s.id);
                if (m) hwnd = Number(m[1]);
                const proc = hwnd ? windowProcMap[hwnd] : null;
                const appName = proc && proc.exeName ? prettyAppName(proc.exeName) : (s.name || s.id);
                return {
                    id: s.id, name: s.name, label: s.name, appName,
                    pid: proc?.pid ?? 0, exePath: proc?.exePath ?? "",
                    type: "window", display_id: s.display_id, handle: null
                };
            }
            let display = null;
            if (s.display_id) display = displays.find(d => String(d.id) === String(s.display_id)) || null;
            if (!display) {
                const m = /^screen:(\d+):/.exec(s.id);
                if (m) {
                    const idx = Number(m[1]);
                    if (Number.isFinite(idx) && displays[idx]) display = displays[idx];
                }
            }
            const handle = display ? hMonitorForDisplay(display) : null;
            let label = null;
            if (display && display.label && display.label.trim()) label = display.label.trim();
            if (!label && display) {
                const idx = displays.indexOf(display);
                const b = display.bounds;
                label = `Display ${idx + 1} · ${b.width}×${b.height}`;
            }
            if (!label) label = s.name || s.id;
            return {
                id: s.id, name: s.name, label, type: "screen",
                display_id: s.display_id, handle
            };
        });

        const listed = new Set(cachedSources.map(c => c.id));
        for (const c of carried) {
            const m = /^window:(\d+):/.exec(c.id);
            const proc = m ? windowProcMap[Number(m[1])] : null;
            if (proc && proc.pid > 0) { cachedSources.push(c); listed.add(c.id); }
        }
        for (const w of extra) {
            const id = `window:${w.hwnd}:0`;
            if (listed.has(id)) continue;
            const proc = windowProcMap[w.hwnd];
            const exe = proc && proc.exeName ? proc.exeName : "";
            // Skip shell/system leftovers that Chromium also hides on purpose.
            if (/^(TextInputHost|ShellExperienceHost|SystemSettings|ApplicationFrameHost)\.exe$/i.test(exe)) continue;
            cachedSources.push({
                id, name: w.title, label: w.title,
                appName: exe ? prettyAppName(exe) : w.title,
                pid: proc?.pid ?? w.pid, exePath: proc?.exePath ?? "",
                type: "window", display_id: "", handle: null, minimized: w.iconic
            });
            listed.add(id);
        }

        cachedSourcesAt = now;
    } catch (e) {
        console.error("[sources] refresh failed:", e.message);
    }
    return cachedSources;
}

// =====================================================================
// Monitor matching
// =====================================================================

function findMonitorFor(saved, displays) {
    if (!displays.length || !saved || !saved.monitor) return null;
    const m = saved.monitor;
    if (m.electronId != null) {
        const hit = displays.find(d => d.id === m.electronId);
        if (hit) return hit;
    }
    if (m.label) {
        const hits = displays.filter(d => d.label === m.label);
        if (hits.length === 1) return hits[0];
    }
    if (m.label && m.bounds) {
        const hit = displays.find(d =>
            d.label === m.label &&
            d.bounds.x === m.bounds.x && d.bounds.y === m.bounds.y &&
            d.bounds.width === m.bounds.width && d.bounds.height === m.bounds.height
        );
        if (hit) return hit;
    }
    if (m.label && m.bounds) {
        const hits = displays.filter(d =>
            d.label === m.label &&
            d.bounds.width === m.bounds.width && d.bounds.height === m.bounds.height
        );
        if (hits.length === 1) return hits[0];
    }
    if (m.bounds) {
        const hit = displays.find(d =>
            d.bounds.x === m.bounds.x && d.bounds.y === m.bounds.y &&
            d.bounds.width === m.bounds.width && d.bounds.height === m.bounds.height
        );
        if (hit) return hit;
    }
    if (m.bounds) {
        const hits = displays.filter(d =>
            d.bounds.width === m.bounds.width && d.bounds.height === m.bounds.height
        );
        if (hits.length === 1) return hits[0];
    }
    return null;
}

function displayToMonitorRecord(display) {
    return {
        electronId: display.id,
        label: display.label || "",
        bounds: {
            x: display.bounds.x, y: display.bounds.y,
            width: display.bounds.width, height: display.bounds.height
        },
        scaleFactor: display.scaleFactor
    };
}

function monitorForWindow(win) {
    try {
        const [wx, wy] = win.getPosition();
        const [ww, wh] = win.getSize();
        const cx = wx + Math.floor(ww / 2);
        const cy = wy + Math.floor(wh / 2);
        const displays = screen.getAllDisplays();
        for (const d of displays) {
            const b = d.bounds;
            if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) return d;
        }
    } catch (e) {}
    return null;
}

// =====================================================================
// HTTP server
// =====================================================================

function jsonReply(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise(resolve => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => resolve(body));
    });
}

function startServer() {
    const HTML_FILE = path.join(__dirname, "overlay.html");

    server = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

        const url = req.url.split("?")[0];

        if (req.method === "GET" && url === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });
            res.write("retry: 1000\n\n");
            sseClients.add(res);
            try { sseSend(res, "state", buildStateResponse()); } catch (e) {}
            sseSend(res, "speaking", speaking);
            req.on("close", () => sseClients.delete(res));
            return;
        }

        if (req.method === "GET" && url === "/sources") {
            try {
                const sources = cachedSources;
                const now = Date.now();
                if (now - cachedSourcesAt >= SOURCES_TTL_MS) refreshSources(true).catch(() => {});
                const liveSound = (typeof state.streamSound === "boolean")
                    ? state.streamSound
                    : (settings.streamSound !== false);
                jsonReply(res, 200, {
                    sources,
                    preferredId: settings.preferredSourceId,
                    preferredName: settings.preferredSourceName,
                    sound: liveSound,
                    soundLive: typeof state.streamSound === "boolean"
                });
            } catch (e) { jsonReply(res, 500, { error: e.message }); }
            return;
        }

        if (req.method === "GET" && url === "/sources/thumbs") {
            try {
                const list = await desktopCapturer.getSources({
                    types: ["screen", "window"], thumbnailSize: { width: 160, height: 90 }, fetchWindowIcons: false
                });
                const thumbs = {};
                for (const src of list) {
                    try { if (!src.thumbnail.isEmpty()) thumbs[src.id] = "data:image/jpeg;base64," + src.thumbnail.toJPEG(60).toString("base64"); } catch (e) {}
                }
                jsonReply(res, 200, { thumbs });
            } catch (e) { jsonReply(res, 200, { thumbs: {} }); }
            return;
        }
        if (req.method === "POST" && url === "/sources/preferred") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const id = String(parsed.id || "");
                if (!id) { jsonReply(res, 400, { ok: false, error: "missing id" }); return; }
                settings.preferredSourceId = id;
                const src = (cachedSources || []).find(s => s.id === id);
                settings.preferredSourceName = src ? (src.label || src.appName || src.name || id) : id;
                saveSettings();
                rebuildTrayMenu();
                jsonReply(res, 200, { ok: true, id, name: settings.preferredSourceName });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }

        if (req.method === "POST" && url === "/sources/sound") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                settings.streamSound = !!parsed.enabled;
                saveSettings();
                commandQueue.push({
                    id: nextCommandId++,
                    action: "set-stream-sound",
                    userId: "self",
                    sourceId: "", name: "",
                    sound: settings.streamSound,
                    createdAt: Date.now()
                });
                rebuildTrayMenu();
                jsonReply(res, 200, { ok: true, sound: settings.streamSound });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }

        if (req.method === "POST" && url === "/popup/open") {
            let winId = null;
            try {
                const body = await readBody(req);
                if (body) { const parsed = JSON.parse(body); winId = parsed?.winId ? String(parsed.winId) : null; }
            } catch (e) {}
            openPopupWindow(winId);
            jsonReply(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url === "/popup/close") {
            closePopupWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url === "/webrtc/offer") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const v = viewerFor(parsed.key);
                if (v) {
                    v.offer = parsed.offer || null;
                    v.offerCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                    // A new offer invalidates the previous answer; otherwise the plugin
                    // picks up the stale one and the new connection never comes up.
                    v.answer = null;
                    v.answerCandidates = [];
                    if (v.win && !v.win.isDestroyed()) {
                        try { v.win.webContents.send("webrtc:offer", { sdp: v.offer, candidates: v.offerCandidates }); } catch (e) {}
                    }
                }
                jsonReply(res, 200, { ok: true });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url.startsWith("/webrtc/offer")) {
            const v = viewerFor(new URL(req.url, "http://x").searchParams.get("key"));
            jsonReply(res, 200, { offer: v?.offer || null, candidates: v?.offerCandidates || [] });
            return;
        }
        if (req.method === "POST" && url === "/webrtc/answer") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const v = viewerFor(parsed.key);
                if (v) {
                    v.answer = parsed.answer || null;
                    v.answerCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                }
                jsonReply(res, 200, { ok: true });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url.startsWith("/webrtc/answer")) {
            const v = viewerFor(new URL(req.url, "http://x").searchParams.get("key"));
            jsonReply(res, 200, { answer: v?.answer || null, candidates: v?.answerCandidates || [] });
            return;
        }
        if (req.method === "POST" && url === "/webrtc/reset") {
            for (const v of viewers.values()) { v.offer = null; v.offerCandidates = []; v.answer = null; v.answerCandidates = []; }
            _webrtcIceForSender = [];
            _webrtcIceForReceiver = [];
            jsonReply(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url === "/webrtc/ice") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const target = parsed.for;
                const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                if (target === "sender") _webrtcIceForSender.push(...candidates);
                else if (target === "receiver") _webrtcIceForReceiver.push(...candidates);
                jsonReply(res, 200, { ok: true });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url.startsWith("/webrtc/ice")) {
            const forWhom = new URL(req.url, "http://x").searchParams.get("for");
            let list = [];
            if (forWhom === "sender") { list = _webrtcIceForSender; _webrtcIceForSender = []; }
            else if (forWhom === "receiver") { list = _webrtcIceForReceiver; _webrtcIceForReceiver = []; }
            jsonReply(res, 200, { candidates: list });
            return;
        }

        if (req.method === "POST" && url === "/log/plugin") {
            try {
                const parsed = JSON.parse(await readBody(req) || "{}");
                const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
                if (lines.length) appendLog(PLUGIN_LOG_FILE, lines.join("\n") + "\n");
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/close") {
            let d = {}; try { d = JSON.parse(await readBody(req) || "{}"); } catch (e) {}
            closeVideoWindow(d.key);
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/aspect") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                applyVideoAspect(viewerFor(d.key), Number(d.width), Number(d.height));
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/reconnect") {
            let d = {}; try { d = JSON.parse(await readBody(req) || "{}"); } catch (e) {}
            const v = viewerFor(d.key);
            const live = !!v && isViewerLive(v) && !v.paused;
            const attempt = Number(d.attempt) || 0;
            if (live) {
                videoLog("reconnect requested by viewer for", v.key, "attempt", attempt);
                reopenVideoStream(v, attempt);
            }
            jsonReply(res, 200, { ok: true, live, pluginAlive: isPluginAlive() });
            return;
        }
        if (req.method === "POST" && url === "/video/zoom") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                const v = viewerFor(d.key);
                if (v) {
                    const vp = videoPrefs();
                    vp.zoom = vp.zoom && typeof vp.zoom === "object" ? vp.zoom : {};
                    if (Number(d.z) > 1) vp.zoom[v.key] = { z: Number(d.z), cx: Number(d.cx), cy: Number(d.cy) };
                    else delete vp.zoom[v.key];
                    saveSettingsSoon();
                }
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/own-local") {
            let d = {}; try { d = JSON.parse(await readBody(req) || "{}"); } catch (e) {}
            ownStreamToLocal(d.inst);
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/own") {
            let d = {}; try { d = JSON.parse(await readBody(req) || "{}"); } catch (e) {}
            openOwnStream(d.winId);
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/preview") {
            let d = {}; try { d = JSON.parse(await readBody(req) || "{}"); } catch (e) {}
            toggleVideoPreview(viewerFor(d.key));
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/open-test") {
            openVideoWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/sender-test") {
            openSenderWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/open") {
            const body = await readBody(req);
            let params = {};
            try { params = JSON.parse(body); } catch (e) {}
            openVideoWindow(params);
            jsonReply(res, 200, { ok: true });
            return;
        }

        if (req.method === "GET" && url === "/displays") {
            const displays = screen.getAllDisplays();
            jsonReply(res, 200, {
                displays: displays.map(d => ({
                    id: d.id, label: d.label, bounds: d.bounds, scaleFactor: d.scaleFactor
                }))
            });
            return;
        }

        if (req.method === "POST" && url === "/ping") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const now = Date.now();
                const last = (typeof parsed.last === "number" && isFinite(parsed.last) && parsed.last > 0) ? parsed.last : null;
                const avg = (typeof parsed.avg === "number" && isFinite(parsed.avg) && parsed.avg > 0) ? parsed.avg : null;
                pingState = { last, avg, updatedAt: now };
                if (last) {
                    pingHistory.push({ t: now, v: last });
                    while (pingHistory.length && pingHistory[0].t < now - 10 * 60_000) pingHistory.shift();
                }
                updateNetMachine();
                jsonReply(res, 200, { ok: true });
                broadcastState();
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }

        if (req.method === "POST" && url === "/state") {
            try {
                const body = await readBody(req);
                const prevSound = state.streamSound;
                const gap = lastPluginSeen ? Date.now() - lastPluginSeen : Infinity;
                state = Object.assign({ updatedAt: Date.now() }, JSON.parse(body));
                lastPluginSeen = Date.now();
                noteVoiceForReturn(gap);
                jsonReply(res, 200, { ok: true });
                applyAutoResizeAll();      // grow the window first, then draw into it
                broadcastState();
                checkVideoAutoClose();
                if (state.streamSound !== prevSound) {
                    try { rebuildTrayMenu(); } catch (e) {}
                }
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/state") {
            jsonReply(res, 200, buildStateResponse());
            return;
        }

        if (req.method === "POST" && url === "/speaking") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                speaking = { speakers: Array.isArray(parsed?.speakers) ? parsed.speakers : [] };
                jsonReply(res, 200, { ok: true });
                sseBroadcast("speaking", speaking);
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/speaking") { jsonReply(res, 200, speaking); return; }

        if (req.method === "GET" && url === "/ping/history") {
            jsonReply(res, 200, { now: Date.now(), points: pingHistory });
            return;
        }
        if (req.method === "POST" && url === "/tip/open") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                openTipWindow(String(d.mode || "ping"), Number(d.x), Number(d.y), d.uid ? String(d.uid) : "", Number(d.w));
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/tip/close") {
            closeTipWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/tip/size") {
            try { const d = JSON.parse(await readBody(req) || "{}"); sizeTipWindow(Number(d.w), Number(d.h)); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/note/editing") {
            try { noteEditing = !!JSON.parse(await readBody(req) || "{}").on; applyAutoResizeAll(); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/note") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                const text = String(d.text || "").slice(0, 300);
                sessionNote = text && state.channelId ? { channelId: state.channelId, text } : null;
                broadcastState();
                applyAutoResizeAll();
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        // Plugin start: it asks where we were (and we know it restarted).
        if (req.method === "POST" && url === "/plugin/hello") {
            pluginRestarted = true;
            const lv = lastVoiceSeen && !lastVoiceSeen.left && Date.now() - lastVoiceSeen.at < RETURN_OFFER_MS ? lastVoiceSeen : null;
            jsonReply(res, 200, { lastVoice: lv });
            return;
        }
        if (req.method === "POST" && url === "/return/dismiss") {
            returnOffer = null;
            if (lastVoiceSeen) lastVoiceSeen.left = true;
            broadcastState();
            applyAutoResizeAll();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "GET" && url === "/layouts") {
            jsonReply(res, 200, layoutsInfo());
            return;
        }
        if (req.method === "POST" && url.startsWith("/layouts/")) {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                const key = d.key ? String(d.key).toLowerCase() : null;
                const what = url.slice("/layouts/".length);
                if (what === "save" && key) saveLayoutProfile(key);
                else if (what === "apply" && key && layoutProfiles()[key]) applyLayoutProfile(layoutProfiles()[key]);
                else if (what === "delete" && key) { delete layoutProfiles()[key]; saveSettingsSoon(); }
                else if (what === "forget" && key && settings.seenGames) { delete settings.seenGames[key]; delete layoutProfiles()[key]; saveSettingsSoon(); }
                else if (what === "enabled") { settings.layoutProfilesEnabled = !!d.on; saveSettingsSoon(); }
                else if (what === "setup" && key) startSetup(key);
                else if (what === "done") finishSetup(true);
                else if (what === "add-stream") addSetupStreamFrame(null);
                else if (what === "cancel") finishSetup(false);
                else if (what === "open") openLayoutsWindow();
                else if (what === "close") { if (layoutsWindow && !layoutsWindow.isDestroyed()) layoutsWindow.close(); }
            } catch (e) {}
            jsonReply(res, 200, layoutsInfo());
            return;
        }
        if (req.method === "POST" && url === "/menu/open") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                openMenuWindow(String(d.userId || ""), Number(d.x), Number(d.y));
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/menu/close") {
            closeMenuWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/menu/size") {
            try { sizeMenuWindow(Number(JSON.parse(await readBody(req) || "{}").height)); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/clipboard") {
            try { clipboard.writeText(String(JSON.parse(await readBody(req) || "{}").text || "")); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify") {
            try { addNotification(JSON.parse(await readBody(req) || "{}")); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "GET" && url === "/notify") {
            jsonReply(res, 200, { items: notifications, call: incomingCall });
            return;
        }
        if (req.method === "POST" && url === "/call") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                if (d.channelId && anyOverlayVisible()) incomingCall = {
                    channelId: String(d.channelId), callerId: d.callerId ? String(d.callerId) : null,
                    name: String(d.name || "Someone"), avatar: d.avatar || null, group: d.group || null
                };
                notifyChanged();
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/call/clear") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                if (!d.channelId || (incomingCall && incomingCall.channelId === String(d.channelId))) {
                    incomingCall = null;
                    setNotifyTyping(null, false);
                    notifyChanged();
                }
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/size") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                const h = Number(d.height);
                const win = d.win != null && d.win !== "" ? String(d.win) : null;
                if (win && Number.isFinite(h) && h >= 0) setNotifyContentH(win, h);
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/typing") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                setNotifyTyping(d.win ? String(d.win) : null, !!d.on);
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/dismiss") {
            try {
                const { id } = JSON.parse(await readBody(req) || "{}");
                notifications = notifications.filter(n => n.id !== String(id));
                notifyChanged();
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/clear") {
            try {
                const { channelIds } = JSON.parse(await readBody(req) || "{}");
                const set = new Set((channelIds || []).map(String));
                const before = notifications.length;
                notifications = notifications.filter(n => !set.has(n.channelId));
                if (notifications.length !== before) notifyChanged();
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/command") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const cmd = {
                    id: nextCommandId++,
                    action: String(parsed.action || ""),
                    userId: String(parsed.userId || ""),
                    sourceId: parsed.sourceId ? String(parsed.sourceId) : "",
                    name: parsed.name ? String(parsed.name) : "",
                    channelId: parsed.channelId ? String(parsed.channelId) : "",
                    sound: parsed.sound === true || parsed.sound === false ? parsed.sound : null,
                    createdAt: Date.now()
                };
                if (!cmd.action) { jsonReply(res, 400, { ok: false, error: "missing action" }); return; }
                commandQueue.push(cmd);
                flushCommandWaiters();
                jsonReply(res, 200, { ok: true, id: cmd.id });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }

        if (req.method === "GET" && url === "/commands") {
            // Long-poll: ?wait=<ms> holds the request until a command arrives or the timeout ends
            const m = /[?&]wait=(\d+)/.exec(req.url);
            const waitMs = m ? Math.min(Number(m[1]), 30000) : 0;
            if (commandQueue.length > 0 || waitMs <= 0) {
                const pending = commandQueue;
                commandQueue = [];
                jsonReply(res, 200, { commands: pending });
                return;
            }
            const waiter = { res, timer: null };
            waiter.timer = setTimeout(() => {
                commandWaiters.delete(waiter);
                jsonReply(res, 200, { commands: [] });
            }, waitMs);
            commandWaiters.add(waiter);
            req.on("close", () => {
                if (commandWaiters.delete(waiter)) clearTimeout(waiter.timer);
            });
            return;
        }

        if (req.method === "POST" && url === "/command-done") {
            try { await readBody(req); } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }

        if (req.method === "GET" && (url === "/" || url === "/overlay.html")) {
            fs.readFile(HTML_FILE, "utf8", (err, data) => {
                if (err) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + err.message); return; }
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(data);
            });
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    });

    // Time-derived fields (plugin offline, net state) change without input: refresh every second.
    // Comment lines keep idle connections alive.
    setInterval(broadcastState, 1000);
    setInterval(() => {
        for (const res of sseClients) { try { res.write(": ka\n\n"); } catch (e) { sseClients.delete(res); } }
    }, 15000);

    server.listen(PORT, "127.0.0.1", () => {
        console.log(`[server] listening on http://127.0.0.1:${PORT}/`);
    });

    server.on("error", (e) => {
        if (e.code === "EADDRINUSE") console.error(`[server] port ${PORT} busy`);
        else console.error("[server] error:", e.message);
    });
}

// =====================================================================
// Popup window
// =====================================================================

function openPopupWindow(winId) {
    if (popupWindow && !popupWindow.isDestroyed()) {
        if (winId == null || popupWindow._vetAnchorId === winId) { popupWindow.focus(); return; }
        try { popupWindow.close(); } catch (e) {}
        popupWindow = null;
    }

    let anchor = null;
    let anchorId = null;
    if (winId != null) {
        const rec = windows.get(winId);
        if (rec && rec.win && !rec.win.isDestroyed()) { anchor = rec.win; anchorId = rec.id; }
    }
    if (!anchor) {
        for (const rec of windows.values()) {
            if (rec.win && !rec.win.isDestroyed()) { anchor = rec.win; anchorId = rec.id; break; }
        }
    }

    const POPUP_WIDTH = 260;
    const POPUP_HEIGHT = 400;

    let px = 100, py = 100;
    if (anchor) {
        try {
            const [ax, ay] = anchor.getPosition();
            const [aw] = anchor.getSize();
            px = ax + aw - POPUP_WIDTH;
            py = ay + 24;
        } catch (e) {}
    } else {
        const b = screen.getPrimaryDisplay().bounds;
        px = b.x + b.width - POPUP_WIDTH - 20;
        py = b.y + 20;
    }

    popupWindow = new BrowserWindow({
        width: POPUP_WIDTH, height: POPUP_HEIGHT, x: px, y: py,
        frame: false, transparent: true, alwaysOnTop: true,
        resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: true, show: false,
        webPreferences: {
            nodeIntegration: false, contextIsolation: true, backgroundThrottling: false
        }
    });

    popupWindow.setAlwaysOnTop(true, "screen-saver");
    popupWindow.setVisibleOnAllWorkspaces(true);
    popupWindow.loadFile(path.join(__dirname, "popup.html"));
    popupWindow._vetAnchorId = anchorId;

    popupWindow.once("ready-to-show", () => { popupWindow.show(); popupWindow.focus(); });
    popupWindow.on("blur", () => {
        if (popupWindow && !popupWindow.isDestroyed()) { try { popupWindow.close(); } catch (e) {} }
    });
    popupWindow.on("closed", () => { popupWindow = null; });
}

// =====================================================================
// Message notifications: a window docked under the voice overlay. Invisible
// while empty; while the cursor is hidden (game) it never takes the mouse.
// =====================================================================
const NOTIFY_SHOW_MS = 12_000;
const NOTIFY_MAX     = 4;
const NOTIFY_ITEM_H  = 54;
let notifications = [];      // newest first
let incomingCall = null;     // { channelId, callerId, name, avatar, group }

// True when at least one overlay window is on screen. Cards and calls only
// exist while this holds; nothing is queued for later.
function anyOverlayVisible() {
    for (const rec of windows.values()) {
        if (rec.win && !rec.win.isDestroyed() && rec.win.isVisible()) return true;
    }
    return false;
}

function addNotification(n) {
    if (!n || !n.id || !n.channelId) return;
    if (!anyOverlayVisible()) return;
    n = {
        id: String(n.id), kind: ["mention", "device"].includes(n.kind) ? n.kind : "dm",
        authorId: String(n.authorId || ""), name: String(n.name || "user"), avatar: n.avatar || null,
        channelId: String(n.channelId), guildId: n.guildId ? String(n.guildId) : null,
        where: n.where ? String(n.where) : null, text: String(n.text || ""),
        devices: Array.isArray(n.devices) ? n.devices.slice(0, 2).map(d => ({ kind: d.kind === "output" ? "output" : "input", name: String(d.name || "") })) : null,
        expiresAt: Date.now() + Math.max(3000, Math.min(60_000, Number(n.ttlMs) || NOTIFY_SHOW_MS))
    };
    // One card per chat: a newer message replaces the older card.
    notifications = [n, ...notifications.filter(x => x.channelId !== n.channelId)].slice(0, NOTIFY_MAX);
    notifyChanged();
}

function notifyChanged() {
    sseBroadcast("notify", { items: notifications, call: incomingCall });
    const hasContent = notifications.length > 0 || !!incomingCall;
    for (const rec of windows.values()) {
        const visible = !!rec.win && !rec.win.isDestroyed() && rec.win.isVisible();
        if (!visible || !hasContent) { hideNotifyWindow(rec.id); continue; }
        ensureNotifyWindow(rec);
        positionNotifyWindow(rec);
        const e = notifyWindows.get(rec.id);
        if (e && !e.win.isDestroyed() && e.win.webContents.isLoading() === false && !e.win.isVisible()) {
            try { e.win.showInactive(); } catch (err) {}
        }
    }
    // Notify windows of overlays that no longer exist
    for (const id of [...notifyWindows.keys()]) {
        if (!windows.has(id)) destroyNotifyWindow(id);
    }
}

// Overlays hidden or gone: drop the cards and any pending call, and end a reply in progress.
function clearNotifyState() {
    notifications = [];
    incomingCall = null;
    setNotifyTyping(null, false);
    notifyChanged();
}

setInterval(() => {
    const now = Date.now();
    const before = notifications.length;
    // Cards don't expire while a reply is being typed.
    if (isNotifyTyping()) return;
    notifications = notifications.filter(n => n.expiresAt > now);
    if (notifications.length !== before) notifyChanged();
}, 1000);

function firstVisibleOverlay() {
    for (const rec of windows.values()) {
        if (rec.win && !rec.win.isDestroyed() && rec.win.isVisible()) return rec;
    }
    return null;
}

// One notify window per overlay; each shows the same cards, docked under its overlay.
function ensureNotifyWindow(rec) {
    const cur = notifyWindows.get(rec.id);
    if (cur && !cur.win.isDestroyed()) return cur;
    const win = new BrowserWindow({
        width: WINDOW_WIDTH, height: NOTIFY_ITEM_H,
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: false, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    const entry = { win, contentH: 0, typing: false };
    notifyWindows.set(rec.id, entry);
    applyEntryClickThrough(entry);
    win.loadFile(path.join(__dirname, "notify.html"));
    win.webContents.on("did-finish-load", () => {
        if (win.isDestroyed()) return;
        const id = JSON.stringify(rec.id);
        try {
            win.webContents.executeJavaScript(
                `window.__vetWinId = ${id}; window.__vetSetWin && window.__vetSetWin(${id});`).catch(() => {});
        } catch (e) {}
        applyEntryClickThrough(entry);
        if ((notifications.length || incomingCall) && rec.win && !rec.win.isDestroyed() && rec.win.isVisible()) {
            positionNotifyWindow(rec);
            try { win.showInactive(); } catch (e) {}
        }
    });
    win.on("closed", () => {
        if (notifyWindows.get(rec.id) === entry) notifyWindows.delete(rec.id);
    });
    return entry;
}

function destroyNotifyWindow(id) {
    const e = notifyWindows.get(id);
    if (!e) return;
    notifyWindows.delete(id);
    if (!e.win.isDestroyed()) { try { e.win.destroy(); } catch (err) {} }
}

function hideNotifyWindow(id) {
    const e = notifyWindows.get(id);
    if (!e || e.win.isDestroyed()) return;
    try { if (e.win.isVisible()) e.win.hide(); } catch (err) {}
}

let notifyPos = null;   // { x, y, width } from the active layout; null = docked under the voice window

function positionNotifyWindow(rec) {
    const e = notifyWindows.get(rec.id);
    if (!e || e.win.isDestroyed() || !rec.win || rec.win.isDestroyed()) return;
    const h = e.contentH > 0 ? e.contentH
        : Math.max(1, notifications.length + (incomingCall ? 2 : 0)) * NOTIFY_ITEM_H;
    const isFirst = windows.keys().next().value === rec.id;
    try {
        if (isFirst && notifyPos && boundsOnScreen({ ...notifyPos, height: h })) {
            e.win.setBounds({ x: notifyPos.x, y: notifyPos.y, width: notifyPos.width, height: h });
        } else {
            const [ax, ay] = rec.win.getPosition();
            const [aw, ah] = rec.win.getSize();
            e.win.setBounds({ x: ax, y: ay + ah + 4, width: aw, height: h });
        }
    } catch (err) {}
}

function positionAllNotifyWindows() {
    for (const rec of windows.values()) positionNotifyWindow(rec);
}

// Content height reported by a notify page (win missing = all, for older pages).
function setNotifyContentH(winId, h) {
    const ids = winId ? [winId] : [...notifyWindows.keys()];
    for (const id of ids) {
        const e = notifyWindows.get(id);
        if (!e || e.win.isDestroyed() || e.contentH === h) continue;
        e.contentH = h;
        const rec = windows.get(id);
        if (rec) positionNotifyWindow(rec);
    }
}

function isNotifyTyping() {
    for (const e of notifyWindows.values()) if (e.typing) return true;
    return false;
}

// Typing a reply needs keyboard focus; otherwise the window never takes focus
// (so it can't pull the game out of fullscreen).
// winId null = every notify window (older pages send no id).
function setNotifyTyping(winId, on) {
    const targets = winId ? [notifyWindows.get(winId)].filter(Boolean) : [...notifyWindows.values()];
    for (const e of targets) {
        if (e.win.isDestroyed()) continue;
        e.typing = !!on;
        try {
            e.win.setFocusable(e.typing);
            if (e.typing) e.win.focus();
        } catch (err) {}
    }
    applyNotifyClickThrough();
}

// In a game (cursor hidden) the cards are display-only; with the cursor
// visible they can be clicked (open chat / dismiss).
function applyNotifyClickThrough() {
    for (const e of notifyWindows.values()) applyEntryClickThrough(e);
}

function applyEntryClickThrough(e) {
    if (e.win.isDestroyed()) return;
    const ignore = _clickThroughState && !e.typing;
    try { e.win.setIgnoreMouseEvents(ignore, { forward: false }); } catch (err) {}
    try {
        e.win.webContents.executeJavaScript(
            `document.body.classList.toggle("click-through", ${_clickThroughState});`).catch(() => {});
    } catch (err) {}
}

// =====================================================================
// Right-click menu for a user card: a small window at the cursor (the
// overlay itself is too narrow to hold it). Closes when it loses focus.
// =====================================================================
const MENU_WIDTH = 230;

function openMenuWindow(userId, x, y) {
    closeMenuWindow();
    if (!userId) return;
    const pt = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : screen.getCursorScreenPoint();
    menuWindow = new BrowserWindow({
        width: MENU_WIDTH, height: 360, x: pt.x, y: pt.y,
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: true, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    });
    menuWindow._vetAnchor = pt;
    menuWindow.setAlwaysOnTop(true, "screen-saver");
    menuWindow.loadFile(path.join(__dirname, "menu.html"), { query: { uid: userId } });
    menuWindow.once("ready-to-show", () => {
        if (!menuWindow || menuWindow.isDestroyed()) return;
        menuWindow.show();
        menuWindow.focus();
    });
    menuWindow.on("blur", () => closeMenuWindow());
    menuWindow.on("closed", () => { menuWindow = null; });
}

// Fit the height to the content and keep the menu on the screen.
function sizeMenuWindow(h) {
    if (!menuWindow || menuWindow.isDestroyed() || !Number.isFinite(h) || h <= 0) return;
    const pt = menuWindow._vetAnchor || menuWindow.getBounds();
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    const height = Math.min(Math.ceil(h), wa.height);
    let x = pt.x, y = pt.y;
    if (x + MENU_WIDTH > wa.x + wa.width) x = Math.max(wa.x, pt.x - MENU_WIDTH);
    if (y + height > wa.y + wa.height) y = Math.max(wa.y, wa.y + wa.height - height);
    try { menuWindow.setBounds({ x, y, width: MENU_WIDTH, height }); } catch (e) {}
}

function closeMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed()) { try { menuWindow.close(); } catch (e) {} }
    menuWindow = null;
}

// =====================================================================
// Hover tips that don't fit in the overlay (ping graph, my stream): a small
// window that never takes focus or the mouse.
// =====================================================================
const pingHistory = [];      // { t, v } for the last 10 minutes
let sessionNote = null;      // { channelId, text } — cleared when leaving that channel
let noteEditing = false;

function openTipWindow(mode, x, y, uid = "", w = 0) {
    closeTipWindow();
    const pt = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : screen.getCursorScreenPoint();
    tipWindow = new BrowserWindow({
        width: 240, height: 80, x: pt.x, y: pt.y,
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: false, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    });
    tipWindow._vetAnchor = pt;
    tipWindow._vetWidth = w > 0 ? Math.round(w) : 0;
    tipWindow.setAlwaysOnTop(true, "screen-saver");
    try { tipWindow.setIgnoreMouseEvents(true); } catch (e) {}
    tipWindow.loadFile(path.join(__dirname, "tip.html"), { query: { mode, uid } });
    tipWindow.on("closed", () => { tipWindow = null; });
}

function sizeTipWindow(w, h) {
    if (!tipWindow || tipWindow.isDestroyed() || !(w > 0) || !(h > 0)) return;
    const pt = tipWindow._vetAnchor;
    if (tipWindow._vetWidth) w = tipWindow._vetWidth;      // as wide as the overlay block
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    let x = Math.min(pt.x, wa.x + wa.width - w), y = pt.y;
    if (y + h > wa.y + wa.height) y = Math.max(wa.y, pt.y - h - 30);
    try {
        tipWindow.setBounds({ x: Math.max(wa.x, x), y, width: Math.ceil(w), height: Math.ceil(h) });
        if (!tipWindow.isVisible()) tipWindow.showInactive();
        tipWindow.moveTop();
    } catch (e) {}
}

function closeTipWindow() {
    if (tipWindow && !tipWindow.isDestroyed()) { try { tipWindow.close(); } catch (e) {} }
    tipWindow = null;
}

// =====================================================================
// Layout profiles per game: where the overlay windows sit is remembered per
// foreground game (exe) and for the desktop ("default"). Switching between
// them moves the windows. A profile is saved when you move a window while it
// is the active one (alt-tabbing out of a game keeps the game's profile).
// =====================================================================
let _profileKey = "default";
let _applyingProfile = false;
const _exeByPid = new Map();
let _exeLookupBusy = new Set();

function exeForPid(pid) {
    if (_exeByPid.has(pid)) return Promise.resolve(_exeByPid.get(pid));
    if (_exeLookupBusy.has(pid)) return Promise.resolve(null);
    _exeLookupBusy.add(pid);
    return new Promise((resolve) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).ProcessName`],
            { windowsHide: true, timeout: 4000 }, (err, out) => {
                _exeLookupBusy.delete(pid);
                const name = err ? null : String(out || "").trim().toLowerCase() || null;
                if (name) _exeByPid.set(pid, name);
                if (_exeByPid.size > 200) _exeByPid.clear();
                resolve(name);
            });
    });
}

// Apps that can go fullscreen with a hidden cursor but aren't games.
const NOT_GAMES = /^(chrome|msedge|firefox|opera|opera_gx|brave|vivaldi|yandex|browser|discord|discordptb|discordcanary|explorer|vlc|mpc-hc64|mpc-hc|mpc-be64|potplayermini64|potplayermini|mpv|wmplayer|video\.ui|microsoft\.media\.player|applicationframehost|electron|code|telegram|spotify|obs64|steamwebhelper)$/i;

// Profiles are saved only from the Window layouts window (in a game there's
// no cursor to move anything, and alt-tabbing out switches to "default").
// Switching between saved profiles is automatic.
async function noteForegroundForProfiles(pid, gameLike) {
    if (!pid) return;
    let key = "default";
    if (gameLike) {
        const exe = await exeForPid(pid);
        if (!exe) return;
        if (!NOT_GAMES.test(exe)) { key = exe; noteSeenGame(exe); }
    }
    if (key === _profileKey || setupMode) return;
    const prev = _profileKey;
    _profileKey = key;
    sseBroadcast("layouts", layoutsInfo());
    if (settings.layoutProfilesEnabled === false) return;
    const profiles = layoutProfiles();
    const moved = profiles[key] ? applyLayoutProfile(profiles[key]) : 0;
    videoLog("[layout] profile", prev, "->", key, profiles[key] ? `(applied, moved ${moved} windows)` : "(none saved)");
}

function noteSeenGame(exe) {
    if (!settings.seenGames || typeof settings.seenGames !== "object") settings.seenGames = {};
    const had = settings.seenGames[exe];
    settings.seenGames[exe] = Date.now();
    const keys = Object.keys(settings.seenGames);
    if (keys.length > 30) {
        keys.sort((a, b) => settings.seenGames[a] - settings.seenGames[b]).slice(0, keys.length - 30)
            .forEach(k => { delete settings.seenGames[k]; });
    }
    if (!had || Date.now() - had > 60_000) saveSettingsSoon();
}

function layoutsInfo() {
    const profiles = layoutProfiles();
    const seen = settings.seenGames || {};
    const keys = new Set(["default", ...Object.keys(profiles), ...Object.keys(seen)]);
    return {
        enabled: settings.layoutProfilesEnabled !== false,
        current: _profileKey,
        setup: setupMode ? { key: setupMode.key, until: setupMode.until } : null,
        items: [...keys].map(k => ({
            key: k,
            saved: !!profiles[k],
            savedAt: profiles[k]?.savedAt || 0,
            windows: profiles[k] ? Object.keys(profiles[k].windows || {}).length : 0,
            lastSeen: k === "default" ? Infinity : (seen[k] || 0)
        })).sort((a, b) => (a.key === "default" ? -1 : b.key === "default" ? 1 : (b.lastSeen - a.lastSeen)))
    };
}

// Setup: for a while the overlay windows take the mouse even in a game,
// look translucent with a dashed frame and a countdown, so you can drag them
// where you want them. Ends 5 s after the last move, after 30 s, or
// via Done; then the positions are saved to that layout.
const SETUP_MS = 30_000;
const SETUP_AFTER_MOVE_MS = 5000;   // each move gives this long to move the next frame
let setupMode = null;     // { key, until, timer, tick }

function startSetup(key) {
    finishSetup(false);
    setupMode = { key, until: Date.now() + SETUP_MS };
    if (_clickThroughState) setClickThrough(false);
    // Start from what's saved for this layout, if anything.
    if (layoutProfiles()[key]) applyLayoutProfile(layoutProfiles()[key]);
    openSetupFrames(key);
    setupMode.tick = setInterval(setupTick, 250);
    paintSetup();
    videoLog("[layout] setup", key);
    sseBroadcast("layouts", layoutsInfo());
}

function setupMoved() {
    if (!setupMode) return;
    setupMode.until = Math.max(setupMode.until, Date.now() + SETUP_AFTER_MOVE_MS);
    setupMode.moved = true;
}

// The countdown holds while the cursor is over the overlay or a frame (you're
// dragging or about to); it runs again once you let go and move away.
function setupTick() {
    if (!setupMode) return;
    const pt = screen.getCursorScreenPoint();
    const inside = (w) => {
        if (!w || w.isDestroyed()) return false;
        const b = w.getBounds();
        return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    };
    const over = Object.values(setupFrames).some(inside) || [...windows.values()].some(r => inside(r.win));
    const now = Date.now();
    if (over) setupMode.until = Math.max(setupMode.until, now + (setupMode.moved ? SETUP_AFTER_MOVE_MS : 3000));
    paintSetup();
    if (now - (setupMode.lastBroadcast || 0) > 900) { setupMode.lastBroadcast = now; sseBroadcast("layouts", layoutsInfo()); }
    if (now >= setupMode.until) finishSetup(true);
}

function paintSetup() {
    const label = setupMode
        ? `${setupMode.key === "default" ? "Desktop" : setupMode.key} · ${Math.max(0, Math.ceil((setupMode.until - Date.now()) / 1000))}s`
        : "";
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        try { rec.win.setOpacity(setupMode ? 0.7 : OPACITY); } catch (e) {}
        try {
            rec.win.webContents.executeJavaScript(
                `window.__vetSetup && window.__vetSetup(${JSON.stringify(setupMode ? label : null)});`).catch(() => {});
        } catch (e) {}
    }
}

function finishSetup(save) {
    if (!setupMode) return;
    const { key, tick } = setupMode;
    clearInterval(tick);
    if (save) saveLayoutProfile(key);     // reads the frames, so before they close
    setupMode = null;
    closeSetupFrames();
    if (save) applyLayoutProfile(layoutProfiles()[key]);
    paintSetup();
    _profileKey = "__setup__";          // let the next foreground check re-pick the layout
    videoLog("[layout] setup done", key, save ? "(saved)" : "(cancelled)");
    sseBroadcast("layouts", layoutsInfo());
}

let layoutsWindow = null;
function openLayoutsWindow() {
    if (layoutsWindow && !layoutsWindow.isDestroyed()) { layoutsWindow.show(); layoutsWindow.focus(); return; }
    const wa = screen.getPrimaryDisplay().workArea;
    layoutsWindow = new BrowserWindow({
        width: 380, height: 420, x: Math.round(wa.x + (wa.width - 380) / 2), y: Math.round(wa.y + (wa.height - 420) / 2),
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: false, skipTaskbar: false, hasShadow: true,
        focusable: true, show: false, title: "Window layouts",
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    });
    layoutsWindow.setAlwaysOnTop(true, "screen-saver");
    layoutsWindow.loadFile(path.join(__dirname, "layouts.html"));
    layoutsWindow.once("ready-to-show", () => { layoutsWindow.show(); layoutsWindow.focus(); });
    layoutsWindow.on("closed", () => { layoutsWindow = null; });
}

function layoutProfiles() {
    if (!settings.layoutProfiles || typeof settings.layoutProfiles !== "object") settings.layoutProfiles = {};
    return settings.layoutProfiles;
}

// Dragging a window by hand updates the layout that's active right now (the
// game in front, or Desktop): overlay windows by id, stream windows by their
// number (#1 main / preview place, #2+ extra places). Programmatic moves don't
// count. Setup has its own saving.
let _layoutUpdateTimer = null;
function updateActiveLayoutSoon() {
    if (setupMode || settings.layoutProfilesEnabled === false) return;
    clearTimeout(_layoutUpdateTimer);
    _layoutUpdateTimer = setTimeout(() => {
        const key = _profileKey;
        if (!key || key === "__setup__") return;
        const profiles = layoutProfiles();
        const p = profiles[key] || { windows: {}, video: null, notify: null };
        // live windows first; then stale saved entries (ids not open now) kept
        // for the order-fallback, capped at max(live count, previous count)
        const prevWin = p.windows || {};
        const liveEntries = [];
        for (const rec of windows.values()) {
            if (!rec.win || rec.win.isDestroyed()) continue;
            const [x, y] = rec.win.getPosition();
            liveEntries.push([rec.id, { x, y }]);
        }
        if (liveEntries.length) {
            const cap = Math.max(liveEntries.length, Object.keys(prevWin).length);
            const liveIds = new Set(liveEntries.map(([id]) => id));
            const nw = {};
            for (const [id, pos] of liveEntries) nw[id] = pos;
            for (const k of Object.keys(prevWin)) {
                if (Object.keys(nw).length >= cap) break;
                if (!liveIds.has(k) && !(k in nw)) nw[k] = prevWin[k];
            }
            p.windows = nw;
        }
        const list = viewersIn("").filter(v => v.win && !v.win.isDestroyed());
        if (list.length) {
            const vid = { ...(p.video || {}) };
            vid.extra = Array.isArray(vid.extra) ? vid.extra.slice() : [];
            list.forEach((v, i) => {
                const b = v.win.getBounds();
                if (i === 0) { if (v.preview) vid.previewBounds = b; else vid.bounds = b; }
                else vid.extra[i - 1] = b;
            });
            p.video = vid;
            const vp = videoPrefs();
            if (vid.bounds) vp.bounds = vid.bounds;
            if (vid.previewBounds) vp.previewBounds = vid.previewBounds;
            vp.extraBounds = vid.extra;
        }
        p.savedAt = Date.now();
        profiles[key] = p;
        saveSettingsSoon();
        videoLog("[layout] updated by drag:", key);
        sseBroadcast("layouts", layoutsInfo());
    }, 400);
}

function saveLayoutProfile(key) {
    const prev = layoutProfiles()[key] || {};
    const p = { windows: {}, savedAt: Date.now(), video: prev.video || null, notify: prev.notify || null };
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        const [x, y] = rec.win.getPosition();
        p.windows[rec.id] = { x, y };
    }
    if (!Object.keys(p.windows).length) return;
    // During setup the frames tell where stream / notifications go.
    const ph = (k) => setupFrames[k] && !setupFrames[k].isDestroyed() ? setupFrames[k].getBounds() : null;
    const big = ph("stream-big"), small = ph("stream-small"), nt = ph("notify");
    if (big || small) p.video = { bounds: big || p.video?.bounds || null, previewBounds: small || p.video?.previewBounds || null };
    // more stream windows (multistream): their places, in order
    const extra = Object.keys(setupFrames).filter(k => /^stream-extra-\d+$/.test(k))
        .sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()))
        .map(k => ph(k)).filter(Boolean);
    if (Object.keys(setupFrames).length) p.video = { ...(p.video || {}), extra };
    if (nt) p.notify = { x: nt.x, y: nt.y, width: nt.width };
    layoutProfiles()[key] = p;
    saveSettingsSoon();
}

// Returns the number of overlay windows moved.
function applyLayoutProfile(p) {
    _applyingProfile = true;
    let moved = 0;
    try {
        const saved = p.windows || {};
        const live = [...windows.values()].filter(rec => rec.win && !rec.win.isDestroyed());
        // Pass 1: a window whose id is in the profile gets that place.
        // Pass 2: the rest take the unused saved places in order (ids are
        // random and get orphaned when windows are closed and recreated).
        const target = new Map(); // rec -> saved key
        const used = new Set();
        for (const rec of live) {
            if (saved[rec.id]) { target.set(rec, rec.id); used.add(rec.id); }
        }
        const free = Object.keys(saved).filter(k => !used.has(k));
        const fallback = []; // [savedKey, rec.id]
        for (const rec of live) {
            if (target.has(rec) || !free.length) continue;
            const k = free.shift();
            target.set(rec, k);
            fallback.push([k, rec.id]);
        }
        for (const rec of live) {
            const key = target.get(rec);
            if (key === undefined) continue;
            const pos = saved[key];
            if (!boundsOnScreen({ x: pos.x, y: pos.y, width: rec.width || WINDOW_WIDTH, height: rec.height || HEIGHT_IDLE })) continue;
            rec.win.setPosition(pos.x, pos.y);
            rec.x = pos.x; rec.y = pos.y;
            moved++;
        }
        // Heal the profile: fallback places are stored under the ids of the
        // windows they were applied to.
        if (fallback.length) {
            const pairs = fallback.map(([k, id]) => [id, saved[k]]);
            for (const [k] of fallback) delete p.windows[k];
            for (const [id, pos] of pairs) p.windows[id] = pos;
            saveSettingsSoon();
        }
        scheduleSaveWindows();
        notifyPos = p.notify || null;
        positionAllNotifyWindows();
        if (p.video) {
            const vp = videoPrefs();
            if (p.video.bounds) vp.bounds = p.video.bounds;
            if (p.video.previewBounds) vp.previewBounds = p.video.previewBounds;
            if (Array.isArray(p.video.extra)) vp.extraBounds = p.video.extra;
            // stream windows in the order they were opened: 1st = main place,
            // 2nd, 3rd... = the extra places
            // main-group stream windows only, in the order they were opened
            const list = viewersIn("").filter(v => v.win && !v.win.isDestroyed());
            list.forEach((v, i) => {
                const b = i === 0 ? (v.preview ? p.video.previewBounds : p.video.bounds) : (p.video.extra || [])[i - 1];
                if (b && boundsOnScreen(b)) {
                    if (i === 0 && !v.preview) v.savedBounds = b;
                    v.place = b;
                    v.win.setBounds(fitToAspect(b, v.aspect));
                }
            });
            saveSettingsSoon();
        }
    } catch (e) {}
    setTimeout(() => { _applyingProfile = false; }, 300);
    return moved;
}

// ── Setup frames: empty stand-ins for the stream viewer (big + preview) and
// the notification block, so they can be placed even when nothing is open.
const setupFrames = {};

function openSetupFrames(key) {
    closeSetupFrames();
    const prof = layoutProfiles()[key] || {};
    const vp = videoPrefs();
    const anchorRec = firstVisibleOverlay();
    let ab = null;
    try { if (anchorRec) ab = anchorRec.win.getBounds(); } catch (e) {}
    const wa = screen.getPrimaryDisplay().workArea;
    const pick = (...c) => c.find(b => b && boundsOnScreen(b)) || null;
    const big = pick(prof.video?.bounds, vp.bounds, { x: wa.x + Math.round(wa.width / 2 - 320), y: wa.y + Math.round(wa.height / 2 - 180), width: 640, height: 360 });
    const small = pick(prof.video?.previewBounds, vp.previewBounds, { x: wa.x + wa.width - 340, y: wa.y + 20, width: 320, height: 180 });
    const nt = prof.notify
        ? { x: prof.notify.x, y: prof.notify.y, width: prof.notify.width, height: 110 }
        : { x: ab ? ab.x : wa.x + 20, y: ab ? ab.y + ab.height + 4 : wa.y + 200, width: ab ? ab.width : WINDOW_WIDTH, height: 110 };
    const make = _setupFrameMake = (kind, b, resizable) => {
        // Stream frames are 16:9 and resize proportionally from any edge.
        const isStream = kind.startsWith("stream");
        if (isStream) b = { ...b, height: Math.round(b.width * 9 / 16) };
        const w = new BrowserWindow({
            ...b, frame: false, transparent: true, backgroundColor: "#00000000",
            alwaysOnTop: true, resizable, skipTaskbar: true, hasShadow: false,
            focusable: true, show: false, minWidth: 120, minHeight: 60,
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        w.setAlwaysOnTop(true, "screen-saver");
        if (isStream) { try { w.setAspectRatio(16 / 9); } catch (e) {} }
        w.loadFile(path.join(__dirname, "placeholder.html"), { query: { kind } });
        w.on("move", () => setupMoved());
        w.once("ready-to-show", () => { try { w.showInactive(); } catch (e) {} });
        w.on("moved", () => setupMoved());
        w.on("resized", () => setupMoved());
        setupFrames[kind] = w;
    };
    make("stream-big", big, true);
    make("stream-small", small, true);
    make("notify", nt, false);
    (prof.video?.extra || vp.extraBounds || []).filter(b => boundsOnScreen(b)).forEach(b => addSetupStreamFrame(b));
}

// One more stream window place (for watching several streams). A new frame
// opens left of the last one.
let _setupFrameMake = null;
function addSetupStreamFrame(bounds) {
    if (!setupMode) return;
    const n = Object.keys(setupFrames).filter(k => k.startsWith("stream-extra-")).length + 1;
    let b = bounds;
    if (!b) {
        const prevKey = n > 1 ? "stream-extra-" + (n - 1) : "stream-big";
        const prev = setupFrames[prevKey] && !setupFrames[prevKey].isDestroyed() ? setupFrames[prevKey].getBounds() : null;
        const wa = screen.getPrimaryDisplay().workArea;
        b = prev ? { x: prev.x - Math.round(prev.width / 2) - 16, y: prev.y, width: Math.round(prev.width / 2), height: Math.round(prev.height / 2) }
                 : { x: wa.x + 40, y: wa.y + 40, width: 400, height: 225 };
        if (b.x < wa.x) b.x = wa.x + 8;
    }
    _setupFrameMake("stream-extra-" + n, b, true);
    setupMoved();
}

function closeSetupFrames() {
    for (const k of Object.keys(setupFrames)) {
        try { if (!setupFrames[k].isDestroyed()) setupFrames[k].close(); } catch (e) {}
        delete setupFrames[k];
    }
}

function closePopupWindow() {
    if (popupWindow && !popupWindow.isDestroyed()) { try { popupWindow.close(); } catch (e) {} }
    popupWindow = null;
}

// =====================================================================
// Network quality state machine
// =====================================================================

function updateNetMachine() {
    const now = Date.now();
    const { last, avg } = pingState;
    const fresh = (now - pingState.updatedAt) <= NET.STALE_PING_MS;

    const lostNow = fresh && last === NET.LOST_LAST_MS;

    if (fresh && last != null && last >= NET.UNSTABLE_LAST_MS) {
        if (!netMachine.lastHighSince) netMachine.lastHighSince = now;
    } else netMachine.lastHighSince = 0;
    const unstableAccum = netMachine.lastHighSince > 0 &&
        (now - netMachine.lastHighSince) >= NET.UNSTABLE_ACCUM_MS;

    if (fresh && last != null && last >= NET.CRITICAL_LAST_MS) {
        if (!netMachine.lastCriticalSince) netMachine.lastCriticalSince = now;
    } else netMachine.lastCriticalSince = 0;
    const criticalAccum = netMachine.lastCriticalSince > 0 &&
        (now - netMachine.lastCriticalSince) >= NET.CRITICAL_ACCUM_MS;

    const avgUnstable = fresh && avg != null && avg >= NET.UNSTABLE_AVG_MS;

    const unstableNow = unstableAccum || avgUnstable;
    const criticalNow = criticalAccum;

    if (!netMachine.trig) netMachine.trig = { lost: false, critical: false, unstable: false };
    const prevTrig = netMachine.trig;

    if (prevTrig.lost && !lostNow) {
        netMachine.holds.lost = now + NET.LOST_HOLD_MS;
        netMachine.holds.critical = Math.max(netMachine.holds.critical, netMachine.holds.lost + NET.CRITICAL_HOLD_MS);
        netMachine.holds.unstable = Math.max(netMachine.holds.unstable, netMachine.holds.critical + NET.UNSTABLE_HOLD_MS);
    }
    if (prevTrig.critical && !criticalNow) {
        netMachine.holds.critical = Math.max(netMachine.holds.critical, now + NET.CRITICAL_HOLD_MS);
        netMachine.holds.unstable = Math.max(netMachine.holds.unstable, netMachine.holds.critical + NET.UNSTABLE_HOLD_MS);
    }
    if (prevTrig.unstable && !unstableNow) {
        netMachine.holds.unstable = Math.max(netMachine.holds.unstable, now + NET.UNSTABLE_HOLD_MS);
    }

    netMachine.trig = { lost: lostNow, critical: criticalNow, unstable: unstableNow };

    const lostActive     = lostNow     || (now < netMachine.holds.lost);
    const criticalActive = criticalNow || (now < netMachine.holds.critical) || lostActive;
    const unstableActive = unstableNow || (now < netMachine.holds.unstable) || criticalActive || lostActive;

    let newLevel;
    if (lostActive)          newLevel = "lost";
    else if (criticalActive) newLevel = "critical";
    else if (unstableActive) newLevel = "unstable";
    else                     newLevel = "ok";

    const queue = [];
    if (newLevel === "lost") {
        if (criticalActive) queue.push("critical");
        if (unstableActive) queue.push("unstable");
    } else if (newLevel === "critical") {
        if (unstableActive) queue.push("unstable");
    }

    if (newLevel !== netMachine.level) {
        if (newLevel !== "ok" && netMachine.level === "ok") netMachine.totalSince = now;
        netMachine.since = now;
        netMachine.level = newLevel;
    }

    if (newLevel === "ok" && netMachine.totalSince > 0) {
        const anyHold = now < netMachine.holds.unstable ||
                        now < netMachine.holds.critical ||
                        now < netMachine.holds.lost;
        if (!anyHold) netMachine.totalSince = 0;
    }

    netMachine.queue = queue;
}

function buildNetResponse() {
    const now = Date.now();
    return {
        level: netMachine.level,
        since: netMachine.since,
        phaseMs: netMachine.since > 0 ? (now - netMachine.since) : 0,
        totalMs: netMachine.totalSince > 0 ? (now - netMachine.totalSince) : 0,
        last: pingState.last,
        avg: pingState.avg,
        updatedAt: pingState.updatedAt,
        queue: Array.isArray(netMachine.queue) ? netMachine.queue.slice() : []
    };
}

// "Return to channel": the overlay outlives Discord, so it remembers the last
// channel. Leaving while the plugin is connected is a normal leave. If the
// connection was lost (Discord crashed / restarted, plugin reloaded) while in
// voice and afterwards we're not in voice, offer to go back.
const RETURN_GAP_MS = 6000;            // no state for this long = connection was lost
const RETURN_OFFER_MS = 30 * 60_000;
let lastVoiceSeen = null;              // { channelId, guildId, channelName, guildName, at, left }
let returnOffer = null;
let pluginRestarted = false;           // the plugin said hello since we last saw voice

function noteVoiceForReturn(gap) {
    if (state.stopping) { pluginRestarted = true; return; }   // plugin / Discord shutting down: not a leave
    const lost = gap > RETURN_GAP_MS || pluginRestarted;
    if (state.channelId) {
        lastVoiceSeen = {
            channelId: String(state.channelId), guildId: state.guildId ?? null,
            channelName: state.channelName || null, guildName: state.guildName || null,
            at: Date.now(), left: false
        };
        returnOffer = null;
        pluginRestarted = false;
        return;
    }
    if (!lastVoiceSeen || lastVoiceSeen.left) return;
    if (lost && Date.now() - lastVoiceSeen.at < RETURN_OFFER_MS) {
        returnOffer = { ...lastVoiceSeen };
        videoLog("[return] offering", returnOffer.channelId, "after", gap === Infinity ? "start" : Math.round(gap) + " ms", "gap");
    } else if (!lost && !returnOffer) {
        lastVoiceSeen.left = true;     // left normally
    }
    pluginRestarted = false;
}

function returnCardFromOverlay() {
    if (!returnOffer || state.channelId) return null;
    if (Date.now() - returnOffer.at > RETURN_OFFER_MS) { returnOffer = null; return null; }
    return { channelId: returnOffer.channelId, channelName: returnOffer.channelName,
             guildName: returnOffer.guildName, count: 0, members: [], pending: true };   // who's there comes from the plugin
}

function buildStateResponse() {
    if (sessionNote && sessionNote.channelId !== state.channelId) sessionNote = null;   // left / moved: note is gone
    return {
        ...state, pluginAlive: isPluginAlive(), net: buildNetResponse(), note: sessionNote ? sessionNote.text : null,
        // the plugin's own card (with who's there) wins; else the overlay's
        returnTo: state.returnTo || returnCardFromOverlay()
    };
}

function startNetTicker() {
    let lastLevel = netMachine.level;
    setInterval(() => {
        try { updateNetMachine(); } catch (e) {}
        if (netMachine.level !== lastLevel) {
            lastLevel = netMachine.level;
            try { applyAutoResizeAll(); } catch (e) {}
        }
    }, 250);
}

// =====================================================================
// Plugin liveness + auto-resize
// =====================================================================

function isPluginAlive() { return (Date.now() - lastPluginSeen) < PLUGIN_STALE_MS; }

function computeTargetHeight() {
    const alive     = isPluginAlive();
    const count     = Array.isArray(state.users) ? state.users.length : 0;
    const netExtra  = (netMachine.level !== "ok") ? NET_BANNER_HEIGHT : 0;

    let baseHeight;
    if (!alive) baseHeight = HEIGHT_OFFLINE;
    else if (!state.channelId) baseHeight = HEIGHT_IDLE;
    else if (count === 0) baseHeight = HEIGHT_EMPTY_VC;
    else {
        const visible = Math.min(count, 10);
        baseHeight = CHROME_HEIGHT + visible * ROW_HEIGHT;
    }
    // Cards under the list: "-> #channel" after someone moved (in voice) or
    // "return to channel" (not in voice).
    let cards = 0;
    if (alive) {
        if (state.channelId) cards = Array.isArray(state.departures) ? Math.min(state.departures.length, 3) : 0;
        else if (state.returnTo || returnCardFromOverlay()) cards = 1;   // the overlay's own offer counts too
    }
    const statsRows = state.leaveStats ? 2 + Math.min(5, (state.leaveStats.people || []).length) : 0;   // header + you + people
    const statsExtra = (alive && !state.channelId && state.leaveStats) ? 20 + statsRows * 16 : 0;
    const cardsExtra = cards ? cards * CARD_HEIGHT + 4 : 0;
    const noteExtra = (alive && state.channelId && (noteEditing || (sessionNote && sessionNote.channelId === state.channelId))) ? NOTE_HEIGHT : 0;
    return Math.min(MAX_HEIGHT, baseHeight + netExtra + cardsExtra + noteExtra + statsExtra);
}

function applyAutoResize(rec) {
    if (!rec || !rec.win || rec.win.isDestroyed()) return;
    const target = computeTargetHeight();
    const [w, curH] = rec.win.getSize();
    if (Math.abs(curH - target) < 2) return;
    const [x, y] = rec.win.getPosition();
    rec.win.setBounds({ x, y, width: w, height: target });
    rec.height = target;
    scheduleSaveWindows();
    positionNotifyWindow(rec);
}

function applyAutoResizeAll() {
    for (const rec of windows.values()) applyAutoResize(rec);
}

function startLivenessWatchdog() {
    setInterval(() => {
        const alive = isPluginAlive();
        if (alive !== lastAliveState) {
            lastAliveState = alive;
            applyAutoResizeAll();
        }
    }, 1000);
}

// =====================================================================
// Window creation
// =====================================================================

function nextWindowId() {
    return crypto.randomBytes(8).toString("hex");
}

function createWindowFromRecord(record) {
    const [wx, wy] = [record.x, record.y];
    const targetW = record.width || WINDOW_WIDTH;
    const targetH = record.height || HEIGHT_IDLE;

    const win = new BrowserWindow({
        width: targetW, height: targetH, x: wx, y: wy,
        frame: false, transparent: true, alwaysOnTop: true,
        resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: true, show: false,
        webPreferences: {
            nodeIntegration: false, contextIsolation: true, backgroundThrottling: false
        }
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    win.setOpacity(OPACITY);

    try {
        win.setIgnoreMouseEvents(_clickThroughState, { forward: false });
    } catch (e) {}

    win.loadFile(path.join(__dirname, "overlay.html"));

    win.webContents.on("did-finish-load", () => {
        try {
            win.webContents.executeJavaScript(
                `window.__vetWinId = ${JSON.stringify(rec.id)};` +
                `document.body.classList.toggle("click-through", ${_clickThroughState});`
            );
        } catch (e) {}
    });

    const rec = {
        win,
        id: record.id || nextWindowId(),
        monitor: record.monitor || null,
        x: wx, y: wy,
        width: targetW, height: targetH
    };
    windows.set(rec.id, rec);

    win.on("will-move", () => { rec._userMove = true; });
    win.on("moved", () => {
        try {
            const [x, y] = win.getPosition();
            rec.x = x; rec.y = y;
            const d = monitorForWindow(win);
            if (d) rec.monitor = displayToMonitorRecord(d);
            scheduleSaveWindows();
            positionNotifyWindow(rec);
            if (setupMode) setupMoved();
            else if (rec._userMove) updateActiveLayoutSoon();
            rec._userMove = false;
        } catch (e) {}
    });

    win.once("ready-to-show", () => {
        win.show();
        applyAutoResize(rec);
    });

    win.on("close", () => {
        windows.delete(rec.id);
        waitingWindows.delete(rec.id);
        scheduleSaveWindows();
        rebuildTrayMenu();
    });
    win.on("closed", () => {
        // Stream windows that belong to this overlay go with it.
        for (const v of [...viewers.values()]) {
            if (v.inst !== rec.id) continue;
            try { if (v.win && !v.win.isDestroyed()) v.win.close(); } catch (e) {}
        }
        windows.delete(rec.id);
        // No overlay left: the main-group viewers (no overlay id) go too.
        if (windows.size === 0) {
            for (const v of [...viewers.values()]) {
                if (v.inst !== "") continue;
                try { if (v.win && !v.win.isDestroyed()) v.win.close(); } catch (e) {}
            }
        }
        destroyNotifyWindow(rec.id);
        scheduleSaveWindows();
        rebuildTrayMenu();
        if (!anyOverlayVisible()) clearNotifyState();
    });

    rebuildTrayMenu();
    return rec;
}

function createNewWindow() {
    const primary = screen.getPrimaryDisplay();
    const b = primary.bounds;

    let offset = 0;
    for (const rec of windows.values()) {
        if (rec.monitor && rec.monitor.electronId === primary.id) offset += 24;
    }

    const x = b.x + b.width - WINDOW_WIDTH - MARGIN_RIGHT - offset;
    const y = b.y + MARGIN_TOP + offset;

    const record = {
        id: nextWindowId(),
        monitor: displayToMonitorRecord(primary),
        x, y,
        width: WINDOW_WIDTH,
        height: computeTargetHeight()
    };
    createWindowFromRecord(record);
    scheduleSaveWindows();
}

function tryStartWaitingWindows() {
    if (!waitingWindows.size) return;
    const displays = screen.getAllDisplays();
    const toRemove = [];
    for (const [id, record] of waitingWindows) {
        const d = findMonitorFor(record, displays);
        if (!d) continue;
        const refreshed = { ...record, monitor: displayToMonitorRecord(d) };
        toRemove.push(id);
        createWindowFromRecord(refreshed);
    }
    for (const id of toRemove) waitingWindows.delete(id);
    if (toRemove.length) { scheduleSaveWindows(); rebuildTrayMenu(); }
}

function scheduleRetryWaiting() {
    if (_retryScheduled) return;
    _retryScheduled = true;
    setTimeout(() => { _retryScheduled = false; tryStartWaitingWindows(); }, 0);
}

function startMonitorRetryTimer() {
    if (_monitorRetryTimer) clearInterval(_monitorRetryTimer);
    _monitorRetryTimer = setInterval(() => { tryStartWaitingWindows(); }, MONITOR_RETRY_MS);
}

function restoreWindowsOnStartup() {
    const configs = loadWindowsConfig();
    const displays = screen.getAllDisplays();

    if (!configs.length) { createNewWindow(); return; }

    for (const cfg of configs) {
        const d = findMonitorFor(cfg, displays);
        if (d) {
            const refreshed = { ...cfg, monitor: displayToMonitorRecord(d) };
            createWindowFromRecord(refreshed);
        } else {
            waitingWindows.set(cfg.id || nextWindowId(), {
                id: cfg.id || nextWindowId(),
                monitor: cfg.monitor || null,
                x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height
            });
        }
    }
    scheduleSaveWindows();
}

// =====================================================================
// Tray
// =====================================================================

function buildTrayIcon() {
    const iconPath = path.join(__dirname, "tray.png");
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
        console.error("[tray] tray.png not found or invalid:", iconPath);
        return nativeImage.createEmpty();
    }
    return img;
}

function displayNameForRecord(rec) {
    const m = rec.monitor;
    if (!m) return `Window ${rec.id.slice(0, 6)}`;
    const label = m.label || `(${m.bounds.width}×${m.bounds.height} at ${m.bounds.x},${m.bounds.y})`;
    return `${label} · ${rec.id.slice(0, 6)}`;
}

function stripAppSuffix(fullTitle, appName) {
    if (!fullTitle) return "";
    let t = fullTitle.trim();
    const seps = [" - ", " — ", " – "];
    for (const sep of seps) {
        const idx = t.lastIndexOf(sep);
        if (idx > 0) {
            const tail = t.slice(idx + sep.length).trim();
            if (tail.toLowerCase().endsWith(appName.toLowerCase())) {
                t = t.slice(0, idx).trim();
                break;
            }
        }
    }
    return t;
}

function rebuildTrayMenu() {
    if (!tray || tray.isDestroyed()) return;

    const screenSources = cachedSources.filter(s => s.type === "screen");
    const windowSources = cachedSources.filter(s => s.type === "window");

    const makeItem = (s, label) => {
        const isActive = settings.preferredSourceId === s.id;
        return {
            label: isActive ? `✓  ${label}` : label,
            click: () => {
                settings.preferredSourceId = s.id;
                settings.preferredSourceName = label;
                saveSettings();
                rebuildTrayMenu();
            }
        };
    };

    const screenMenuItems = screenSources.length
        ? screenSources.map(s => makeItem(s, s.label || s.name || s.id))
        : [{ label: "(no screens)", enabled: false }];

    const appCounts = new Map();
    for (const w of windowSources) {
        const key = (w.appName || w.name || "").toLowerCase();
        appCounts.set(key, (appCounts.get(key) || 0) + 1);
    }

    const windowMenuItems = windowSources.length
        ? windowSources.map(w => {
            const appName = w.appName || w.name || w.id;
            const key = appName.toLowerCase();
            const count = appCounts.get(key) || 1;
            let label;
            if (count > 1) {
                const stripped = stripAppSuffix(w.name || "", appName);
                label = stripped ? `${appName} — ${stripped}` : appName;
            } else label = appName;
            return makeItem(w, label);
        })
        : [{ label: "(no windows)", enabled: false }];

    const closeSubmenu = [];
    for (const [, rec] of windows) {
        closeSubmenu.push({
            label: displayNameForRecord(rec),
            click: () => { try { rec.win.close(); } catch (e) {} }
        });
    }
    if (!closeSubmenu.length) closeSubmenu.push({ label: "(no windows open)", enabled: false });

    const forgetSubmenu = [];
    for (const [id, rec] of waitingWindows) {
        forgetSubmenu.push({
            label: displayNameForRecord(rec),
            click: () => { waitingWindows.delete(id); scheduleSaveWindows(); rebuildTrayMenu(); }
        });
    }

    const waitingLabel = waitingWindows.size ? `Waiting for monitor (${waitingWindows.size})` : null;

    const template = [
        { label: "New window", accelerator: "Ctrl+Alt+N", click: () => createNewWindow() },
        {
            label: "Stream source",
            submenu: [
                { label: settings.preferredSourceName ? `Current: ${settings.preferredSourceName}` : "Current: (none)", enabled: false },
                { type: "separator" },
                ...screenMenuItems,
                { type: "separator" },
                { label: "Windows", submenu: windowMenuItems },
                { type: "separator" },
                { label: "Refresh list", click: async () => { await refreshSources(true); rebuildTrayMenu(); } },
                { label: "Reset to primary screen", click: () => {
                    settings.preferredSourceId = "screen:0:0";
                    settings.preferredSourceName = null;
                    saveSettings();
                    rebuildTrayMenu();
                } },
                { type: "separator" },
                {
                    label: "Include audio",
                    type: "checkbox",
                    checked: (typeof state.streamSound === "boolean") ? state.streamSound : (settings.streamSound !== false),
                    click: (item) => {
                        settings.streamSound = !!item.checked;
                        saveSettings();
                        commandQueue.push({
                            id: nextCommandId++,
                            action: "set-stream-sound",
                            userId: "self", sourceId: "", name: "",
                            sound: settings.streamSound,
                            createdAt: Date.now()
                        });
                        rebuildTrayMenu();
                    }
                }
            ]
        },
        { label: "Window layouts…", click: () => openLayoutsWindow() },
        { label: "Close window", submenu: closeSubmenu },
        { label: "Show / Hide all", accelerator: "Ctrl+Alt+H", click: () => toggleAllWindows() },
        { type: "separator" },
        {
            label: "Reset all positions",
            click: () => {
                for (const rec of windows.values()) {
                    if (rec.win && !rec.win.isDestroyed()) {
                        try { rec.win.setPosition(MARGIN_RIGHT, MARGIN_TOP); } catch (e) {}
                    }
                }
                scheduleSaveWindows();
            }
        },
        {
            label: "Opacity",
            submenu: [
                { label: "30%",  click: () => setOpacityAll(0.3) },
                { label: "50%",  click: () => setOpacityAll(0.5) },
                { label: "70%",  click: () => setOpacityAll(0.7) },
                { label: "90%",  click: () => setOpacityAll(0.9) },
                { label: "100%", click: () => setOpacityAll(1.0) }
            ]
        },
        { type: "separator" },
        {
            label: "Click-through on fullscreen",
            type: "checkbox",
            checked: settings.clickThroughOnGameFocus !== false,
            click: (item) => {
                settings.clickThroughOnGameFocus = !!item.checked;
                saveSettings();
                if (!settings.clickThroughOnGameFocus) {
                    setClickThrough(false);
                }
                rebuildTrayMenu();
            }
        }
    ];

    if (waitingLabel) {
        template.push({ type: "separator" });
        template.push({
            label: waitingLabel,
            submenu: [
                ...forgetSubmenu,
                { type: "separator" },
                { label: "Retry now", click: () => tryStartWaitingWindows() }
            ]
        });
    }

    template.push({ type: "separator" });
    template.push({ label: "Open /state in browser", click: () => shell.openExternal(`http://127.0.0.1:${PORT}/state`) });
    template.push({ label: "Open overlay in browser", click: () => shell.openExternal(`http://127.0.0.1:${PORT}/overlay.html`) });
    template.push({ type: "separator" });
    template.push({ label: "Restart", click: () => { app.relaunch(); isQuitting = true; app.quit(); } });
    template.push({ label: "Quit", accelerator: "Ctrl+Alt+Q", click: () => { isQuitting = true; app.quit(); } });

    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function toggleAllWindows() {
    const anyVisible = Array.from(windows.values())
        .some(rec => rec.win && !rec.win.isDestroyed() && rec.win.isVisible());
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        try { if (anyVisible) rec.win.hide(); else rec.win.show(); } catch (e) {}
    }
    if (anyVisible) clearNotifyState();
    else notifyChanged();
}

function setOpacityAll(val) {
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        try { rec.win.setOpacity(val); } catch (e) {}
    }
}

// =====================================================================
// Stream viewers (WebRTC receivers, or a local capture of my own stream)
// =====================================================================

// Which viewer a request is about; no key = the most recently opened one.
function viewerFor(key) {
    if (key != null && key !== "" && viewers.has(String(key))) return viewers.get(String(key));
    let last = null;
    for (const v of viewers.values()) last = v;
    return key ? null : last;
}

function viewerByWin(win) {
    for (const v of viewers.values()) if (v.win === win) return v;
    return null;
}

function wireVideoWindowIpc(win) {
    const ch = `vet-webrtc-${win.id}`;

    ipcMain.removeAllListeners(ch + ":answer");
    ipcMain.removeAllListeners(ch + ":ready");
    ipcMain.removeAllListeners(ch + ":alpha");

    ipcMain.on(ch + ":answer", (_e, payload) => {
        const v = viewerByWin(win);
        if (!v) return;
        v.answer = payload?.sdp || null;
        v.answerCandidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
        console.log("[webrtc] answer received from viewer", v.key);
    });

    ipcMain.on(ch + ":ready", () => {
        const v = viewerByWin(win);
        if (v && v.offer) {
            try { win.webContents.send("webrtc:offer", { sdp: v.offer, candidates: v.offerCandidates }); } catch (e) {}
        }
        try { win.webContents.send("video:alpha-state", _videoAlpha); } catch (e) {}
    });

    ipcMain.on(ch + ":alpha", (_e, alpha) => {
        const val = Math.max(0.2, Math.min(1, Number(alpha)));
        if (Number.isFinite(val)) {
            _videoAlpha = val;
            for (const v of viewers.values()) { try { v.win.setOpacity(val); } catch (e) {} }
            videoPrefs().alpha = val;
            saveSettingsSoon();
        }
    });

    win.webContents._vetIpcChannel = ch;
}

// What the plugin has to do to (re)start a viewer's picture.
function pluginStartCommand(v) {
    if (v.local) return null;
    if (v.camera) return ["watch-camera", v.userId, v.inst];
    if (v.own) return ["watch-own", v.userId, v.inst];
    return ["watch-stream", v.userId, v.inst];
}

// Reconnect = the same thing as closing and reopening the viewer, minus
// recreating the window: drop the plugin's capture, forget the old WebRTC
// handshake, reload the page and ask the plugin to watch from scratch.
// A local capture just reloads and captures again.
function reopenVideoStream(v, attempt) {
    if (!v || !v.win || v.win.isDestroyed()) return;
    if (!v.local) queuePluginCommand("stop-stream", v.key, "", v.inst);
    v.offer = null; v.offerCandidates = []; v.answer = null; v.answerCandidates = [];
    v.reopenAttempts = Math.max(1, attempt || 1);
    try { v.win.webContents.reload(); } catch (e) {}
    const cmd = pluginStartCommand(v);
    if (cmd) queuePluginCommand(cmd[0], cmd[1], "", cmd[2]);
}

// Where a new viewer opens: the saved place for the first, the next ones
// stepped down-right so they don't sit exactly on top of each other.
// Which places the active layout gives stream windows (falls back to the
// last remembered ones).
function layoutVideoPlaces() {
    const vp = videoPrefs();
    const prof = layoutProfiles()[_profileKey]?.video || {};
    return {
        bounds: boundsOnScreen(prof.bounds) ? prof.bounds : vp.bounds,
        previewBounds: boundsOnScreen(prof.previewBounds) ? prof.previewBounds : vp.previewBounds,
        extra: Array.isArray(prof.extra) && prof.extra.length ? prof.extra : (Array.isArray(vp.extraBounds) ? vp.extraBounds : [])
    };
}

// Stream windows are numbered in the order they were opened (my own stream
// included): #1 takes the main place (or the preview one, if that's how you
// left it), #2, #3... take the extra places from Setup. Without a place, a
// window steps left of the main one.
function placeForIndex(n) {
    const pl = layoutVideoPlaces();
    if (n === 0) {
        const preview = !!videoPrefs().preview && boundsOnScreen(pl.previewBounds);
        const base = preview ? pl.previewBounds : pl.bounds;
        return { bounds: boundsOnScreen(base) ? base : null, preview };
    }
    const ex = pl.extra[n - 1];
    if (boundsOnScreen(ex)) return { bounds: ex, preview: false };
    const base = boundsOnScreen(pl.bounds) ? pl.bounds : null;
    if (!base) return { bounds: null, preview: false };
    const b = { ...base, width: Math.round(base.width / 2), height: Math.round(base.height / 2) };
    b.x = base.x - n * (b.width + 12); b.y = base.y;
    return { bounds: boundsOnScreen(b) ? b : { ...base, x: base.x + n * 32, y: base.y + n * 32 }, preview: false };
}

// Viewers of one overlay instance. The main group ("") is the one that uses the
// saved layout places. A viewer's membership (v.main) is decided when it opens:
// no overlay id, or the first overlay window at that moment. Later changes in
// window order don't move existing viewers between groups.
function mainOverlayId() {
    const k = windows.keys().next().value;
    return k == null ? "" : String(k);
}
function isMainNow(inst) {
    return !inst || inst === mainOverlayId();
}
// Group of a viewer (or of a new one): "" = main group, else the overlay id.
function groupOf(main, inst) {
    return main ? "" : String(inst || "");
}
// viewersIn("") = main group; viewersIn(id) = viewers of that other overlay.
function viewersIn(group) {
    group = String(group || "");
    return [...viewers.values()].filter(v => group === "" ? !!v.main : (!v.main && v.inst === group));
}
function viewerKey(base, inst) {
    if (!base) return "";
    return base + (inst ? "@" + inst : "");
}

// Other overlay instances: a 640x360 box to the left of that overlay (to the
// right when there is no room), stepped by index within its group.
function overlayPlaceFor(inst, n) {
    const rec = windows.get(inst);
    if (!rec || !rec.win || rec.win.isDestroyed()) return { bounds: null, preview: false };
    let ob;
    try { ob = rec.win.getBounds(); } catch (e) { return { bounds: null, preview: false }; }
    const W = 640, H = 360, STEP = 652;
    let b = { x: ob.x - STEP - n * STEP, y: ob.y, width: W, height: H };
    if (!boundsOnScreen(b)) b = { x: ob.x + ob.width + 12 + n * STEP, y: ob.y, width: W, height: H };
    return { bounds: b, preview: false };
}

function placeFor(main, inst, n) {
    return main ? placeForIndex(n) : overlayPlaceFor(inst, n);
}

function viewerStartPlace(main, inst) {
    return placeFor(main, inst, viewersIn(groupOf(main, inst)).length);
}

// A window in the middle closed: the ones after it move up one place
// (e.g. #3 takes #2's place when #2 goes away). Only its own group.
function reflowViewers(group, fromIndex) {
    viewersIn(group).forEach((v, i) => {
        if (i < fromIndex || !v.win || v.win.isDestroyed()) return;
        const pl = placeFor(v.main, v.inst, i);
        if (!pl.bounds) return;
        if (i === 0 && v.main && pl.preview !== v.preview) v.preview = pl.preview;
        v.place = pl.bounds;
        try { v.win.setBounds(fitToAspect(pl.bounds, v.aspect)); } catch (e) {}
        try { v.win.webContents.executeJavaScript(`window.__vetSetPreview && window.__vetSetPreview(${v.preview});`).catch(() => {}); } catch (e) {}
    });
}

function openVideoWindow(params) {
    params = params || {};
    const userId = params.userId ? String(params.userId) : null;
    const inst = String(params.inst || "");
    const base = params.local ? "local:" + userId : params.camera ? "cam:" + userId : params.own ? "own:" + userId : userId;
    const key = String(params.key || viewerKey(base, inst) || "");
    if (!key) return;
    const existing = viewers.get(key);
    if (existing && existing.win && !existing.win.isDestroyed()) {
        existing.notLiveSince = 0;
        if (!existing.win.isVisible()) existing.win.showInactive();
        return;
    }
    const vp = videoPrefs();
    if (typeof vp.alpha === "number") _videoAlpha = Math.max(0.2, Math.min(1, vp.alpha));
    const main = isMainNow(inst);
    const place = viewerStartPlace(main, inst);
    const preview = place.preview;
    const startBounds = place.bounds;
    const win = new BrowserWindow({
        width: 640, height: 380, minWidth: 160, minHeight: 90,
        ...(startBounds || {}),
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: true, skipTaskbar: true, hasShadow: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
            backgroundThrottling: false
        }
    });
    const v = {
        key, userId, inst, main, win, params: { ...params, key, inst },
        local: !!params.local, camera: !!params.camera, own: !!params.own, sourceId: params.sourceId || null,
        preview, savedBounds: boundsOnScreen(vp.bounds) ? vp.bounds : null,
        place: startBounds || null,     // the layout's spot; sizing works from this, not from current bounds
        aspect: 0, notLiveSince: 0, reopenAttempts: 0,
        offer: null, offerCandidates: [], answer: null, answerCandidates: []
    };
    viewers.set(key, v);

    win.setAlwaysOnTop(true, "screen-saver");
    applyVideoClickThrough();
    win.setVisibleOnAllWorkspaces(true);
    try { win.setOpacity(_videoAlpha); } catch (e) {}
    win.loadFile(path.join(__dirname, "video.html"));

    wireVideoWindowIpc(win);
    wireVideoWindowLogging(win);
    win.on("move", () => saveVideoBoundsSoon(v));
    win.on("resize", () => saveVideoBoundsSoon(v));
    // Moved / resized by hand: it stays where you put it.
    win.on("will-move", () => { v.place = null; v._userMove = true; });
    win.on("will-resize", () => { v.place = null; v._userMove = true; });
    const userDone = () => { if (v._userMove) { v._userMove = false; updateActiveLayoutSoon(); } };
    win.on("moved", userDone);
    win.on("resized", userDone);

    // Runs on every load, including reloads done by reopenVideoStream().
    win.webContents.on("did-finish-load", () => {
        try {
            if (win.isDestroyed()) return;
            const ch = win.webContents._vetIpcChannel;
            const resume = v.reopenAttempts;
            v.reopenAttempts = 0;
            // A reload brings the window back onto the taskbar on Windows, and
            // a call right at load time doesn't always stick: repeat it.
            try { win.setSkipTaskbar(true); } catch (e) {}
            setTimeout(() => { try { if (!win.isDestroyed()) win.setSkipTaskbar(true); } catch (e) {} }, 600);
            v.paused = false;               // the page starts fresh; the next state re-sends it
            win.webContents.executeJavaScript(
                `window.__vetStreamParams = ${JSON.stringify(v.params)};` +
                (resume ? `if (window.__vetResumeReconnect) window.__vetResumeReconnect(${resume});` : "") +
                `if (window.__vetSetPreview) window.__vetSetPreview(${v.preview});` +
                `if (window.__vetSetZoom) window.__vetSetZoom(${JSON.stringify((videoPrefs().zoom || {})[v.key] || null)});` +
                (v.local ? `if (window.__vetStartLocal) window.__vetStartLocal(${JSON.stringify(v.sourceId)});`
                         : `if (window.vetWebRTC) window.vetWebRTC.setChannel(${JSON.stringify(ch)});`)
            );
        } catch (e) {}
    });

    // Don't steal focus from the game: a focused viewer stops the overlay's
    // fullscreen click-through/transparency.
    // Windows may nudge the size at creation (DPI scaling); put it exactly in
    // its place before showing.
    win.once("ready-to-show", () => {
        try {
            if (v.place) win.setBounds(fitToAspect(v.place, v.aspect));
            win.showInactive();
            win.setSkipTaskbar(true);
            // ...and once more after Windows has settled the new window
            setTimeout(() => { try { if (v.place && !win.isDestroyed()) win.setBounds(fitToAspect(v.place, v.aspect)); } catch (e) {} }, 300);
        } catch (e) {}
    });

    win.on("closed", () => {
        if (viewers.get(key) === v) {
            const g = groupOf(v.main, v.inst);
            const idx = viewersIn(g).indexOf(v);
            viewers.delete(key);
            if (!v._swapped) reflowViewers(g, idx);
        }
        // "closed": the window is gone for good (not a reconnect), so Discord can stop watching too
        if (!v.local) queuePluginCommand("stop-stream", key, v._swapped ? "" : "closed", v.inst);
    });
}

// What I'm streaming right now, as a capture id ("window:<hwnd>:0" / "screen:..").
function myStreamCaptureId() {
    const me = (Array.isArray(state.users) ? state.users : []).find(u => u.isSelf);
    if (!me || !me.streaming || !me.streamSourceId) return null;
    let src = String(me.streamSourceId);
    const sh = /^screen-handle:(\d+)/.exec(src);
    if (sh) {
        const scr = cachedSources.find(s => s.type === "screen" && String(s.handle) === sh[1]);
        src = scr ? scr.id : "screen:0:0";
    }
    return { userId: me.userId, src };
}

// My own stream: from Discord's pipeline via the plugin (what Discord
// captured to send); if Discord has none, a local capture of the window.
function openOwnStream(winId) {
    const cur = myStreamCaptureId();
    if (!cur) { videoLog("own stream: not streaming"); return; }
    const inst = String(winId || "");
    if (viewers.has(viewerKey("own:" + cur.userId, inst)) || viewers.has(viewerKey("local:" + cur.userId, inst))) return;
    openVideoWindow({ own: true, userId: cur.userId, inst });
    queuePluginCommand("watch-own", cur.userId, "", inst);
}

// The plugin couldn't get Discord's own-stream track: swap to local capture.
function ownStreamToLocal(winId) {
    const cur = myStreamCaptureId();
    if (!cur) return;
    const inst = String(winId || "");
    const ownKey = viewerKey("own:" + cur.userId, inst);
    const v = viewers.get(ownKey);
    let bounds = null;
    const order = [...viewers.keys()];
    if (v && v.win && !v.win.isDestroyed()) {
        try { bounds = v.win.getBounds(); } catch (e) {}
        v.local = true;                 // its "closed" handler must not ask the plugin for anything
        v._swapped = true;              // ...nor move the others
        viewers.delete(v.key);
        try { v.win.close(); } catch (e) {}
    }
    openVideoWindow({ local: true, userId: cur.userId, sourceId: cur.src, inst });
    const nk = viewerKey("local:" + cur.userId, inst);
    const nv = viewers.get(nk);
    if (nv) {
        if (bounds) { try { nv.win.setBounds(bounds); } catch (e) {} }
        // put it back where the "own" window was in the order
        const at = order.indexOf(ownKey);
        if (at >= 0) {
            const rest = [...viewers.entries()].filter(([k]) => k !== nk);
            rest.splice(Math.min(at, rest.length), 0, [nk, nv]);
            viewers.clear();
            for (const [k, x] of rest) viewers.set(k, x);
        }
    }
}

// I switched what I stream: the "my stream" viewer follows.
function followMyStreamSource() {
    const cur = myStreamCaptureId();
    if (!cur) return;
    for (const v of viewers.values()) {
        if (!v.local || v.sourceId === cur.src || !v.win || v.win.isDestroyed()) continue;
        videoLog("own stream source changed", v.sourceId, "->", cur.src);
        v.sourceId = cur.src;
        v.params.sourceId = cur.src;
        try {
            v.win.webContents.executeJavaScript(
                `window.__vetStreamParams = ${JSON.stringify(v.params)};` +
                `if (window.__vetStartLocal) window.__vetStartLocal(${JSON.stringify(cur.src)});`).catch(() => {});
        } catch (e) {}
    }
}
// =====================================================================
// Stream window log file: server/logs/video.log (rotated at 5 MB)
// =====================================================================
const VIDEO_LOG_DIR = path.join(__dirname, "logs");
const VIDEO_LOG_FILE = path.join(VIDEO_LOG_DIR, "video.log");
function appendLog(file, text) {
    try {
        fs.mkdirSync(VIDEO_LOG_DIR, { recursive: true });
        try {
            if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + ".old");
        } catch (e) {}
        fs.appendFile(file, text, () => {});
    } catch (e) {}
}
const PLUGIN_LOG_FILE = path.join(VIDEO_LOG_DIR, "plugin.log");

function videoLog(...args) {
    try {
        fs.mkdirSync(VIDEO_LOG_DIR, { recursive: true });
        try {
            if (fs.statSync(VIDEO_LOG_FILE).size > 5 * 1024 * 1024) {
                fs.renameSync(VIDEO_LOG_FILE, VIDEO_LOG_FILE + ".old");
            }
        } catch (e) {}
        const line = new Date().toISOString() + " " + args.map(a =>
            typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })()
        ).join(" ") + "\n";
        fs.appendFile(VIDEO_LOG_FILE, line, () => {});
    } catch (e) {}
}

function wireVideoWindowLogging(win) {
    const wc = win.webContents;
    videoLog("=== video window opened ===");
    wc.on("console-message", (...a) => {
        // Electron passes either (event, level, message, line, sourceId) or (event{level,message,...})
        const ev = a[0] || {};
        const level = typeof a[1] === "number" ? a[1] : ev.level;
        const msg = typeof a[2] === "string" ? a[2] : ev.message;
        videoLog("[console:" + level + "]", String(msg));
    });
    wc.on("render-process-gone", (_e, d) => videoLog("RENDER PROCESS GONE", d));
    wc.on("unresponsive", () => videoLog("WINDOW UNRESPONSIVE"));
    wc.on("responsive", () => videoLog("window responsive again"));
    wc.on("did-fail-load", (_e, code, desc) => videoLog("did-fail-load", code, desc));
    win.on("closed", () => videoLog("=== video window closed ==="));
}
app.on("child-process-gone", (_e, d) => videoLog("CHILD PROCESS GONE", d));

// One viewer by key (no key = all of them).
function closeVideoWindow(key) {
    const list = key ? [viewers.get(String(key))].filter(Boolean) : [...viewers.values()];
    for (const v of list) {
        try { if (v.win && !v.win.isDestroyed()) v.win.close(); } catch (e) {}
    }
}

function queuePluginCommand(action, userId, name, sourceId = "") {
    commandQueue.push({
        id: nextCommandId++, action, userId: String(userId || ""),
        sourceId: sourceId ? String(sourceId) : "", name: name || "", sound: null, createdAt: Date.now()
    });
    flushCommandWaiters();
}

// -- Is what a viewer shows still on? (stream live / camera on) --
const VIDEO_AUTOCLOSE_MS = 3000;

function isVideoStreamLive(userId) {
    if (!userId || !state.channelId) return false;
    const users = Array.isArray(state.users) ? state.users : [];
    const u = users.find(x => String(x.userId) === String(userId));
    return !!(u && u.streaming);
}

function isViewerLive(v) {
    if (!v.userId || !state.channelId) return false;
    const u = (Array.isArray(state.users) ? state.users : []).find(x => String(x.userId) === v.userId);
    return !!u && (v.camera ? !!u.video : !!u.streaming);
}

// Keep stream viewers off the taskbar whatever Windows does after reloads.
setInterval(() => {
    for (const v of viewers.values()) {
        try { if (v.win && !v.win.isDestroyed()) v.win.setSkipTaskbar(true); } catch (e) {}
    }
}, 2000);

// Streamer's window minimized (Discord pauses the stream): the viewer shows a
// calm "paused" card instead of reconnecting.
function updateViewerPaused() {
    const users = Array.isArray(state.users) ? state.users : [];
    for (const v of viewers.values()) {
        if (v.camera || v.local || !v.win || v.win.isDestroyed()) continue;
        const u = users.find(x => String(x.userId) === v.userId);
        const paused = !!(u && u.streaming && u.streamPaused);
        if (paused === !!v.paused) continue;
        v.paused = paused;
        if (paused) v.reopenAttempts = 0;
        videoLog("stream", paused ? "paused" : "resumed", v.key);
        try { v.win.webContents.executeJavaScript(`window.__vetSetPaused && window.__vetSetPaused(${paused}, ${!!v.own});`).catch(() => {}); } catch (e) {}
    }
}

function checkVideoAutoClose() {
    if (!isPluginAlive()) return;   // no fresh info: don't guess
    followMyStreamSource();
    updateViewerPaused();
    for (const v of [...viewers.values()]) {
        if (isViewerLive(v)) { v.notLiveSince = 0; continue; }
        if (!v.notLiveSince) { v.notLiveSince = Date.now(); continue; }
        if (Date.now() - v.notLiveSince >= VIDEO_AUTOCLOSE_MS) {
            videoLog("auto-close: ended or left voice", v.key);
            closeVideoWindow(v.key);
        }
    }
}

// -- Saved opacity / position (normal and preview modes) --
function videoPrefs() {
    if (!settings.video || typeof settings.video !== "object") settings.video = {};
    return settings.video;
}

function boundsOnScreen(b) {
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
    return screen.getAllDisplays().some(d => {
        const a = d.workArea;
        const ix = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
        const iy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
        return ix >= 80 && iy >= 40;
    });
}

// The first viewer's place is the remembered one; extra viewers don't
// overwrite it.
function saveVideoBoundsSoon(v) {
    if (v._saveTimer) clearTimeout(v._saveTimer);
    v._saveTimer = setTimeout(() => {
        v._saveTimer = null;
        if (!v.win || v.win.isDestroyed()) return;
        if (viewersIn("")[0] !== v) return;
        const p = videoPrefs();
        const b = v.win.getBounds();
        if (v.preview) p.previewBounds = b; else p.bounds = b;
        p.preview = v.preview;
        saveSettings();
    }, 500);
}

// Lock the window to the stream's aspect ratio and fit the current size to it:
// keep the width, adjust the height (so no black bars).
function fitToAspect(b, aspect) {
    if (!aspect) return b;
    return { x: b.x, y: b.y, width: b.width, height: Math.max(90, Math.round(b.width / aspect)) };
}
function applyVideoAspect(v, w, h) {
    if (!v || !v.win || v.win.isDestroyed() || !(w > 0) || !(h > 0)) return;
    const aspect = w / h;
    if (Math.abs(aspect - v.aspect) < 0.01) return;
    v.aspect = aspect;
    try {
        v.win.setAspectRatio(aspect);
        v.win.setBounds(fitToAspect(v.place || v.win.getBounds(), aspect));
    } catch (e) {}
    videoLog("aspect locked", v.key, w + "x" + h);
}

function toggleVideoPreview(v) {
    if (!v || !v.win || v.win.isDestroyed()) return;
    const first = viewersIn("")[0] === v;
    const p = videoPrefs();
    const cur = v.win.getBounds();
    if (!v.preview) {
        if (first) p.bounds = cur;
        v.savedBounds = cur;
        const target = boundsOnScreen(p.previewBounds) && first ? p.previewBounds
            : { x: cur.x + cur.width - 320, y: cur.y, width: 320, height: 180 };
        // keep the stream's proportions in preview too
        v.preview = true;
        v.place = target;
        v.win.setBounds(fitToAspect(target, v.aspect));
    } else {
        if (first) p.previewBounds = cur;
        const target = first && boundsOnScreen(p.bounds) ? p.bounds : v.savedBounds;
        v.preview = false;
        if (target) { v.place = target; v.win.setBounds(fitToAspect(target, v.aspect)); }
    }
    if (first) { p.preview = v.preview; saveSettings(); }
    try {
        v.win.webContents.executeJavaScript(
            `if (window.__vetSetPreview) window.__vetSetPreview(${v.preview});` +
            (v.preview ? "" : `if (window.__vetSetZoom) window.__vetSetZoom(${JSON.stringify((p.zoom || {})[v.key] || null)});`)
        ).catch(() => {});
    } catch (e) {}
}

function openSenderWindow() {
    if (senderWindow && !senderWindow.isDestroyed()) { senderWindow.focus(); return; }
    senderWindow = new BrowserWindow({
        width: 400, height: 300, frame: true,
        alwaysOnTop: false, resizable: true, skipTaskbar: true, show: false,
        webPreferences: {
            nodeIntegration: false, contextIsolation: true,
            backgroundThrottling: false, webSecurity: false
        }
    });
    senderWindow.loadFile(path.join(__dirname, "sender.html"));
    senderWindow.once("ready-to-show", () => senderWindow.show());
    senderWindow.on("closed", () => { senderWindow = null; });
}

function createTray() {
    tray = new Tray(buildTrayIcon());
    tray.setToolTip("VoiceEncounterTracker Overlay");
    rebuildTrayMenu();
    tray.on("click", () => toggleAllWindows());
}

// =====================================================================
// Lifecycle
// =====================================================================

// Only one overlay may run: a second copy stacks a duplicate window on top
// and can't bind the HTTP port.
if (!app.requestSingleInstanceLock()) {
    console.log("[overlay] another instance is already running, exiting");
    app.quit();
    process.exit(0);
}

app.whenReady().then(async () => {
    loadSettings();
    await refreshSources(true);
    startServer();
    restoreWindowsOnStartup();
    createTray();
    startLivenessWatchdog();
    setInterval(checkVideoAutoClose, 1000);
    startMonitorRetryTimer();
    startNetTicker();
    startCursorWatchdog();

    setInterval(() => {
        refreshSources(true).then(rebuildTrayMenu).catch(() => {});
    }, 60_000);

    screen.on("display-added", () => {
        scheduleRetryWaiting();
        refreshSources(true).then(rebuildTrayMenu).catch(() => {});
    });
    screen.on("display-removed", () => {
        const displays = screen.getAllDisplays();
        const toClose = [];
        for (const rec of windows.values()) {
            const stillThere = rec.monitor && findMonitorFor({ monitor: rec.monitor }, displays);
            if (!stillThere) toClose.push(rec);
        }
        for (const rec of toClose) { try { rec.win.close(); } catch (e) {} }
        rebuildTrayMenu();
    });

    globalShortcut.register("CommandOrControl+Alt+N", () => createNewWindow());
    globalShortcut.register("CommandOrControl+Alt+H", () => toggleAllWindows());
    globalShortcut.register("CommandOrControl+Alt+Q", () => { isQuitting = true; app.quit(); });

    app.on("activate", () => {
        if (windows.size === 0 && waitingWindows.size === 0) createNewWindow();
    });
});

app.on("window-all-closed", (e) => { e?.preventDefault?.(); });
app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => {
    if (popupWindow && !popupWindow.isDestroyed()) { try { popupWindow.close(); } catch (e) {} }
    globalShortcut.unregisterAll();
    for (const id of [...notifyWindows.keys()]) destroyNotifyWindow(id);
    stopFgProbe();
    if (_monitorRetryTimer) clearInterval(_monitorRetryTimer);
    if (_saveWindowsTimer) clearTimeout(_saveWindowsTimer);
    if (server) { try { server.close(); } catch (e) {} }
    if (tray)   { try { tray.destroy(); } catch (e) {} }
});