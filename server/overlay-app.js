/**
 * VoiceEncounterTracker Overlay
 */

const {
    app, BrowserWindow, screen, globalShortcut, Tray, Menu,
    nativeImage, shell, desktopCapturer, ipcMain
} = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

// ─── Chromium flags: kill occlusion detection + background throttling ───
// Windows/Chromium pause requestAnimationFrame when the window is minimized
// or occluded. This breaks our video.html frame pump (draw gaps of 5–10s).
// These switches must be applied before app.whenReady().
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
const HEIGHT_IDLE      = 78;
const HEIGHT_EMPTY_VC  = 60;
const ROW_HEIGHT       = 32;

const NET_BANNER_HEIGHT = 30;

const PORT = 17842;
const PLUGIN_STALE_MS = 15000;
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
let isQuitting = false;
let lastAliveState = false;

const windows = new Map();
const waitingWindows = new Map();
let popupWindow = null;
let videoWindow = null;
let senderWindow = null;

let _webrtcOffer = null;
let _webrtcOfferCandidates = [];
let _webrtcAnswer = null;
let _webrtcAnswerCandidates = [];

// Legacy ICE buffers — kept in case sender.html still used. Not touched by
// the new simplified flow.
let _webrtcIceForSender = [];
let _webrtcIceForReceiver = [];

let _videoFullscreenState = false;
let _videoPreviewState = false;
let _videoSavedBounds = null;

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
        const raw = fs.readFileSync(windowsFile(), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.windows)) return parsed.windows;
    } catch (e) {}
    return [];
}

function saveWindowsConfig(list) {
    try {
        const data = { version: 1, windows: list };
        fs.writeFileSync(windowsFile(), JSON.stringify(data, null, 2), "utf8");
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

function settingsFile() {
    return path.join(app.getPath("userData"), "settings.json");
}

let settings = {
    preferredSourceId: "screen:0:0",
    preferredSourceName: null,
    streamSound: true
};

function loadSettings() {
    try {
        const raw = fs.readFileSync(settingsFile(), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            settings = Object.assign(settings, parsed);
        }
    } catch (e) {}
}

function saveSettings() {
    try {
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
    } catch (e) {
        console.error("[settings.json] save failed:", e.message);
    }
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

        const hwnds = sources.map(s => /^window:(\d+):/.exec(s.id)?.[1]).filter(Boolean).map(Number);
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

        // ─── WebRTC signaling relay (simplified) ───
        // Plugin POSTs { offer, candidates } -> we forward to videoWindow via IPC.
        // videoWindow replies with { answer, candidates } via IPC -> plugin GETs.
        if (req.method === "POST" && url === "/webrtc/offer") {
            try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                _webrtcOffer = parsed.offer || null;
                _webrtcOfferCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

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

        // ─── Legacy ICE relay (sender.html compatibility) ───
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

        // ─── Video window controls ───
        if (req.method === "POST" && url === "/video/close") {
            closeVideoWindow();
            jsonReply(res, 200, { ok: true });
            return;
        }
        if (req.method === "POST" && url === "/video/fullscreen") {
            toggleVideoFullscreen();
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
                updateNetMachine();
                jsonReply(res, 200, { ok: true });
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
                applyAutoResizeAll();
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
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/speaking") { jsonReply(res, 200, speaking); return; }

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
                    sound: parsed.sound === true || parsed.sound === false ? parsed.sound : null,
                    createdAt: Date.now()
                };
                if (!cmd.action) { jsonReply(res, 400, { ok: false, error: "missing action" }); return; }
                commandQueue.push(cmd);
                jsonReply(res, 200, { ok: true, id: cmd.id });
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }

        if (req.method === "GET" && url === "/commands") {
            const pending = commandQueue;
            commandQueue = [];
            jsonReply(res, 200, { commands: pending });
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
    return { ...state, pluginAlive: isPluginAlive(), net: buildNetResponse() };
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
    return Math.min(MAX_HEIGHT, baseHeight + netExtra);
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
    win.loadFile(path.join(__dirname, "overlay.html"));

    win.webContents.on("did-finish-load", () => {
        try {
            win.webContents.executeJavaScript(
                `window.__vetWinId = ${JSON.stringify(rec.id)};`
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
    });

    win.webContents._vetIpcChannel = ch;
}

function openVideoWindow(params) {
    if (videoWindow && !videoWindow.isDestroyed()) {
        videoWindow.focus();
        return;
    }
    videoWindow = new BrowserWindow({
        width: 640, height: 380, minWidth: 320, minHeight: 200,
        frame: false, transparent: false, backgroundColor: "#000000",
        alwaysOnTop: true, resizable: true, skipTaskbar: false, hasShadow: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
            backgroundThrottling: false
        }
    });
    videoWindow.setAlwaysOnTop(true, "screen-saver");
    videoWindow.setVisibleOnAllWorkspaces(true);
    videoWindow.loadFile(path.join(__dirname, "video.html"));

    wireVideoWindowIpc(videoWindow);

    videoWindow.webContents.once("did-finish-load", () => {
        try {
            const ch = videoWindow.webContents._vetIpcChannel;
            videoWindow.webContents.executeJavaScript(
                `window.__vetStreamParams = ${JSON.stringify(params || {})};` +
                `if (window.vetWebRTC) window.vetWebRTC.setChannel(${JSON.stringify(ch)});`
            );
        } catch (e) {}
    });

    videoWindow.once("ready-to-show", () => {
        videoWindow.show();
        videoWindow.focus();
    });

    videoWindow.on("closed", () => {
        videoWindow = null;
        _videoFullscreenState = false;
        _videoPreviewState = false;
        _videoSavedBounds = null;

        // Reset WebRTC state so a fresh open starts clean.
        _webrtcOffer = null;
        _webrtcOfferCandidates = [];
        _webrtcAnswer = null;
        _webrtcAnswerCandidates = [];
    });
}

function closeVideoWindow() {
    if (videoWindow && !videoWindow.isDestroyed()) {
        try { videoWindow.close(); } catch (e) {}
    }
    videoWindow = null;
}

function toggleVideoFullscreen() {
    if (!videoWindow || videoWindow.isDestroyed()) return;
    if (!_videoFullscreenState) {
        _videoSavedBounds = videoWindow.getBounds();
        const d = screen.getDisplayNearestPoint(
            screen.getPoint(videoWindow.getBounds().x, videoWindow.getBounds().y)
        );
        videoWindow.setBounds(d.bounds);
        _videoFullscreenState = true;
    } else {
        if (_videoSavedBounds) videoWindow.setBounds(_videoSavedBounds);
        _videoFullscreenState = false;
    }
}

function toggleVideoPreview() {
    if (!videoWindow || videoWindow.isDestroyed()) return;
    if (!_videoPreviewState) {
        _videoSavedBounds = videoWindow.getBounds();
        const [x, y] = videoWindow.getPosition();
        const [w] = videoWindow.getSize();
        videoWindow.setBounds({ x: x + w - 320, y, width: 320, height: 180 });
        _videoPreviewState = true;
    } else {
        if (_videoSavedBounds) videoWindow.setBounds(_videoSavedBounds);
        _videoPreviewState = false;
    }
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

app.whenReady().then(async () => {
    loadSettings();
    await refreshSources(true);
    startServer();
    restoreWindowsOnStartup();
    createTray();
    startLivenessWatchdog();
    startMonitorRetryTimer();
    startNetTicker();

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
    if (_monitorRetryTimer) clearInterval(_monitorRetryTimer);
    if (_saveWindowsTimer) clearTimeout(_saveWindowsTimer);
    if (server) { try { server.close(); } catch (e) {} }
    if (tray)   { try { tray.destroy(); } catch (e) {} }
});