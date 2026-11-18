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
const STATS_HEIGHT     = 54;

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
let videoWindow = null;
let notifyWindow = null;
let menuWindow = null;
let tipWindow = null;
let senderWindow = null;

let _webrtcOffer = null;
let _webrtcOfferCandidates = [];
let _webrtcAnswer = null;
let _webrtcAnswerCandidates = [];

let _webrtcIceForSender = [];
let _webrtcIceForReceiver = [];

let _videoFullscreenState = false;
let _videoPreviewState = false;
let _videoSavedBounds = null;
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
    if (!videoWindow || videoWindow.isDestroyed()) return;
    try { videoWindow.setIgnoreMouseEvents(_clickThroughState, { forward: false }); } catch (e) {}
    try { videoWindow.setFocusable(!_clickThroughState); } catch (e) {}
}

let _lastFgSig = "";
function startCursorWatchdog() {
    setInterval(async () => {
        try {
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
            noteForegroundForProfiles(info.pid, isFullscreen || (cursorHidden && !!info.clipped));

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
            if (!IsWindowVisible(h)) return true;
            if (GetWindow(h, 4) != IntPtr.Zero) return true;              // owned (dialogs, popups)
            int ex = GetWindowLong(h, -20);
            if ((ex & 0x80) != 0) return true;                             // tool window
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
        // Windows Chromium didn't list (minimized and the like)
        const seenHwnd = new Set(hwnds);
        const extra = (await enumerateTopWindows()).filter(w => !seenHwnd.has(w.hwnd) && w.pid !== process.pid);
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
                _webrtcOffer = parsed.offer || null;
                _webrtcOfferCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                // A new offer invalidates the previous answer; otherwise the plugin
                // picks up the stale one and the new connection never comes up.
                _webrtcAnswer = null;
                _webrtcAnswerCandidates = [];

                if (videoWindow && !videoWindow.isDestroyed()) {
                    try {
                        videoWindow.webContents.send("webrtc:offer", {
                            sdp: _webrtcOffer,
                            candidates: _webrtcOfferCandidates
                        });
                    } catch (e) {}
                }
                jsonReply(res, 200, { ok: true });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/webrtc/offer") {
            jsonReply(res, 200, { offer: _webrtcOffer, candidates: _webrtcOfferCandidates });
            return;
        }
        if (req.method === "POST" && url === "/webrtc/answer") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                _webrtcAnswer = parsed.answer || null;
                _webrtcAnswerCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
                jsonReply(res, 200, { ok: true });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/webrtc/answer") {
            jsonReply(res, 200, { answer: _webrtcAnswer, candidates: _webrtcAnswerCandidates });
            return;
        }
        if (req.method === "POST" && url === "/webrtc/reset") {
            _webrtcOffer = null;
            _webrtcOfferCandidates = [];
            _webrtcAnswer = null;
            _webrtcAnswerCandidates = [];
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
            closeVideoWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/aspect") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                applyVideoAspect(Number(d.width), Number(d.height));
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/reconnect") {
            const live = isVideoStreamLive(_videoUserId);
            let attempt = 0;
            try { attempt = Number(JSON.parse(await readBody(req) || "{}").attempt) || 0; } catch (e) {}
            if (live) {
                videoLog("reconnect requested by viewer for", _videoUserId, "attempt", attempt);
                reopenVideoStream(attempt);
            }
            jsonReply(res, 200, { ok: true, live, pluginAlive: isPluginAlive() });
            return;
        }
        if (req.method === "POST" && url === "/video/zoom") {
            try {
                const d = JSON.parse(await readBody(req) || "{}");
                if (_videoUserId) {
                    const vp = videoPrefs();
                    vp.zoom = vp.zoom && typeof vp.zoom === "object" ? vp.zoom : {};
                    if (Number(d.z) > 1) vp.zoom[_videoUserId] = { z: Number(d.z), cx: Number(d.cx), cy: Number(d.cy) };
                    else delete vp.zoom[_videoUserId];
                    saveSettingsSoon();
                }
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/preview") {
            toggleVideoPreview();
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
                state = Object.assign({ updatedAt: Date.now() }, JSON.parse(body));
                lastPluginSeen = Date.now();
                jsonReply(res, 200, { ok: true });
                broadcastState();
                applyAutoResizeAll();
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
                if (d.channelId) incomingCall = {
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
                    setNotifyTyping(false);
                    notifyChanged();
                }
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/size") {
            try {
                const h = Number(JSON.parse(await readBody(req) || "{}").height);
                if (Number.isFinite(h) && h > 0 && h !== notifyContentH) { notifyContentH = h; positionNotifyWindow(); }
            } catch (e) {}
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/notify/typing") {
            try { setNotifyTyping(!!JSON.parse(await readBody(req) || "{}").on); } catch (e) {}
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
let notifyContentH = 0;      // height the page reports for its content
let notifyTyping = false;    // reply box open: the window takes keyboard + mouse

function addNotification(n) {
    if (!n || !n.id || !n.channelId) return;
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
    if (notifications.length === 0 && !incomingCall) {
        if (notifyWindow && !notifyWindow.isDestroyed()) { try { notifyWindow.hide(); } catch (e) {} }
        return;
    }
    ensureNotifyWindow();
    positionNotifyWindow();
    if (notifyWindow && !notifyWindow.isDestroyed() && notifyWindow.webContents.isLoading() === false && !notifyWindow.isVisible()) {
        try { notifyWindow.showInactive(); } catch (e) {}
    }
}

setInterval(() => {
    const now = Date.now();
    const before = notifications.length;
    // Cards don't expire while a reply is being typed.
    if (notifyTyping) return;
    notifications = notifications.filter(n => n.expiresAt > now);
    if (notifications.length !== before) notifyChanged();
}, 1000);

function notifyAnchor() {
    for (const rec of windows.values()) {
        if (rec.win && !rec.win.isDestroyed() && rec.win.isVisible()) return rec.win;
    }
    return null;
}

function ensureNotifyWindow() {
    if (notifyWindow && !notifyWindow.isDestroyed()) return;
    notifyWindow = new BrowserWindow({
        width: WINDOW_WIDTH, height: NOTIFY_ITEM_H,
        frame: false, transparent: true, backgroundColor: "#00000000",
        alwaysOnTop: true, resizable: false, skipTaskbar: true, hasShadow: false,
        focusable: false, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    });
    notifyWindow.setAlwaysOnTop(true, "screen-saver");
    notifyWindow.setVisibleOnAllWorkspaces(true);
    applyNotifyClickThrough();
    notifyWindow.loadFile(path.join(__dirname, "notify.html"));
    notifyWindow.webContents.on("did-finish-load", () => {
        try {
            notifyWindow.webContents.executeJavaScript(
                `document.body.classList.toggle("click-through", ${_clickThroughState});`).catch(() => {});
        } catch (e) {}
        if (notifications.length) { positionNotifyWindow(); try { notifyWindow.showInactive(); } catch (e) {} }
    });
    notifyWindow.on("closed", () => { notifyWindow = null; });
}

function positionNotifyWindow() {
    if (!notifyWindow || notifyWindow.isDestroyed()) return;
    const anchor = notifyAnchor();
    const h = notifyContentH > 0 ? notifyContentH
        : Math.max(1, notifications.length + (incomingCall ? 2 : 0)) * NOTIFY_ITEM_H;
    try {
        if (anchor) {
            const [ax, ay] = anchor.getPosition();
            const [aw, ah] = anchor.getSize();
            notifyWindow.setBounds({ x: ax, y: ay + ah + 4, width: aw, height: h });
        } else {
            const [w] = notifyWindow.getSize();
            const [x, y] = notifyWindow.getPosition();
            notifyWindow.setBounds({ x, y, width: w, height: h });
        }
    } catch (e) {}
}

// Typing a reply needs keyboard focus; otherwise the window never takes focus
// (so it can't pull the game out of fullscreen).
function setNotifyTyping(on) {
    notifyTyping = !!on;
    if (!notifyWindow || notifyWindow.isDestroyed()) return;
    try {
        notifyWindow.setFocusable(notifyTyping);
        if (notifyTyping) notifyWindow.focus();
    } catch (e) {}
    applyNotifyClickThrough();
}

// In a game (cursor hidden) the cards are display-only; with the cursor
// visible they can be clicked (open chat / dismiss).
function applyNotifyClickThrough() {
    if (!notifyWindow || notifyWindow.isDestroyed()) return;
    const ignore = _clickThroughState && !notifyTyping;
    try { notifyWindow.setIgnoreMouseEvents(ignore, { forward: false }); } catch (e) {}
    try {
        notifyWindow.webContents.executeJavaScript(
            `document.body.classList.toggle("click-through", ${_clickThroughState});`).catch(() => {});
    } catch (e) {}
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

async function noteForegroundForProfiles(pid, gameLike) {
    if (!pid) return;
    let key = "default";
    if (gameLike) {
        const exe = await exeForPid(pid);
        if (!exe) return;
        key = exe;
    }
    if (key === _profileKey) return;
    const prev = _profileKey;
    _profileKey = key;
    const profiles = layoutProfiles();
    // First switch away from a context without a profile: keep where things
    // were, so coming back restores it.
    if (!profiles[prev]) saveLayoutProfile(prev);
    if (profiles[key]) applyLayoutProfile(profiles[key]);
    videoLog("[layout] profile", prev, "->", key, profiles[key] ? "(applied)" : "(none yet)");
}

function layoutProfiles() {
    if (!settings.layoutProfiles || typeof settings.layoutProfiles !== "object") settings.layoutProfiles = {};
    return settings.layoutProfiles;
}

function saveLayoutProfile(key) {
    const p = { windows: {} };
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        const [x, y] = rec.win.getPosition();
        p.windows[rec.id] = { x, y };
    }
    if (!Object.keys(p.windows).length) return;
    layoutProfiles()[key] = p;
    saveSettingsSoon();
}

function applyLayoutProfile(p) {
    _applyingProfile = true;
    try {
        for (const rec of windows.values()) {
            const pos = p.windows?.[rec.id];
            if (!pos || !rec.win || rec.win.isDestroyed()) continue;
            if (!boundsOnScreen({ x: pos.x, y: pos.y, width: rec.width || WINDOW_WIDTH, height: rec.height || HEIGHT_IDLE })) continue;
            rec.win.setPosition(pos.x, pos.y);
            rec.x = pos.x; rec.y = pos.y;
        }
        scheduleSaveWindows();
        positionNotifyWindow();
    } catch (e) {}
    setTimeout(() => { _applyingProfile = false; }, 300);
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

function buildStateResponse() {
    if (sessionNote && sessionNote.channelId !== state.channelId) sessionNote = null;   // left / moved: note is gone
    return { ...state, pluginAlive: isPluginAlive(), net: buildNetResponse(), note: sessionNote ? sessionNote.text : null };
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
        else if (state.returnTo) cards = 1;
    }
    const statsExtra = (alive && !state.channelId && state.leaveStats) ? STATS_HEIGHT : 0;
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
    positionNotifyWindow();
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

    win.on("moved", () => {
        try {
            const [x, y] = win.getPosition();
            rec.x = x; rec.y = y;
            const d = monitorForWindow(win);
            if (d) rec.monitor = displayToMonitorRecord(d);
            scheduleSaveWindows();
            positionNotifyWindow();
            if (!_applyingProfile) saveLayoutProfile(_profileKey);
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
        windows.delete(rec.id);
        scheduleSaveWindows();
        rebuildTrayMenu();
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
}

function setOpacityAll(val) {
    for (const rec of windows.values()) {
        if (!rec.win || rec.win.isDestroyed()) continue;
        try { rec.win.setOpacity(val); } catch (e) {}
    }
}

// =====================================================================
// Video window (WebRTC receiver)
// =====================================================================

function wireVideoWindowIpc(win) {
    const ch = `vet-webrtc-${win.id}`;

    ipcMain.removeAllListeners(ch + ":answer");
    ipcMain.removeAllListeners(ch + ":ready");
    ipcMain.removeAllListeners(ch + ":alpha");

    ipcMain.on(ch + ":answer", (_e, payload) => {
        _webrtcAnswer = payload?.sdp || null;
        _webrtcAnswerCandidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
        console.log("[webrtc] answer received from video window");
    });

    ipcMain.on(ch + ":ready", () => {
        if (_webrtcOffer) {
            try {
                win.webContents.send("webrtc:offer", {
                    sdp: _webrtcOffer,
                    candidates: _webrtcOfferCandidates
                });
            } catch (e) {}
        }
        try { win.webContents.send("video:alpha-state", _videoAlpha); } catch (e) {}
    });

    ipcMain.on(ch + ":alpha", (_e, alpha) => {
        const v = Math.max(0.2, Math.min(1, Number(alpha)));
        if (Number.isFinite(v)) {
            _videoAlpha = v;
            try { win.setOpacity(v); } catch (e) {}
            videoPrefs().alpha = v;
            saveSettingsSoon();
        }
    });

    win.webContents._vetIpcChannel = ch;
}

let _videoParams = {};
let _videoReopenAttempts = 0;

// Reconnect = the same thing as closing and reopening the viewer, minus
// recreating the window: drop the plugin's capture, forget the old WebRTC
// handshake, reload the page and ask the plugin to watch from scratch.
function reopenVideoStream(attempt) {
    if (!videoWindow || videoWindow.isDestroyed() || !_videoUserId) return;
    const userId = _videoUserId;
    queuePluginCommand("stop-stream", userId);
    _webrtcOffer = null;
    _webrtcOfferCandidates = [];
    _webrtcAnswer = null;
    _webrtcAnswerCandidates = [];
    _webrtcIceForSender = [];
    _webrtcIceForReceiver = [];
    _videoReopenAttempts = Math.max(1, attempt || 1);
    try { videoWindow.webContents.reload(); } catch (e) {}
    queuePluginCommand("watch-stream", userId);
}

function openVideoWindow(params) {
    if (params && params.userId) { _videoUserId = String(params.userId); _videoNotLiveSince = 0; }
    if (videoWindow && !videoWindow.isDestroyed()) {
        if (!videoWindow.isVisible()) videoWindow.showInactive();
        return;
    }
    const vp = videoPrefs();
    if (typeof vp.alpha === "number") _videoAlpha = Math.max(0.2, Math.min(1, vp.alpha));
    _videoPreviewState = !!vp.preview && boundsOnScreen(vp.previewBounds);
    const startBounds = _videoPreviewState ? vp.previewBounds
        : (boundsOnScreen(vp.bounds) ? vp.bounds : null);
    _videoSavedBounds = boundsOnScreen(vp.bounds) ? vp.bounds : null;
    videoWindow = new BrowserWindow({
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
    videoWindow.setAlwaysOnTop(true, "screen-saver");
    applyVideoClickThrough();
    videoWindow.setVisibleOnAllWorkspaces(true);
    try { videoWindow.setOpacity(_videoAlpha); } catch (e) {}
    videoWindow.loadFile(path.join(__dirname, "video.html"));

    wireVideoWindowIpc(videoWindow);
    wireVideoWindowLogging(videoWindow);
    videoWindow.on("move", saveVideoBoundsSoon);
    videoWindow.on("resize", saveVideoBoundsSoon);

    _videoParams = params || {};
    // Runs on every load, including reloads done by reopenVideoStream().
    videoWindow.webContents.on("did-finish-load", () => {
        try {
            if (!videoWindow || videoWindow.isDestroyed()) return;
            const ch = videoWindow.webContents._vetIpcChannel;
            const resume = _videoReopenAttempts;
            _videoReopenAttempts = 0;
            videoWindow.webContents.executeJavaScript(
                `window.__vetStreamParams = ${JSON.stringify(_videoParams || {})};` +
                (resume ? `if (window.__vetResumeReconnect) window.__vetResumeReconnect(${resume});` : "") +
                `if (window.__vetSetPreview) window.__vetSetPreview(${_videoPreviewState});` +
                `if (window.__vetSetZoom) window.__vetSetZoom(${JSON.stringify((videoPrefs().zoom || {})[_videoUserId] || null)});` +
                `if (window.vetWebRTC) window.vetWebRTC.setChannel(${JSON.stringify(ch)});`
            );
        } catch (e) {}
    });

    // Don't steal focus from the game: a focused viewer stops the overlay's
    // fullscreen click-through/transparency.
    videoWindow.once("ready-to-show", () => {
        videoWindow.showInactive();
    });

    videoWindow.on("closed", () => {
        videoWindow = null;
        if (_videoUserId) queuePluginCommand("stop-stream", _videoUserId);
        _videoUserId = null;
        _videoNotLiveSince = 0;
        _videoAspect = 0;
        _videoFullscreenState = false;
        _videoPreviewState = false;
        _videoSavedBounds = null;

        _webrtcOffer = null;
        _webrtcOfferCandidates = [];
        _webrtcAnswer = null;
        _webrtcAnswerCandidates = [];
    });
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

function closeVideoWindow() {
    if (videoWindow && !videoWindow.isDestroyed()) {
        try { videoWindow.close(); } catch (e) {}
    }
    videoWindow = null;
}

function queuePluginCommand(action, userId, name) {
    commandQueue.push({
        id: nextCommandId++, action, userId: String(userId || ""),
        sourceId: "", name: name || "", sound: null, createdAt: Date.now()
    });
    flushCommandWaiters();
}

// -- Which stream the viewer shows, and whether it is still live --
let _videoUserId = null;
let _videoNotLiveSince = 0;
const VIDEO_AUTOCLOSE_MS = 3000;

function isVideoStreamLive(userId) {
    if (!userId || !state.channelId) return false;
    const users = Array.isArray(state.users) ? state.users : [];
    const u = users.find(x => String(x.userId) === String(userId));
    return !!(u && u.streaming);
}

function checkVideoAutoClose() {
    if (!videoWindow || videoWindow.isDestroyed() || !_videoUserId) { _videoNotLiveSince = 0; return; }
    if (!isPluginAlive()) return;   // no fresh info: don't guess
    if (isVideoStreamLive(_videoUserId)) { _videoNotLiveSince = 0; return; }
    if (!_videoNotLiveSince) { _videoNotLiveSince = Date.now(); return; }
    if (Date.now() - _videoNotLiveSince >= VIDEO_AUTOCLOSE_MS) {
        videoLog("auto-close: stream ended or left voice", _videoUserId);
        closeVideoWindow();
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

let _videoSaveTimer = null;
function saveVideoBoundsSoon() {
    if (_videoSaveTimer) clearTimeout(_videoSaveTimer);
    _videoSaveTimer = setTimeout(() => {
        _videoSaveTimer = null;
        if (!videoWindow || videoWindow.isDestroyed()) return;
        const p = videoPrefs();
        const b = videoWindow.getBounds();
        if (_videoPreviewState) p.previewBounds = b; else p.bounds = b;
        p.preview = _videoPreviewState;
        saveSettings();
    }, 500);
}

// Lock the window to the stream's aspect ratio and fit the current size to it:
// keep the width, adjust the height (so no black bars).
let _videoAspect = 0;
function fitToAspect(b, aspect) {
    if (!aspect) return b;
    return { x: b.x, y: b.y, width: b.width, height: Math.max(90, Math.round(b.width / aspect)) };
}
function applyVideoAspect(w, h) {
    if (!videoWindow || videoWindow.isDestroyed() || !(w > 0) || !(h > 0)) return;
    const aspect = w / h;
    if (Math.abs(aspect - _videoAspect) < 0.01) return;
    _videoAspect = aspect;
    try {
        videoWindow.setAspectRatio(aspect);
        videoWindow.setBounds(fitToAspect(videoWindow.getBounds(), aspect));
    } catch (e) {}
    videoLog("aspect locked", w + "x" + h);
}

function toggleVideoPreview() {
    if (!videoWindow || videoWindow.isDestroyed()) return;
    const p = videoPrefs();
    const cur = videoWindow.getBounds();
    if (!_videoPreviewState) {
        p.bounds = cur;
        _videoSavedBounds = cur;
        const target = boundsOnScreen(p.previewBounds) ? p.previewBounds
            : { x: cur.x + cur.width - 320, y: cur.y, width: 320, height: 180 };
        // keep the stream's proportions in preview too
        _videoPreviewState = true;
        videoWindow.setBounds(fitToAspect(target, _videoAspect));
    } else {
        p.previewBounds = cur;
        const target = boundsOnScreen(p.bounds) ? p.bounds : _videoSavedBounds;
        _videoPreviewState = false;
        if (target) videoWindow.setBounds(fitToAspect(target, _videoAspect));
    }
    p.preview = _videoPreviewState;
    saveSettings();
    try {
        videoWindow.webContents.executeJavaScript(
            `if (window.__vetSetPreview) window.__vetSetPreview(${_videoPreviewState});` +
            (_videoPreviewState ? "" : `if (window.__vetSetZoom) window.__vetSetZoom(${JSON.stringify((p.zoom || {})[_videoUserId] || null)});`)
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
    stopFgProbe();
    if (_monitorRetryTimer) clearInterval(_monitorRetryTimer);
    if (_saveWindowsTimer) clearTimeout(_saveWindowsTimer);
    if (server) { try { server.close(); } catch (e) {} }
    if (tray)   { try { tray.destroy(); } catch (e) {} }
});