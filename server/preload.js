// preload.js — WebRTC bridge for video.html
const { contextBridge, ipcRenderer } = require("electron");

let channel = null;

contextBridge.exposeInMainWorld("vetWebRTC", {
    setChannel: (ch) => { channel = ch; },
    ready: () => {
        if (!channel) return;
        ipcRenderer.send(channel + ":ready");
    },
    sendAnswer: (payload) => {
        if (!channel) return;
        ipcRenderer.send(channel + ":answer", payload);
    },
    onOffer: (handler) => {
        ipcRenderer.on("webrtc:offer", (_e, payload) => handler(payload));
    },
});