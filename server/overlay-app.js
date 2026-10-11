/**
 * VoiceEncounterTracker Overlay
 *
 * Electron app:
 *   - runs an HTTP server for the plugin to push state into;
 *   - serves a frameless, translucent, always-on-top window;
 *   - lives in the system tray;
 *   - provides a command queue for the overlay UI (block/ignore/mute).
 */

const { app, BrowserWindow, screen, globalShortcut, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ─── Window geometry ───
const WINDOW_WIDTH   = 280;
const MIN_HEIGHT     = 60;
const MAX_HEIGHT     = 600;
const ROW_HEIGHT     = 30;
const HEADER_HEIGHT  = 26;
const EMPTY_HEIGHT   = 60;
const MAX_VISIBLE    = 10;
const OPACITY        = 0.92;
const MONITOR_INDEX  = 1;
const MARGIN_RIGHT   = 20;
const MARGIN_TOP     = 20;

const PORT = 17842;

let state = {
    updatedAt: 0,
    guildId: null,
    channelId: null,
    channelName: null,
    guildName: null,
    users: []
};
let speaking = { speakers: [] };

let commandQueue = [];
let nextCommandId = 1;

let win = null;
let tray = null;
let server = null;
let isQuitting = false;

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

        if (req.method === "POST" && url === "/state") {
            try {
                const body = await readBody(req);
                state = Object.assign({ updatedAt: Date.now() }, JSON.parse(body));
                jsonReply(res, 200, { ok: true });
                applyAutoResize();
            } catch (e) { jsonReply(res, 400, { ok: false, error: e.message }); }
            return;
        }
        if (req.method === "GET" && url === "/state") { jsonReply(res, 200, state); return; }

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
                    createdAt: Date.now()
                };
                if (!cmd.action || !cmd.userId) {
                    jsonReply(res, 400, { ok: false, error: "missing action or userId" });
                    return;
                }
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
                if (err) {
                    res.writeHead(500, { "Content-Type": "text/plain" });
                    res.end("Error: " + err.message);
                    return;
                }
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
// Auto-resize
// =====================================================================

function applyAutoResize() {
    if (!win || win.isDestroyed()) return;

    const count = (state.users || []).length;
    const isIdle = state.channelId === null;

    let targetHeight;
    if (isIdle || count === 0) {
        targetHeight = EMPTY_HEIGHT + HEADER_HEIGHT;
    } else {
        const visible = Math.min(count, MAX_VISIBLE);
        targetHeight = visible * ROW_HEIGHT + HEADER_HEIGHT + 8;
    }
    targetHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, targetHeight));

    const [w, curH] = win.getSize();
    if (Math.abs(curH - targetHeight) < 2) return;

    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: w, height: targetHeight });
}

// =====================================================================
// Window
// =====================================================================

function createWindow() {
    const displays = screen.getAllDisplays();
    const target = displays[MONITOR_INDEX] ?? displays[0];
    const bounds = target.workArea;

    const x = bounds.x + bounds.width - WINDOW_WIDTH - MARGIN_RIGHT;
    const y = bounds.y + MARGIN_TOP;

    win = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: EMPTY_HEIGHT + HEADER_HEIGHT,
        x, y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    win.setOpacity(OPACITY);

    win.loadFile(path.join(__dirname, "overlay.html"));

    win.once("ready-to-show", () => win.show());

    win.on("close", (e) => {
        if (!isQuitting) { e.preventDefault(); win.hide(); }
    });
    win.on("closed", () => { win = null; });
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

function createTray() {
    tray = new Tray(buildTrayIcon());
    tray.setToolTip("VoiceEncounterTracker Overlay");

    const menu = Menu.buildFromTemplate([
        {
            label: "Show / Hide overlay",
            click: () => {
                if (!win) return;
                win.isVisible() ? win.hide() : (win.show(), win.focus());
            }
        },
        {
            label: "Reset position",
            click: () => {
                if (!win) return;
                const displays = screen.getAllDisplays();
                const target = displays[MONITOR_INDEX] ?? displays[0];
                const b = target.workArea;
                const [, h] = win.getSize();
                win.setBounds({
                    x: b.x + b.width - WINDOW_WIDTH - MARGIN_RIGHT,
                    y: b.y + MARGIN_TOP,
                    width: WINDOW_WIDTH,
                    height: h
                });
            }
        },
        { type: "separator" },
        {
            label: "Opacity",
            submenu: [
                { label: "30%",  click: () => win && win.setOpacity(0.3) },
                { label: "50%",  click: () => win && win.setOpacity(0.5) },
                { label: "70%",  click: () => win && win.setOpacity(0.7) },
                { label: "90%",  click: () => win && win.setOpacity(0.9) },
                { label: "100%", click: () => win && win.setOpacity(1.0) }
            ]
        },
        { type: "separator" },
        { label: "Open /state in browser",  click: () => shell.openExternal(`http://127.0.0.1:${PORT}/state`) },
        { label: "Open overlay in browser", click: () => shell.openExternal(`http://127.0.0.1:${PORT}/overlay.html`) },
        { type: "separator" },
        { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
    ]);

    tray.setContextMenu(menu);

    tray.on("click", () => {
        if (!win) return;
        win.isVisible() ? win.hide() : (win.show(), win.focus());
    });
}

// =====================================================================
// Lifecycle
// =====================================================================

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (win) { win.show(); win.focus(); }
    });

    app.whenReady().then(() => {
        startServer();
        createWindow();
        createTray();

        globalShortcut.register("CommandOrControl+Alt+H", () => {
            if (!win) return;
            win.isVisible() ? win.hide() : win.show();
        });
        globalShortcut.register("CommandOrControl+Alt+Q", () => {
            isQuitting = true;
            app.quit();
        });

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on("window-all-closed", (e) => { e?.preventDefault?.(); });
app.on("before-quit", () => { isQuitting = true; });
app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (server) { try { server.close(); } catch (e) {} }
    if (tray)   { try { tray.destroy(); } catch (e) {} }
});