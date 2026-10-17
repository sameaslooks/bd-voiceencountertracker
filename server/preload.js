const { contextBridge, ipcRenderer } = require("electron");

let _channel = null;
let _offerHandler = null;
let _fsHandler = null;
let _alphaHandler = null;

function ensureChannel() {
    return _channel || "vet-webrtc-default";
}

ipcRenderer.on("webrtc:offer", (_e, payload) => {
    try {
        if (_offerHandler) _offerHandler(payload || {});
    } catch (e) {
        console.error("[preload] offer handler error:", e);
    }
});

ipcRenderer.on("video:fullscreen-state", (_e, isFs) => {
    try {
        if (_fsHandler) _fsHandler(!!isFs);
    } catch (e) {}
});

ipcRenderer.on("video:alpha-state", (_e, alpha) => {
    try {
        if (_alphaHandler) _alphaHandler(typeof alpha === "number" ? alpha : 1);
    } catch (e) {}
});

contextBridge.exposeInMainWorld("vetWebRTC", {
    setChannel(ch) {
        _channel = ch || _channel;
        try { ipcRenderer.send(ensureChannel() + ":ready"); } catch (e) {}
    },

    onOffer(fn) {
        _offerHandler = typeof fn === "function" ? fn : null;
    },

    sendAnswer(payload) {
        try { ipcRenderer.send(ensureChannel() + ":answer", payload || {}); } catch (e) {}
    },

    onFullscreenState(fn) {
        _fsHandler = typeof fn === "function" ? fn : null;
    },

    onAlphaState(fn) {
        _alphaHandler = typeof fn === "function" ? fn : null;
    },

    setAlpha(alpha) {
        try { ipcRenderer.send(ensureChannel() + ":alpha", alpha); } catch (e) {}
    },

    ready() {
        try { ipcRenderer.send(ensureChannel() + ":ready"); } catch (e) {}
    }
});