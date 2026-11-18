/**
 * @name VoiceEncounterTracker
 * @author sameaslooks
 * @authorLink https://github.com/sameaslooks
 * @version 1.2.0
 * @description Marks users you've shared a voice channel with, keeps encounter history, and drives a desktop overlay.
 * @source https://github.com/sameaslooks/bd-voiceencountertracker
 * @website https://github.com/sameaslooks
 * @updateUrl https://raw.githubusercontent.com/sameaslooks/bd-voiceencountertracker/refs/heads/master/VoiceEncounterTracker.plugin.js
 */

// Log: shipped to the overlay -> server/logs/plugin.log.
// Everything is also mirrored to the console via BdApi.Logger.
const VET_NAME = "VoiceEncounterTracker";
function vetLog(level, ...args) {
    try {
        const fn = BdApi.Logger[level] || BdApi.Logger.info;
        fn(VET_NAME, ...args);
    } catch (e) {}
    const text = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(" ");
    _vetLogBuf.push(`${new Date().toISOString()} [${level}] ${text}`);
    if (_vetLogBuf.length > 2000) _vetLogBuf.splice(0, _vetLogBuf.length - 2000);
    if (!_vetLogTimer) _vetLogTimer = setTimeout(_vetFlushLog, 1000);
}
// Logs are shipped to the overlay, which writes server/logs/plugin.log.
// Kept in memory (up to 2000 lines) while the overlay is not running.
let _vetLogBuf = [];
let _vetLogTimer = null;
function _vetFlushLog() {
    _vetLogTimer = null;
    if (!_vetLogBuf.length) return;
    const lines = _vetLogBuf.splice(0);
    BdApi.Net.fetch("http://127.0.0.1:17842/log/plugin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines })
    }).catch(() => {
        _vetLogBuf = lines.concat(_vetLogBuf).slice(-2000);
        if (!_vetLogTimer) _vetLogTimer = setTimeout(_vetFlushLog, 5000);
    });
}

module.exports = class VoiceEncounterTracker {
    constructor(meta) {
        this.meta = meta;

        this.active = new Map();
        this.encounters = new Map();
        this.badgeNodes = new Map();
        this.modifiedStyles = new Map();

        this._timers = [];
        this._listeners = [];
        this._domNodes = [];

        this._mutedCache = new Set();
        this._lastSpeakers = "";

        this._vetOverlay = null;
        this._vetExpandedUser = null;
        this._vetExpandedSession = null;

        this._vetSearchQuery = "";
        this._vetQueryDebounce = null;

        this._userContextMenuUnpatch = null;

        this.HEARTBEAT_MS        = 60_000;
        this.SAVE_DEBOUNCE_MS    = 60_000;
        this.MEETING_SAVE_MS     = 3_000;
        this.RECENT_MS           = 8 * 60 * 60_000;
        this.INJECT_THROTTLE_MS  = 250;
        this.REFRESH_MS          = 30_000;
        this.SPEAKING_MS         = 2000;
        this.FULL_PUSH_MS        = 5_000;
        this.PING_PUSH_MS        = 1000;
        this.DEPARTURE_SHOW_MS   = 20_000;          // "-> #channel" card after someone moves
        this.RETURN_MAX_AGE_MS   = 30 * 60_000;     // offer to rejoin only this soon after
        this.DAY_GAP_MS          = 8 * 60 * 60_000; // "today" = since the last voice pause this long
        this.LEAVE_STATS_MS      = 90_000;          // how long the stats card shows after leaving
        this.STRANGER_VIEWER_MS  = 3 * 60_000;      // joined during my stream and opened it this soon = unexpected
        this.COMMAND_POLL_MS     = 1_000;
        this.MAX_SESSIONS        = 500;
        this.MAX_EVENTS_PER_SESSION = 300;

        this.OVERLAY_URL = "http://127.0.0.1:17842";

        this.DEBUG = false;

        this._pendingStreamSound = undefined;

        this._framePump = null;
        this._watchedUserId = null;

        this.prefs = {
            autoMuteBlocked: false,
            hideMuteForBlocked: true,
            flashIconOnMute: true,
            showPingWarn: true,
            showPingLost: true,
            knownMinMinutes: 15
        };

        this.NATIVE_MUTE_STYLE_ID = "VoiceEncounterTracker-native-mute";
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    start() {
        this._stopped = false;
        vetLog("info", "Starting...");

        // ── Hook console.log to catch Discord's streamId ──
        if (!this._origConsoleLog) {
            const origLog = console.log.bind(console);
            const self = this;
            console.log = function(...args) {
                try {
                    let joined = "";
                    for (const a of args) {
                        if (typeof a === "string") joined += " " + a;
                        else if (typeof a === "number") joined += " " + a;
                    }
                    const m = joined.match(/create video element for\s+(\d+)/);
                    if (m) {
                        self._lastDiscordStreamId = m[1];
                        vetLog("info", "caught streamId from log:", m[1]);
                    }
                } catch (e) {}
                return origLog(...args);
            };
            this._origConsoleLog = origLog;
        }

        // ── Patch nz to catch streamId ──
        if (!this._nzPatched) {
            this._nzPatched = true;
            const self = this;
            let nzMod = null;
            try {
                BdApi.Webpack.getModule((m) => {
                    if (m && typeof m === "object" && typeof m.nz === "function"
                        && m.nz.toString().includes("addDirectVideoOutputSink")) {
                        nzMod = m;
                        return true;
                    }
                    return false;
                }, { searchExports: true });
            } catch (e) {}
            if (nzMod && typeof nzMod.nz === "function") {
                BdApi.Patcher.after(this.meta.name, nzMod, "nz", (_, args) => {
                    try {
                        const id = args?.[0];
                        if (id != null) {
                            self._lastDiscordStreamId = String(id);
                            vetLog("info", "caught streamId from nz patch:", id);
                        }
                    } catch (e) {}
                });
                this._nzModule = nzMod;
                vetLog("info", "nz patched");
            } else {
                vetLog("warn", "nz module not found for patching");
            }
        }

        this.loadPrefs();
        this._initStoreCache();
        this.loadEncounters();
        this.applyNativeMuteCss();
        this.syncRelationshipLists();
        this.syncMuteList();
        this.hookDispatcher();
        this.hookSrcObject();
        this.seedSelfSession();
        this.syncActiveFromStore();
        this.patchUserContextMenu();

        this._addTimer(setInterval(() => {
            try { this.heartbeat(); } catch (e) {}
        }, this.HEARTBEAT_MS));

        this._addTimer(setInterval(() => {
            try {
                this.syncMuteList();
                this.injectBadges();
            } catch (e) {}
        }, this.REFRESH_MS));

        this._addTimer(setInterval(() => {
            try { this.pushStateToOverlay(); } catch (e) {}
        }, this.FULL_PUSH_MS));

        this._addTimer(setInterval(() => {
            try { this.pushPingToOverlay(); } catch (e) {}
        }, this.PING_PUSH_MS));

        this._addTimer(setInterval(() => {
            try { this.pushSpeakingToOverlay(); } catch (e) {}
        }, this.SPEAKING_MS));

        this.startCommandLoop();

        this._loadFavorites();
        this._audioDevices = null;
        this._addTimer(setInterval(() => { try { this._checkAudioDevices(); } catch (e) {} }, 3000));
        this._departures = new Map();
        this._returnTo = null;
        // Give Discord a moment to restore voice state before deciding whether
        // we were thrown out of a channel by a restart.
        this._addTimer(setTimeout(() => {
            try { this._checkReturnToChannel(); } catch (e) { vetLog("warn", "return-to-channel:", e); }
        }, 5000));

        try { this.pushStateToOverlay(); } catch (e) {}
        try { this.pushSpeakingToOverlay(); } catch (e) {}
        try { this.pushPingToOverlay(); } catch (e) {}

        vetLog("info", "Started.");
    }

    stop() {
        vetLog("info", "Stopping...");
        this._cmdLoopGen = (this._cmdLoopGen || 0) + 1; // ends the command long-poll loop

        for (const t of this._timers) {
            try { clearTimeout(t); } catch (e) {}
            try { clearInterval(t); } catch (e) {}
        }
        this._timers = [];

        for (const { target, type, fn, opts } of this._listeners) {
            try { target.removeEventListener(type, fn, opts); } catch (e) {}
        }
        this._listeners = [];

        if (this._vetQueryDebounce) {
            try { clearTimeout(this._vetQueryDebounce); } catch (e) {}
            this._vetQueryDebounce = null;
        }

        // ── Unpatch context menu ──
        try {
            if (typeof this._userContextMenuUnpatch === "function") {
                this._userContextMenuUnpatch();
            }
        } catch (e) {}
        this._userContextMenuUnpatch = null;
        try { BdApi.ContextMenu.unpatch("user-context", this.meta.name); } catch (e) {}

        try {
            this._postJSON("/state", {
                guildId: null, channelId: null, channelName: null, users: [],
                prefs: this._prefsPayload()
            });
            this._postJSON("/speaking", { speakers: [] });
            this._postJSON("/ping", { last: null, avg: null });
        } catch (e) {}

        const me = this.getCurrentUserId();
        const mySession = me ? this.active.get(me) : null;
        if (mySession) {
            for (const [userId, other] of this.active) {
                if (userId === me) continue;
                this.finalizeMeeting(userId, mySession, other, Date.now());
            }
        }
        this.active.clear();

        try { this._stopFramePump(); } catch (e) {}
        this.flushEncounters();
        this.restoreModifiedStyles();

        for (const node of this.badgeNodes.values()) {
            try { node.remove(); } catch (e) {}
        }
        this.badgeNodes.clear();
        document.querySelectorAll("[data-vet-badge]").forEach(el => el.remove());
        for (const node of this._domNodes) {
            try { node.remove(); } catch (e) {}
        }
        this._domNodes = [];

        if (this._vetOverlay) {
            try { this._vetOverlay.remove(); } catch (e) {}
            this._vetOverlay = null;
        }
        try { document.getElementById("vet-settings-style")?.remove(); } catch (e) {}

        if (this._origConsoleLog) {
            try { console.log = this._origConsoleLog; } catch (e) {}
            this._origConsoleLog = null;
        }

        try { BdApi.DOM.removeStyle(this.NATIVE_MUTE_STYLE_ID); } catch (e) {}
        try { BdApi.Patcher.unpatchAll(this.meta.name); } catch (e) {}

        this._stopped = true;
        this.encounters.clear();
        this.modifiedStyles.clear();
        this._mutedCache.clear();

        vetLog("info", "Stopped.");
    }

    _addTimer(t) { this._timers.push(t); return t; }
    _addListener(target, type, fn, opts) {
        try { target.addEventListener(type, fn, opts); } catch (e) {}
        this._listeners.push({ target, type, fn, opts });
    }

    _prefsPayload() {
        return {
            flashIconOnMute: !!this.prefs.flashIconOnMute
        };
    }

    // =====================================================================
    // Preferences
    // =====================================================================

    loadPrefs() {
        try {
            const raw = BdApi.Data.load(this.meta.name, "prefs");
            if (raw && typeof raw === "object") {
                this.prefs = Object.assign(this.prefs, raw);
            }
        } catch (e) {}
    }

    savePrefs() {
        try {
            BdApi.Data.save(this.meta.name, "prefs", this.prefs);
        } catch (e) {}
    }

    applyNativeMuteCss() {
        try { BdApi.DOM.removeStyle(this.NATIVE_MUTE_STYLE_ID); } catch (e) {}
        if (!this.prefs.hideMuteForBlocked) return;

        BdApi.DOM.addStyle(this.NATIVE_MUTE_STYLE_ID, `
            [class*='voiceUser']:has([data-vet-badge][data-vet-kind="blocked"]) svg:has(path[d^="M21.76.83"]),
            [class*='voiceUser']:has([data-vet-badge][data-vet-kind="ignored"]) svg:has(path[d^="M21.76.83"]) {
                display: none !important;
            }
        `);
    }

    // =====================================================================
    // User context menu patch (MLV2-style)
    // =====================================================================

    patchUserContextMenu() {
        try {
            if (typeof this._userContextMenuUnpatch === "function") {
                try { this._userContextMenuUnpatch(); } catch (e) {}
                this._userContextMenuUnpatch = null;
            }
            try { BdApi.ContextMenu.unpatch("user-context", this.meta.name); } catch (e) {}

            this._userContextMenuUnpatch = BdApi.ContextMenu.patch(
                "user-context",
                (ret, props) => {
                    try {
                        const user = props?.user;
                        if (!user?.id) return;

                        const userId = user.id;
                        const me = this.getCurrentUserId();
                        if (me && me === userId) return;

                        const rec = this.encounters.get(userId);
                        const isManualKnown = !!rec && rec.manual === true && !(rec.totalMs > 0);
                        const hasVoiceLogs = !!rec && (rec.totalMs > 0 || (Array.isArray(rec.sessions) && rec.sessions.length > 0));

                        const items = [];

                        items.push({
                            type: "item",
                            label: "Open Encounter Tracker",
                            action: () => {
                                try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                try {
                                    const container = this.settingsContainer || document.createElement("div");
                                    this.settingsContainer = container;
                                    this.renderSettings(container);
                                } catch (e) {}
                            }
                        });

                        items.push({ type: "separator" });

                        if (isManualKnown) {
                            items.push({
                                type: "item",
                                label: "Remove from Known",
                                action: () => {
                                    try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                    const ok = this.clearUserVoiceLogs(userId, { keepFlags: true, forceRemoveManual: true });
                                    if (ok) BdApi.UI.showToast("Removed from Known", { type: "success" });
                                    else BdApi.UI.showToast("Nothing to remove", { type: "warning" });
                                }
                            });
                        } else {
                            items.push({
                                type: "item",
                                label: "Mark as Known",
                                action: () => {
                                    try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                    const r = this.markUserAsKnown(userId);
                                    if (r.ok) BdApi.UI.showToast("Marked as Known", { type: "success" });
                                    else BdApi.UI.showToast("Failed to mark user", { type: "error" });
                                }
                            });
                        }

                        const fav = this._favorites?.get(String(userId));
                        items.push({
                            type: "item",
                            label: fav ? "Remove from Favorites" : "Add to Favorites",
                            action: () => {
                                try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                this.setFavorite(userId, !fav);
                                BdApi.UI.showToast(fav ? "Removed from Favorites" : "Added to Favorites", { type: "success" });
                            }
                        });
                        if (fav) {
                            items.push({
                                type: "toggle",
                                label: "Sound When They Join/Leave",
                                checked: !!fav.sound,
                                action: () => this.setFavoriteSound(userId, !fav.sound)
                            });
                        }

                        items.push({
                            type: "item",
                            label: "Clear Voice Logs With This User",
                            danger: true,
                            action: () => {
                                try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                BdApi.UI.showConfirmationModal(
                                    "Clear voice logs",
                                    `Delete all stored voice encounter history with ${user.username ?? user.globalName ?? userId}?`,
                                    {
                                        confirmText: "Delete",
                                        cancelText: "Cancel",
                                        danger: true,
                                        onConfirm: () => {
                                            const ok = this.clearUserVoiceLogs(userId, { keepFlags: true });
                                            if (ok) BdApi.UI.showToast("Voice logs cleared", { type: "success" });
                                            else BdApi.UI.showToast("Nothing to clear", { type: "warning" });
                                        }
                                    }
                                );
                            }
                        });

                        items.push({
                            type: "item",
                            label: "Remove User Completely",
                            danger: true,
                            action: () => {
                                try { BdApi.ContextMenu.close?.(); } catch (e) {}
                                BdApi.UI.showConfirmationModal(
                                    "Remove user",
                                    `Remove ${user.username ?? user.globalName ?? userId} from the tracker completely (including blocked/ignored state)?`,
                                    {
                                        confirmText: "Remove",
                                        cancelText: "Cancel",
                                        danger: true,
                                        onConfirm: () => {
                                            const ok = this.removeUser(userId);
                                            if (ok) BdApi.UI.showToast("Removed", { type: "success" });
                                            else BdApi.UI.showToast("Nothing to remove", { type: "warning" });
                                        }
                                    }
                                );
                            }
                        });

                        const menu = BdApi.Utils.findInTree(
                            ret,
                            (e) => e && e.navId === "user-context",
                            { walkable: ["props", "children"] }
                        );
                        const children = BdApi.Utils.getNestedValue(menu, "children");
                        if (!Array.isArray(children)) return;

                        children.push(
                            BdApi.ContextMenu.buildMenuChildren([
                                {
                                    type: "group",
                                    items: [
                                        {
                                            type: "submenu",
                                            label: "Voice Encounter Tracker",
                                            items
                                        }
                                    ]
                                }
                            ])
                        );
                    } catch (e) {
                        vetLog("error", "user-context patch error:", e);
                    }
                },
                this.meta.name
            );
        } catch (e) {
            vetLog("error", "patchUserContextMenu failed:", e);
        }
    }

    markUserAsKnown(userId) {
        if (!userId) return { ok: false, reason: "empty" };
        let rec = this.encounters.get(userId);
        if (!rec) {
            rec = {
                userId,
                username: this.getUserName(userId),
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
                totalMs: 0,
                meetings: 0,
                lastGuildId: null,
                lastChannelId: null,
                lastGuildName: null,
                lastChannelName: null,
                blocked: false,
                ignored: false,
                manual: true,
                sessions: []
            };
            this.encounters.set(userId, rec);
        } else {
            rec.manual = true;
            if (!rec.username || rec.username === "(unknown)") {
                rec.username = this.getUserName(userId);
            }
        }
        this.scheduleSave();
        this.scheduleOverlayPush();
        return { ok: true };
    }

    // Drop only the manual "Known" mark; voice history stays untouched.
    unmarkKnown(userId) {
        const rec = this.encounters.get(userId);
        if (!rec || !rec.manual) return false;
        rec.manual = false;
        this.scheduleSave();
        this.scheduleOverlayPush();
        return true;
    }

    clearUserVoiceLogs(userId, { keepFlags = true, forceRemoveManual = false } = {}) {
        if (!userId) return false;
        const rec = this.encounters.get(userId);
        if (!rec) return false;

        const had = (rec.totalMs || 0) > 0 || (Array.isArray(rec.sessions) && rec.sessions.length > 0) || (forceRemoveManual && rec.manual);
        if (!had) return false;

        rec.sessions = [];
        rec.totalMs = 0;
        rec.meetings = 0;
        rec.firstSeenAt = 0;
        rec.lastSeenAt = 0;
        rec.lastGuildId = null;
        rec.lastChannelId = null;
        rec.lastGuildName = null;
        rec.lastChannelName = null;

        if (forceRemoveManual) rec.manual = false;

        if (!keepFlags) {
            rec.blocked = false;
            rec.ignored = false;
        }

        const isEmpty = !rec.manual && !rec.blocked && !rec.ignored && !rec.totalMs;
        if (isEmpty) this.encounters.delete(userId);

        this.scheduleSave();
        this.scheduleOverlayPush();
        return true;
    }

    // =====================================================================
    // Dispatcher hook
    // =====================================================================

    _initStoreCache() {
        try {
            this._sc = {
                UserStore:         BdApi.Webpack.getStore("UserStore"),
                VoiceStateStore:   BdApi.Webpack.getStore("VoiceStateStore"),
                MediaEngineStore:  BdApi.Webpack.getStore("MediaEngineStore"),
                RTCConnectionStore:BdApi.Webpack.getStore("RTCConnectionStore"),
                SpeakingStore:     BdApi.Webpack.getStore("SpeakingStore"),
                GuildMemberStore:  BdApi.Webpack.getStore("GuildMemberStore"),
                ChannelStore:      BdApi.Webpack.getStore("ChannelStore"),
                GuildStore:        BdApi.Webpack.getStore("GuildStore"),
                RelationshipStore: BdApi.Webpack.getStore("RelationshipStore"),
                ReadStateStore:    BdApi.Webpack.getStore("ReadStateStore"),
                SelectedChannelStore: BdApi.Webpack.getStore("SelectedChannelStore"),
                PresenceStore:     BdApi.Webpack.getStore("PresenceStore"),
                ApplicationStore:  BdApi.Webpack.getStore("ApplicationStore"),
            };
        } catch (e) { this._sc = {}; }
    }

    getDispatcher() {
        try {
            const store = this._sc?.VoiceStateStore ?? BdApi.Webpack.getStore("VoiceStateStore");
            return store?._dispatcher ?? null;
        } catch { return null; }
    }

    getCurrentUserId() {
        try {
            return (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getCurrentUser?.()?.id ?? null;
        } catch { return null; }
    }

    hookDispatcher() {
        const d = this.getDispatcher();
        if (!d || typeof d.dispatch !== "function") {
            vetLog("error", "Dispatcher not found.");
            return;
        }

        const self = this;
        BdApi.Patcher.after(this.meta.name, d, "dispatch", (_, args) => {
            const action = args?.[0];
            if (!action) return;
            try {
                if (action.type === "VOICE_STATE_UPDATES") {
                    for (const vs of (action.voiceStates ?? [])) {
                        try { self._noteDeparture(vs); } catch (e) {}
                        try { self.handleVoiceState(vs); } catch (e) {}
                    }
                    try { self._rememberOwnChannel(); } catch (e) {}
                    try { self._trackOwnSession(); } catch (e) {}
                    if (self._injectDebounce) clearTimeout(self._injectDebounce);
                    self._injectDebounce = self._addTimer(setTimeout(() => {
                        try { self.injectBadges(); } catch (e) {}
                        try { self.pushStateToOverlay(); } catch (e) {}
                    }, self.INJECT_THROTTLE_MS));
                } else if (action.type === "PRESENCE_UPDATES" || action.type === "PRESENCES_REPLACE") {
                    try { self.scheduleOverlayPush(); } catch (e) {}
                } else if (action.type === "CALL_CREATE" || action.type === "CALL_UPDATE" || action.type === "CALL_DELETE") {
                    try { self._onCall(action); } catch (e) {}
                } else if (action.type === "MESSAGE_CREATE") {
                    try { self._onMessageCreate(action); } catch (e) {}
                } else if (action.type === "MESSAGE_ACK" || action.type === "CHANNEL_ACK" || action.type === "BULK_ACK") {
                    try { self._onMessageAck(action); } catch (e) {}
                } else if (action.type === "VOICE_CHANNEL_SELECT") {
                    // Only a real user action (Disconnect / picking a channel)
                    // dispatches this. A Discord restart or crash does not, so a
                    // channel left that way stays "not left by me".
                    try { self._onOwnChannelSelect(action); } catch (e) {}
                } else if (
                    action.type === "RELATIONSHIP_ADD" ||
                    action.type === "RELATIONSHIP_REMOVE" ||
                    action.type === "RELATIONSHIP_UPDATE"
                ) {
                    try { self.handleRelationshipUpdate(action); } catch (e) {}
                    try { self.syncRelationshipLists(); } catch (e) {}
                    try { self.injectBadges(); } catch (e) {}
                    try { self.scheduleOverlayPush(); } catch (e) {}
                } else if (
                    action.type === "AUDIO_TOGGLE_LOCAL_MUTE" ||
                    action.type === "MEDIA_ENGINE_SETTINGS_UPDATE" ||
                    action.type === "AUDIO_SETTINGS_UPDATE"
                ) {
                    try { self.syncMuteList(); } catch (e) {}
                    try { self.injectBadges(); } catch (e) {}
                    try { self.scheduleOverlayPush(); } catch (e) {}
                } else if (
                    action.type === "SPEAKING" ||
                    action.type === "SPEAKING_START" ||
                    action.type === "SPEAKING_STOP" ||
                    action.type === "SPEAKING_STOP_USERS"
                ) {
                    try { self.pushSpeakingToOverlay(); } catch (e) {}
                }
            } catch (e) {}
        });

        vetLog("info", "Dispatcher hooked.");
    }

    hookSrcObject() {
        if (this._srcObjectHooked) return;
        this._srcObjectHooked = true;
        this._streamsByStreamId = new Map();
        this._lastCapturedStream = null;

        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
            if (!desc || !desc.set) return;
            const origSet = desc.set;
            const self = this;

            Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
                ...desc,
                set(v) {
                    try {
                        if (v instanceof MediaStream) {
                            let streamId = null;
                            let el = this;
                            for (let i = 0; i < 12 && el; i++) {
                                if (el.dataset) {
                                    if (el.dataset.streamId) { streamId = el.dataset.streamId; break; }
                                    if (el.dataset.streamid) { streamId = el.dataset.streamid; break; }
                                }
                                el = el.parentElement;
                            }
                            self._lastCapturedStream = v;
                            if (streamId) self._streamsByStreamId.set(String(streamId), v);
                            vetLog("info", "srcObject captured", streamId || "(no id)");
                        }
                    } catch (e) {}
                    return origSet.call(this, v);
                }
            });
            vetLog("info", "srcObject hooked");
        } catch (e) {
            vetLog("error", "hookSrcObject failed:", e);
        }
    }

    scheduleOverlayPush() {
        if (this._overlayDebounce) clearTimeout(this._overlayDebounce);
        this._overlayDebounce = this._addTimer(setTimeout(() => {
            try { this.pushStateToOverlay(); } catch (e) {}
        }, 500));
    }

    // =====================================================================
    // Relationship handling
    // =====================================================================

    handleRelationshipUpdate(action) {
        if (!this.prefs.autoMuteBlocked) return;

        const rel = action.relationship ?? action;
        const userId = rel?.id || rel?.userId || action.userId;
        const type = rel?.type;
        if (!userId) return;
        if (type !== 2) return;

        this._addTimer(setTimeout(() => {
            try { this.applyLocalMute(userId, true); } catch (e) {}
        }, 500));
    }

    applyLocalMute(userId, muted) {
        try {
            const mes = BdApi.Webpack.getStore("MediaEngineStore");
            if (!mes || typeof mes.isLocalMute !== "function") return false;

            const currentlyMuted = mes.isLocalMute(userId) === true;
            if (currentlyMuted === !!muted) return true;

            const mod = BdApi.Webpack.getByKeys("toggleLocalMute", { searchExports: true });
            if (!mod || typeof mod.toggleLocalMute !== "function") return false;
            mod.toggleLocalMute(userId);
            return true;
        } catch (e) { return false; }
    }

    syncRelationshipLists() {
        let rel;
        try { rel = this._sc?.RelationshipStore ?? BdApi.Webpack.getStore("RelationshipStore"); } catch { return; }
        if (!rel) return;

        const blocked = new Set();
        const ignored = new Set();

        try {
            for (const id of (rel.getBlockedIDs?.() ?? [])) blocked.add(id);
        } catch (e) {}

        try {
            const fromIgnoredIDs = rel.getIgnoredIDs?.() ?? [];
            for (const id of fromIgnoredIDs) ignored.add(id);
            if (!ignored.size && typeof rel.getIgnoredUsers === "function") {
                for (const u of (rel.getIgnoredUsers() ?? [])) {
                    if (u?.id) ignored.add(u.id);
                }
            }
        } catch (e) {}

        const allKnownIds = new Set([...blocked, ...ignored]);
        let changed = false;

        for (const id of allKnownIds) {
            const isBlocked = blocked.has(id);
            const cur = this.encounters.get(id);

            if (!cur) {
                this.encounters.set(id, {
                    userId: id,
                    username: this.getUserName(id),
                    firstSeenAt: 0, lastSeenAt: 0,
                    totalMs: 0, meetings: 0,
                    lastGuildId: null, lastChannelId: null,
                    lastGuildName: null, lastChannelName: null,
                    blocked: isBlocked, ignored: !isBlocked,
                    sessions: []
                });
                changed = true;
            } else {
                if (cur.blocked !== isBlocked || cur.ignored !== !isBlocked) {
                    cur.blocked = isBlocked;
                    cur.ignored = !isBlocked;
                    changed = true;
                }
                if (!cur.username || cur.username === "(unknown)") {
                    cur.username = this.getUserName(id);
                }
                if (!Array.isArray(cur.sessions)) cur.sessions = [];
            }
        }

        for (const [id, rec] of this.encounters) {
            if (allKnownIds.has(id)) continue;
            if (rec.blocked || rec.ignored) {
                const hadNoHistory = !rec.totalMs && !rec.firstSeenAt;
                if (hadNoHistory) this.encounters.delete(id);
                else { rec.blocked = false; rec.ignored = false; }
                changed = true;
            }
        }

        if (changed) this.scheduleSave();
    }

    // =====================================================================
    // Mute cache
    // =====================================================================

    syncMuteList() {
        let mes;
        try { mes = this._sc?.MediaEngineStore ?? BdApi.Webpack.getStore("MediaEngineStore"); } catch { return; }
        if (!mes || typeof mes.isLocalMute !== "function") return;

        const rows = document.querySelectorAll("[class*='voiceUser']");
        const visibleIds = new Set();
        for (const row of rows) {
            const avatarEl = row.querySelector("[class*='userAvatar']");
            if (!avatarEl) continue;
            const bg = avatarEl.style?.backgroundImage || "";
            const match = bg.match(/\/avatars\/(\d+)\//);
            if (match) visibleIds.add(match[1]);
        }

        const newCache = new Set();
        for (const id of visibleIds) {
            try { if (mes.isLocalMute(id) === true) newCache.add(id); } catch (e) {}
        }
        this._mutedCache = newCache;
    }

    isUserLocallyMuted(userId) {
        if (this._mutedCache && this._mutedCache.has(userId)) return true;
        try {
            const mes = BdApi.Webpack.getStore("MediaEngineStore");
            if (mes && typeof mes.isLocalMute === "function") {
                return mes.isLocalMute(userId) === true;
            }
        } catch (e) {}
        return false;
    }

    // =====================================================================
    // Self session seeding + direct store sync
    // =====================================================================

    seedSelfSession() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;
            const store = this._sc?.VoiceStateStore ?? BdApi.Webpack.getStore("VoiceStateStore");
            if (!store || typeof store.getVoiceState !== "function") return;

            const guilds = (this._sc?.GuildStore ?? BdApi.Webpack.getStore("GuildStore"))?.getGuilds?.() ?? {};
            const now = Date.now();
            for (const guildId of Object.keys(guilds)) {
                const vs = store.getVoiceState(guildId, me);
                if (vs?.channelId) {
                    this.active.set(me, this._makeSessionFromVoiceState(me, vs, guildId, now));
                    return;
                }
            }

            // DM / group DM call (no guild)
            let vs = null;
            try { vs = store.getVoiceState(null, me); } catch (e) {}
            if (!vs?.channelId) {
                try {
                    const chId = store.getVoiceChannelId?.();
                    if (chId && !this.getChannelGuildId(chId)) {
                        const arr = store.getVoiceStatesForChannel?.(chId);
                        vs = arr ? Object.values(arr).find(v => v?.userId === me) : null;
                    }
                } catch (e) {}
            }
            if (vs?.channelId) {
                this.active.set(me, this._makeSessionFromVoiceState(me, vs, null, now));
            }
        } catch (e) {}
    }

    syncActiveFromStore() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;

            const store = this._sc?.VoiceStateStore ?? BdApi.Webpack.getStore("VoiceStateStore");
            if (!store) return;

            let myChannelId = null;
            let myGuildId = null;

            const mySession = this.active.get(me);
            if (mySession) {
                myChannelId = mySession.channelId;
                myGuildId = mySession.guildId;
            }

            if (!myChannelId && typeof store.getVoiceChannelId === "function") {
                try { myChannelId = store.getVoiceChannelId() ?? null; } catch (e) {}
            }

            if (myChannelId && !myGuildId) {
                myGuildId = this.getChannelGuildId(myChannelId);
            }

            if (!myChannelId) return;

            let guildStates = null;

            try {
                if (myGuildId && typeof store.getVoiceStates === "function") {
                    guildStates = store.getVoiceStates(myGuildId);
                }
            } catch (e) {}

            if (!guildStates) {
                try {
                    if (typeof store.getVoiceStatesForChannel === "function") {
                        const arr = store.getVoiceStatesForChannel(myChannelId);
                        if (arr) {
                            guildStates = {};
                            for (const vs of Object.values(arr)) {
                                guildStates[vs.userId] = vs;
                            }
                        }
                    }
                } catch (e) {}
            }

            if (!guildStates) return;

            const now = Date.now();
            let added = 0;

            for (const [userId, vs] of Object.entries(guildStates)) {
                if (!vs || vs.channelId !== myChannelId) continue;
                if (this.active.has(userId)) continue;
                this.active.set(userId, this._makeSessionFromVoiceState(userId, vs, myGuildId, now));
                added++;
            }

            if (added > 0) {
                vetLog("info", `syncActiveFromStore: seeded ${added} user(s)`);
            }
        } catch (e) {
            vetLog("error", "syncActiveFromStore:", e);
        }
    }

    _makeSessionFromVoiceState(userId, vs, guildId, now) {
        const flags = {
            selfMute:   !!vs.selfMute,
            selfDeaf:   !!vs.selfDeaf,
            serverMute: !!vs.mute,
            serverDeaf: !!vs.deaf,
            streaming:  !!vs.selfStream,
            video:      !!vs.selfVideo,
            suppress:   !!vs.suppress
        };

        const events = [];
        if (flags.selfMute)   events.push({ at: now, flag: "selfMute",   value: true });
        if (flags.selfDeaf)   events.push({ at: now, flag: "selfDeaf",   value: true });
        if (flags.serverMute) events.push({ at: now, flag: "serverMute", value: true });
        if (flags.serverDeaf) events.push({ at: now, flag: "serverDeaf", value: true });
        if (flags.streaming)  events.push({ at: now, flag: "streaming",  value: true });
        if (flags.video)      events.push({ at: now, flag: "video",      value: true });

        return {
            userId, channelId: vs.channelId, guildId,
            startedAt: now, lastSeen: now,
            ...flags,
            prevSelfMute:   flags.selfMute,
            prevSelfDeaf:   flags.selfDeaf,
            prevServerMute: flags.serverMute,
            prevServerDeaf: flags.serverDeaf,
            prevStreaming:  flags.streaming,
            prevVideo:      flags.video,
            selfMuteAt:     flags.selfMute   ? now : 0,
            selfDeafAt:     flags.selfDeaf   ? now : 0,
            selfUnmuteAt:   0,
            selfUndeafAt:   0,
            serverMuteAt:   flags.serverMute ? now : 0,
            serverDeafAt:   flags.serverDeaf ? now : 0,
            events
        };
    }

    // =====================================================================
    // Voice session tracking
    // =====================================================================

    handleVoiceState(vs) {
        const { userId, channelId, guildId } = vs;
        if (!userId) return;

        const existing = this.active.get(userId);
        const now = Date.now();

        const flags = {
            selfMute:   !!vs.selfMute,
            selfDeaf:   !!vs.selfDeaf,
            serverMute: !!vs.mute,
            serverDeaf: !!vs.deaf,
            streaming:  !!vs.selfStream,
            video:      !!vs.selfVideo,
            suppress:   !!vs.suppress
        };

        if (!channelId) {
            vetLog("info", `[leave] ${this.getUserName(userId)} (${userId}) left; tracked=${!!existing}`);
            if (existing) {
                this.closeSessionAndMeetings(userId, existing, now);
                this.active.delete(userId);
            }
            return;
        }

        if (existing && existing.channelId !== channelId) {
            this.closeSessionAndMeetings(userId, existing, now);
            this.active.set(userId, this._makeSessionFromVoiceState(userId, vs, guildId, now));
            return;
        }

        if (!existing) {
            this.active.set(userId, this._makeSessionFromVoiceState(userId, vs, guildId, now));
            return;
        }

        const logEvent = (flag, value) => {
            if (!Array.isArray(existing.events)) existing.events = [];
            if (existing.events.length >= this.MAX_EVENTS_PER_SESSION) {
                existing.events.splice(0, existing.events.length - this.MAX_EVENTS_PER_SESSION + 1);
            }
            existing.events.push({ at: now, flag, value });
        };

        if (!existing.prevSelfMute && flags.selfMute) {
            existing.selfMuteAt = now;
            existing.selfUnmuteAt = 0;
            logEvent("selfMute", true);
        } else if (existing.prevSelfMute && !flags.selfMute) {
            existing.selfMuteAt = 0;
            existing.selfUnmuteAt = now;
            logEvent("selfMute", false);
        }

        if (!existing.prevSelfDeaf && flags.selfDeaf) {
            existing.selfDeafAt = now;
            existing.selfUndeafAt = 0;
            logEvent("selfDeaf", true);
        } else if (existing.prevSelfDeaf && !flags.selfDeaf) {
            existing.selfDeafAt = 0;
            existing.selfUndeafAt = now;
            logEvent("selfDeaf", false);
        }

        if (!existing.prevServerMute && flags.serverMute) {
            existing.serverMuteAt = now;
            logEvent("serverMute", true);
        } else if (existing.prevServerMute && !flags.serverMute) {
            existing.serverMuteAt = 0;
            logEvent("serverMute", false);
        }

        if (!existing.prevServerDeaf && flags.serverDeaf) {
            existing.serverDeafAt = now;
            logEvent("serverDeaf", true);
        } else if (existing.prevServerDeaf && !flags.serverDeaf) {
            existing.serverDeafAt = 0;
            logEvent("serverDeaf", false);
        }

        if (!existing.prevStreaming && flags.streaming) {
            logEvent("streaming", true);
        } else if (existing.prevStreaming && !flags.streaming) {
            logEvent("streaming", false);
        }

        if (!existing.prevVideo && flags.video) {
            logEvent("video", true);
        } else if (existing.prevVideo && !flags.video) {
            logEvent("video", false);
        }

        existing.prevSelfMute   = flags.selfMute;
        existing.prevSelfDeaf   = flags.selfDeaf;
        existing.prevServerMute = flags.serverMute;
        existing.prevServerDeaf = flags.serverDeaf;
        existing.prevStreaming  = flags.streaming;
        existing.prevVideo      = flags.video;

        existing.lastSeen = now;
        Object.assign(existing, flags);
    }

    closeSessionAndMeetings(userId, session, endedAt, trusted = true) {
        const me = this.getCurrentUserId();
        if (!me) return;

        if (userId === me) {
            for (const [otherId, otherSession] of this.active) {
                if (otherId === me) continue;
                this.finalizeMeeting(otherId, session, otherSession, endedAt, trusted);
            }
        } else {
            const mySession = this.active.get(me);
            if (mySession) {
                this.finalizeMeeting(userId, mySession, session, endedAt, trusted);
            }
        }
    }

    heartbeat() {
        const now = Date.now();
        // Prune first: ghosts must keep their old lastSeen so their meeting ends there
        this._pruneGhosts();
        for (const s of this.active.values()) s.lastSeen = now;
        this.syncActiveFromStore();
    }

    _pruneGhosts() {
        const now = Date.now();
        const STALE_MS = 5 * 60_000;
        const me = this.getCurrentUserId();

        let store = null;
        try { store = this._sc?.VoiceStateStore ?? BdApi.Webpack.getStore("VoiceStateStore"); } catch (e) {}
        const canVerify = !!(store && typeof store.getVoiceState === "function");

        for (const [userId, s] of [...this.active]) {
            if (userId === me) continue;

            if (canVerify) {
                let live = null;
                try { live = store.getVoiceState(s.guildId ?? null, userId); } catch (e) {}
                if (!live && !s.guildId) {
                    try {
                        const arr = store.getVoiceStatesForChannel?.(s.channelId);
                        live = arr ? (Object.values(arr).find(v => v?.userId === userId) ?? null) : null;
                    } catch (e) {}
                }
                if (!live || live.channelId !== s.channelId) {
                    try { this.closeSessionAndMeetings(userId, s, now, false); } catch (e) {}
                    this.active.delete(userId);
                    continue;
                }
            } else {
                if (now - (s.lastSeen ?? now) > STALE_MS) {
                    try { this.closeSessionAndMeetings(userId, s, now, false); } catch (e) {}
                    this.active.delete(userId);
                }
            }
        }
    }

    // =====================================================================
    // Encounter recording
    // =====================================================================

    // trusted = endedAt comes from a real event (someone left / we left / plugin stop),
    // so both were present until then. Only unverified ghost pruning clamps to lastSeen.
    finalizeMeeting(userId, mySession, otherSession, endedAt, trusted = true) {
        const name = `${this.getUserName(userId)} (${userId})`;
        if (!mySession || !otherSession) {
            vetLog("info", `[meeting] skip ${name}: no session (me=${!!mySession}, other=${!!otherSession})`);
            return;
        }
        if (mySession.channelId !== otherSession.channelId) {
            vetLog("info", `[meeting] skip ${name}: different channel`);
            return;
        }

        const start = Math.max(mySession.startedAt, otherSession.startedAt);
        const end = trusted
            ? endedAt
            : Math.min(endedAt, otherSession.lastSeen ?? endedAt, mySession.lastSeen ?? endedAt);
        if (end <= start) {
            vetLog("info", `[meeting] skip ${name}: empty interval`);
            return;
        }
        vetLog("info", `[meeting] record ${name}: ${this.formatDuration(end - start)}, ${this.formatTime(start)} → ${this.formatTime(end)}`);

        const rawEvents = Array.isArray(otherSession.events) ? otherSession.events : [];
        const events = rawEvents
            .filter(ev => ev.at >= start && ev.at <= end)
            .map(ev => ({ at: ev.at, flag: ev.flag, value: ev.value }));

        this.recordEncounter(userId, otherSession.channelId, otherSession.guildId, start, end, events);
    }

    recordEncounter(userId, channelId, guildId, startedAt, endedAt, events = []) {
        if (endedAt <= startedAt) return;

        const me = this.getCurrentUserId();
        if (me && me === userId) return;

        const duration = endedAt - startedAt;
        guildId = guildId ?? null;
        const isDM = !guildId;
        const guildName = this.getGuildName(guildId, channelId);
        const channelName = this.getChannelName(channelId);

        const session = {
            startedAt, endedAt, durationMs: duration,
            guildId, guildName, channelId, channelName,
            isDM,
            username: null, globalName: null,
            events
        };
        const liveName = this._liveName(userId);
        if (liveName) {
            session.username = liveName.username;
            session.globalName = liveName.globalName;
        }

        const cur = this.encounters.get(userId);

        if (!cur) {
            this.encounters.set(userId, {
                userId,
                username: this.getUserName(userId),
                firstSeenAt: startedAt,
                lastSeenAt: endedAt,
                totalMs: duration,
                meetings: 1,
                lastGuildId: guildId,
                lastChannelId: channelId,
                lastGuildName: guildName,
                lastChannelName: channelName,
                blocked: false, ignored: false, manual: false,
                sessions: [session]
            });
        } else {
            const gap = startedAt - cur.lastSeenAt;
            if (gap > this.RECENT_MS) cur.meetings += 1;
            cur.lastSeenAt = Math.max(cur.lastSeenAt, endedAt);
            cur.firstSeenAt = cur.firstSeenAt
                ? Math.min(cur.firstSeenAt, startedAt)
                : startedAt;
            cur.totalMs += duration;
            cur.lastGuildId = guildId;
            cur.lastChannelId = channelId;
            cur.lastGuildName = guildName;
            cur.lastChannelName = channelName;
            if (!Array.isArray(cur.sessions)) cur.sessions = [];
            cur.sessions.push(session);
            if (cur.sessions.length > this.MAX_SESSIONS) {
                cur.sessions.splice(0, cur.sessions.length - this.MAX_SESSIONS);
            }
        }

        this._rememberName(this.encounters.get(userId));
        // A finished meeting is worth persisting soon, not after the 60 s debounce
        this.scheduleSave(this.MEETING_SAVE_MS);
        this._refreshOpenTracker();
    }

    // Merge several sessions of one user into one continuous session (as if nobody left).
    // Sessions lying inside the merged span are absorbed too, so the history never overlaps.
    mergeSessions(userId, indexes) {
        const rec = this.encounters.get(userId);
        if (!rec || !Array.isArray(rec.sessions)) return false;
        const sessions = rec.sessions;

        const picked = [...new Set(indexes)]
            .filter(i => Number.isInteger(i) && sessions[i])
            .map(i => sessions[i]);
        if (picked.length < 2) return false;

        const spanStart = Math.min(...picked.map(s => s.startedAt));
        const spanEnd   = Math.max(...picked.map(s => s.endedAt));
        const involved = sessions
            .filter(s => s.startedAt >= spanStart && s.endedAt <= spanEnd)
            .sort((a, b) => a.startedAt - b.startedAt);

        const first = involved[0];
        const last  = involved[involved.length - 1];
        const merged = {
            startedAt: spanStart,
            endedAt: spanEnd,
            durationMs: spanEnd - spanStart,
            guildId: first.guildId ?? null,
            guildName: first.guildName ?? null,
            channelId: first.channelId ?? null,
            channelName: first.channelName ?? null,
            isDM: !!first.isDM,
            username: last.username ?? first.username ?? null,
            globalName: last.globalName ?? first.globalName ?? null,
            mergedFrom: involved.reduce((n, s) => n + (s.mergedFrom || 1), 0),
            events: involved
                .flatMap(s => Array.isArray(s.events) ? s.events : [])
                .sort((a, b) => a.at - b.at)
        };

        // Totals: swap the old durations for the merged span; drop the meeting
        // boundaries that existed between the merged sessions.
        const oldMs = involved.reduce((n, s) => n + (s.durationMs ?? (s.endedAt - s.startedAt)), 0);
        let boundaries = 0;
        for (let i = 1; i < involved.length; i++) {
            if (involved[i].startedAt - involved[i - 1].endedAt > this.RECENT_MS) boundaries++;
        }
        rec.totalMs = Math.max(0, (rec.totalMs || 0) - oldMs + merged.durationMs);
        rec.meetings = Math.max(1, (rec.meetings || 1) - boundaries);

        const involvedSet = new Set(involved);
        rec.sessions = sessions.filter(s => !involvedSet.has(s));
        rec.sessions.push(merged);
        rec.sessions.sort((a, b) => a.startedAt - b.startedAt);

        vetLog("info", `[merge] ${this.getUserName(userId)}: ${involved.length} sessions → ${this.formatDuration(merged.durationMs)}`);
        this.scheduleSave(this.MEETING_SAVE_MS);
        return true;
    }

    // Re-render the tracker window if it is open, so new meetings show up immediately
    _refreshOpenTracker() {
        const overlay = this._vetOverlay;
        if (!overlay || !overlay.isConnected) return;
        if (this._vetRefreshPending) return;
        this._vetRefreshPending = true;
        requestAnimationFrame(() => {
            this._vetRefreshPending = false;
            try { if (overlay.isConnected) this._refreshSettingsContents(overlay, null); } catch (e) {}
        });
    }

    // =====================================================================
    // Persistence
    // =====================================================================

    getStoreKey() { return "encounters"; }

    // ── Safe persistence ────────────────────────────────────────────────
    // BdApi.Data rewrites <name>.config.json in place and plugins have no fs,
    // so we can't do tmp+rename here. Instead every save is mirrored into
    // separate backup files (different BdApi.Data namespaces = different files):
    //   VoiceEncounterTracker.backup-last.config.json   - last good save
    //   VoiceEncounterTracker.backup-day0..2.config.json - one per day, 3 days
    // On load, if the main file is missing/broken or holds far less history
    // than the best backup, the backup is restored automatically.

    _countSessions(users) {
        let n = 0;
        for (const u of users || []) n += Array.isArray(u?.sessions) ? u.sessions.length : 0;
        return n;
    }

    _readStore(ns) {
        try {
            const d = BdApi.Data.load(ns, this.getStoreKey());
            if (!d || !Array.isArray(d.users)) return null;
            return d;
        } catch (e) {
            vetLog("warn", `read ${ns} failed:`, e);
            return null;
        }
    }

    _backupNamespaces() {
        const base = this.meta.name + ".backup-";
        return [base + "last", base + "day0", base + "day1", base + "day2"];
    }

    _pickRestoreCandidate(main) {
        const mainSessions = this._countSessions(main?.users);
        const clearedAt = main?.clearedAt || 0;
        let best = null;
        for (const ns of this._backupNamespaces()) {
            const d = this._readStore(ns);
            if (!d) continue;
            if ((d.savedAt || 0) <= clearedAt) continue;   // older than a deliberate "Clear"
            const n = this._countSessions(d.users);
            if (!best || n > best.sessions) best = { ns, data: d, sessions: n };
        }
        if (!best || best.sessions === 0) return null;
        // Restore when the main store is gone, or lost more than half of its history.
        if (!main || mainSessions < best.sessions * 0.5) return best;
        return null;
    }

    loadEncounters() {
        let main = this._readStore(this.meta.name);
        let rawOk = true;
        try { BdApi.Data.load(this.meta.name, this.getStoreKey()); } catch (e) { rawOk = false; }

        const restore = this._pickRestoreCandidate(main);
        if (restore) {
            vetLog("warn", `loadEncounters: main store has ${this._countSessions(main?.users)} sessions, `
                + `restoring ${restore.sessions} sessions from ${restore.ns}`);
            main = restore.data;
            this._restoredFrom = restore.ns;
        } else if (!rawOk) {
            vetLog("error", "loadEncounters: main store unreadable and no backup; saving disabled until restart");
            this._encountersLoadFailed = true;
            return;
        }

        const arr = Array.isArray(main?.users) ? main.users : [];
        this.encounters.clear();
        let bad = 0;
        for (const rec of arr) {
            try {
                if (!rec || !rec.userId) { bad++; continue; }
                rec.sessions = Array.isArray(rec.sessions) ? rec.sessions.filter(x => x && typeof x === "object") : [];
                for (const s of rec.sessions) {
                    if (!Array.isArray(s.events)) s.events = [];
                }
                this.encounters.set(rec.userId, rec);
            } catch (e) { bad++; }
        }
        this._storedUserCount = arr.length;
        this._storedSessionCount = this._countSessions(arr);
        this._clearedAt = main?.clearedAt || 0;
        vetLog("info", `loadEncounters: ${this.encounters.size} users, ${this._storedSessionCount} sessions`
            + (bad ? `, ${bad} bad records skipped` : ""));
        if (this._restoredFrom) this.saveEncounters();   // write the restored data back to the main file
    }

    saveEncounters() {
        if (this._stopped) return;   // late timers/async after stop() must not save the cleared map
        if (this._encountersLoadFailed) {
            vetLog("warn", "saveEncounters: skipped, load had failed");
            return;
        }
        const users = Array.from(this.encounters.values());
        const sessions = this._countSessions(users);
        // Never overwrite existing history with an empty list (e.g. after a failed load).
        if (users.length === 0 && (this._storedUserCount || 0) > 0) {
            vetLog("warn", `saveEncounters: refusing to replace ${this._storedUserCount} stored users with an empty list`);
            return;
        }
        const payload = { version: 3, savedAt: Date.now(), clearedAt: this._clearedAt || 0, users };
        try {
            BdApi.Data.save(this.meta.name, this.getStoreKey(), payload);
            this._storedUserCount = users.length;
        } catch (e) {
            vetLog("error", "saveEncounters failed:", e);
            return;
        }

        // Backups. "last" must not be degraded by a save that lost most of the history.
        const [lastNs, ...dayNs] = this._backupNamespaces();
        try {
            const prev = this._readStore(lastNs);
            const prevSessions = this._countSessions(prev?.users);
            const deliberateClear = (this._clearedAt || 0) > (prev?.savedAt || 0);
            if (!prev || deliberateClear || sessions >= prevSessions * 0.5) {
                BdApi.Data.save(lastNs, this.getStoreKey(), payload);
            } else {
                vetLog("warn", `backup-last kept: new save has ${sessions} sessions vs ${prevSessions}`);
            }
        } catch (e) { vetLog("warn", "backup-last failed:", e); }
        try {
            const day = Math.floor(Date.now() / 86400000);
            const ns = dayNs[day % dayNs.length];
            const cur = this._readStore(ns);
            const curDay = cur?.savedAt ? Math.floor(cur.savedAt / 86400000) : -1;
            if (curDay !== day) BdApi.Data.save(ns, this.getStoreKey(), payload);
        } catch (e) { vetLog("warn", "backup-day failed:", e); }
    }

    flushEncounters() { this.saveEncounters(); }

    scheduleSave(delayMs = this.SAVE_DEBOUNCE_MS) {
        // Never push an already-scheduled save further out than the new deadline
        const due = Date.now() + delayMs;
        if (this._saveDebounce && this._saveDue && this._saveDue <= due) return;
        if (this._saveDebounce) clearTimeout(this._saveDebounce);
        this._saveDue = due;
        this._saveDebounce = this._addTimer(setTimeout(() => {
            this._saveDebounce = null;
            this._saveDue = 0;
            try { this.flushEncounters(); } catch (e) {}
        }, delayMs));
    }

    // =====================================================================
    // Query helpers
    // =====================================================================

    getUserName(userId) {
        const live = this._liveName(userId);
        if (live?.username) return live.username;
        const rec = this.encounters.get(userId);
        if (rec?.username && rec.username !== "(unknown)") return rec.username;
        const sessions = Array.isArray(rec?.sessions) ? rec.sessions : [];
        for (let i = sessions.length - 1; i >= 0; i--) {
            const sn = sessions[i];
            if (sn?.username || sn?.globalName) return sn.username || sn.globalName;
        }
        return rec?.globalName || "(unknown)";
    }

    _escape(str) {
        return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // Last known display name (globalName): live, else stored, else from sessions
    getStoredDisplayName(userId) {
        const live = this._liveName(userId);
        if (live?.globalName) return live.globalName;
        const rec = this.encounters.get(userId);
        if (rec?.globalName) return rec.globalName;
        const sessions = Array.isArray(rec?.sessions) ? rec.sessions : [];
        for (let i = sessions.length - 1; i >= 0; i--) {
            if (sessions[i]?.globalName) return sessions[i].globalName;
        }
        return null;
    }

    _liveName(userId) {
        try {
            const user = (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getUser?.(userId);
            if (!user || (!user.username && !user.globalName)) return null;
            return { username: user.username ?? null, globalName: user.globalName ?? null };
        } catch { return null; }
    }

    // Keep the record's "last known name" current; per-session names are the history.
    _rememberName(rec) {
        if (!rec) return null;
        const live = this._liveName(rec.userId);
        if (!live) return null;
        if (live.username) rec.username = live.username;
        if (live.globalName) rec.globalName = live.globalName;
        return live;
    }

    getDisplayName(userId, guildId) {
        try {
            const user = (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getUser?.(userId);
            let nick = null;
            if (guildId) {
                try {
                    const member = (this._sc?.GuildMemberStore ?? BdApi.Webpack.getStore("GuildMemberStore"))
                        ?.getMember?.(guildId, userId);
                    nick = member?.nick || null;
                } catch (e) {}
            }
            return nick
                || user?.globalName
                || user?.username
                || "(unknown)";
        } catch { return "(unknown)"; }
    }

    getGuildName(guildId, channelId = null) {
        if (!guildId) {
            // DM / group DM call
            const ch = channelId ? this._getChannel(channelId) : null;
            return this._isGroupDM(ch) ? "Group DM" : "Direct Messages";
        }
        try {
            return (this._sc?.GuildStore ?? BdApi.Webpack.getStore("GuildStore"))?.getGuild?.(guildId)?.name ?? null;
        } catch { return null; }
    }

    _getChannel(channelId) {
        try {
            return (this._sc?.ChannelStore ?? BdApi.Webpack.getStore("ChannelStore"))?.getChannel?.(channelId) ?? null;
        } catch { return null; }
    }

    _isGroupDM(ch) {
        if (!ch) return false;
        if (ch.type === 3) return true;
        try { return typeof ch.isGroupDM === "function" && ch.isGroupDM(); } catch { return false; }
    }

    getChannelGuildId(channelId) {
        return this._getChannel(channelId)?.guild_id ?? null;
    }

    getChannelName(channelId) {
        const ch = this._getChannel(channelId);
        if (!ch) return null;
        if (ch.guild_id) return ch.name ?? null;

        // DM / group DM: explicit group name, else recipients' names
        if (ch.name) return ch.name;
        const me = this.getCurrentUserId();
        const ids = (Array.isArray(ch.recipients) ? ch.recipients : [])
            .map(r => (typeof r === "string" ? r : r?.id))
            .filter(id => id && id !== me);
        if (ids.length === 0) return this._isGroupDM(ch) ? "Group call" : "DM call";
        const names = ids.map(id => this.getDisplayName(id, null));
        return names.join(", ");
    }

    getVoicePing() {
        let last = null;
        let avg = null;

        try {
            const mes = this._sc?.MediaEngineStore ?? BdApi.Webpack.getStore("MediaEngineStore");
            const eng = mes?.getMediaEngine?.();
            if (eng && typeof eng.eachConnection === "function") {
                eng.eachConnection((c) => {
                    try {
                        if (c?.context !== "default") return;
                        if (typeof c.getLastPing === "function") {
                            const v = c.getLastPing();
                            if (typeof v === "number" && isFinite(v) && v >= 0) last = v;
                        }
                        if (typeof c.getAveragePing === "function") {
                            const v = c.getAveragePing();
                            if (typeof v === "number" && isFinite(v) && v >= 0) avg = v;
                        }
                    } catch (e) {}
                });
            }
        } catch (e) {}

        if (last === null && avg === null) {
            try {
                const rtc = this._sc?.RTCConnectionStore ?? BdApi.Webpack.getStore("RTCConnectionStore");
                const conn = rtc?.getRTCConnection?.();
                if (conn) {
                    if (typeof conn.getLastPing === "function") {
                        const v = conn.getLastPing();
                        if (typeof v === "number" && isFinite(v) && v >= 0) last = v;
                    }
                    if (typeof conn.getAveragePing === "function") {
                        const v = conn.getAveragePing();
                        if (typeof v === "number" && isFinite(v) && v >= 0) avg = v;
                    }
                }
            } catch (e) {}
        }

        return { last, avg };
    }

    isRecent(userId) {
        const rec = this.encounters.get(userId);
        if (!rec || !rec.firstSeenAt) return false;
        return (Date.now() - rec.firstSeenAt) <= this.RECENT_MS;
    }

    getBadgeKind(userId) {
        const rec = this.encounters.get(userId);
        if (rec?.blocked) return "blocked";
        if (rec?.ignored) return "ignored";
        if (rec?.manual) return "known";
        if (this.isUserLocallyMuted(userId)) return "muted";
        if (!rec) return "stranger";
        if (this.isRecent(userId)) return "stranger";
        return this.hasEnoughTime(rec) ? "known" : "stranger";
    }

    getKnownMinMs() {
        const m = Number(this.prefs.knownMinMinutes);
        return (Number.isFinite(m) && m >= 0 ? m : 15) * 60_000;
    }

    hasEnoughTime(rec) {
        return (rec?.totalMs || 0) >= this.getKnownMinMs();
    }

    formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
        if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
        return `${s}s`;
    }

    formatDate(ts) {
        if (!ts) return "—";
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
               `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    formatTime(ts) {
        if (!ts) return "—";
        const d = new Date(ts);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    }

    // =====================================================================
    // Discord badges
    // =====================================================================

    injectBadges() {
        const rows = document.querySelectorAll("[class*='voiceUser']");
        if (rows.length === 0) return;

        const me = this.getCurrentUserId();

        for (const row of rows) {
            const avatarEl = row.querySelector("[class*='userAvatar']");
            if (!avatarEl) continue;

            const bg = avatarEl.style?.backgroundImage || "";
            const match = bg.match(/\/avatars\/(\d+)\//);
            if (!match) continue;

            const userId = match[1];
            if (me && me === userId) continue;

            const kind = this.getBadgeKind(userId);
            const existing = row.querySelector("[data-vet-badge]");

            if (existing) {
                if (existing.getAttribute("data-vet-kind") !== kind) {
                    this.applyBadgeStyle(existing, kind, userId);
                }
                continue;
            }

            const usernameEl = row.querySelector("[class*='username_']");
            if (!usernameEl) continue;

            if (!this.modifiedStyles.has(usernameEl)) {
                this.modifiedStyles.set(usernameEl, usernameEl.style.cssText);
            }

            usernameEl.style.display = "inline-flex";
            usernameEl.style.alignItems = "center";
            usernameEl.style.gap = "4px";

            const badge = document.createElement("span");
            badge.setAttribute("data-vet-badge", userId);
            this.applyBadgeStyle(badge, kind, userId);

            usernameEl.appendChild(badge);
            this.badgeNodes.set(userId, badge);
        }
    }

    applyBadgeStyle(el, kind, userId) {
        const rec = this.encounters.get(userId);
        let glyph, title, color, opacity;

        if (kind === "blocked") {
            glyph = "⊘"; title = "Blocked user";
            color = "var(--status-danger, #ed4245)"; opacity = "0.75";
        } else if (kind === "ignored") {
            glyph = "⊘"; title = "Ignored user";
            color = "var(--text-warning, #faa61a)"; opacity = "0.65";
        } else if (kind === "muted") {
            glyph = "○"; title = "You muted this user in voice";
            color = "#72767d"; opacity = "0.55";
        } else if (kind === "known") {
            glyph = "✓";
            title = rec
                ? `Known · met ${rec.meetings}× · total ${this.formatDuration(rec.totalMs)} · last ${this.formatDate(rec.lastSeenAt)}`
                : "Known user";
            color = "var(--text-positive, #3ba55d)"; opacity = "0.55";
        } else {
            glyph = "!";
            title = rec
                ? `New encounter · first seen ${this.formatDate(rec.firstSeenAt)} · together ${this.formatDuration(rec.totalMs || 0)} / ${this.formatDuration(this.getKnownMinMs())}`
                : "You've never shared a voice channel with this user";
            color = "var(--text-muted, #a3a6aa)"; opacity = "0.40";
        }

        el.setAttribute("data-vet-kind", kind);
        el.textContent = glyph;
        el.title = title;
        el.style.cssText = [
            "display:inline-block",
            "margin-left:4px",
            "font-size:11px",
            "line-height:1",
            `opacity:${opacity}`,
            `color:${color}`,
            "font-weight:700",
            "cursor:default",
            "pointer-events:auto",
            "user-select:none"
        ].join(";") + ";";
    }

    restoreModifiedStyles() {
        for (const [el, css] of this.modifiedStyles) {
            try {
                if (css) el.style.cssText = css;
                else el.removeAttribute("style");
            } catch (e) {}
        }
        this.modifiedStyles.clear();
    }

    // =====================================================================
    // Overlay push
    // =====================================================================

    pushStateToOverlay() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;

            let mySession = this.active.get(me);
            if (!mySession) {
                this.seedSelfSession();
                mySession = this.active.get(me);
            }
            if (!mySession) {
                this._postJSON("/state", {
                    guildId: null, channelId: null, channelName: null, users: [],
                    prefs: this._prefsPayload(),
                    streamSound: null,
                    returnTo: this._returnCard(),
                    leaveStats: this._leaveStats && Date.now() < this._leaveStats.until ? this._leaveStats : null
                });
                return;
            }
            if (this._returnTo) this._returnTo = null;

            const guildId = mySession.guildId;
            const users = [];
            for (const [userId, s] of this.active) {
                if (s.channelId !== mySession.channelId) continue;

                const isSelf = userId === me;
                const kind = isSelf ? "known" : this.getBadgeKind(userId);
                const user = (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getUser?.(userId);
                const rec = this.encounters.get(userId);
                if (isSelf && !s.streaming) { this._knownViewers = null; this._viewerSince = null; this._streamStartedAt = 0; }

                users.push({
                    userId,
                    username: user?.username ?? "(unknown)",
                    displayName: this.getDisplayName(userId, guildId),
                    avatar: user?.avatar ?? null,
                    kind,
                    blocked: !!rec?.blocked,
                    ignored: !!rec?.ignored,
                    muted: isSelf ? false : this.isUserLocallyMuted(userId),
                    isSelf,
                    selfMute:   !!s.selfMute,
                    selfDeaf:   !!s.selfDeaf,
                    serverMute: !!s.serverMute,
                    serverDeaf: !!s.serverDeaf,
                    streaming:  !!s.streaming,
                    video:      !!s.video,
                    suppress:   !!s.suppress,
                    selfMuteAt:   s.selfMuteAt   || 0,
                    selfDeafAt:   s.selfDeafAt   || 0,
                    selfUnmuteAt: s.selfUnmuteAt || 0,
                    selfUndeafAt: s.selfUndeafAt || 0,
                    serverMuteAt: s.serverMuteAt || 0,
                    serverDeafAt: s.serverDeafAt || 0,
                    unreadDM: isSelf ? 0 : this._unreadDMCount(userId),
                    activity: this._activityFor(userId),
                    mobile: this._isOnMobile(userId),
                    volume: isSelf ? null : this._localVolume(userId),
                    manualKnown: !!rec?.manual,
                    viewers: isSelf && s.streaming ? this._myStreamViewers(mySession) : null,
                    streamSourceId: isSelf && s.streaming ? this._myStreamSourceId() : null,
                    favorite: !isSelf && !!this._favorites?.has(userId),
                    favSound: !isSelf && !!this._favorites?.get(userId)?.sound
                });
            }

            this._postJSON("/state", {
                guildId: mySession.guildId ?? null,
                channelId: mySession.channelId,
                channelName: this.getChannelName(mySession.channelId),
                guildName: this.getGuildName(mySession.guildId, mySession.channelId),
                isDM: !mySession.guildId,
                users,
                departures: this._departureCards(mySession),
                prefs: this._prefsPayload(),
                streamSound: this._getLiveStreamSound()
            });
        } catch (e) {}
    }

    pushPingToOverlay() {
        try {
            const { last, avg } = this.getVoicePing();
            this._postJSON("/ping", { last, avg });
        } catch (e) {}
    }

    pushSpeakingToOverlay() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;

            let mySession = this.active.get(me);
            if (!mySession) {
                this.seedSelfSession();
                mySession = this.active.get(me);
            }
            if (!mySession) {
                this._postJSON("/speaking", { speakers: [] });
                return;
            }

            let speakers = [];
            try {
                const ss = this._sc?.SpeakingStore ?? BdApi.Webpack.getStore("SpeakingStore");
                if (ss && typeof ss.getSpeakers === "function") {
                    speakers = ss.getSpeakers() ?? [];
                }
            } catch (e) {}

            try {
                const ss2 = this._sc?.SpeakingStore ?? BdApi.Webpack.getStore("SpeakingStore");
                if (ss2 && typeof ss2.isSpeaking === "function") {
                    const selfSpeaking = ss2.isSpeaking(me);
                    if (selfSpeaking && !speakers.includes(me)) speakers = speakers.concat([me]);
                    else if (!selfSpeaking) speakers = speakers.filter(id => id !== me);
                }
            } catch (e) {}

            const inChannel = new Set();
            for (const [userId, s] of this.active) {
                if (s.channelId !== mySession.channelId) continue;
                inChannel.add(userId);
            }

            // Ask the store per user: getSpeakers() is not reliable across Discord builds
            try {
                const ss3 = this._sc?.SpeakingStore ?? BdApi.Webpack.getStore("SpeakingStore");
                if (ss3 && typeof ss3.isSpeaking === "function") {
                    const set = new Set(speakers);
                    for (const uid of inChannel) {
                        if (ss3.isSpeaking(uid)) set.add(uid);
                        else set.delete(uid);
                    }
                    speakers = [...set];
                }
            } catch (e) {}

            speakers = speakers.filter(id => inChannel.has(id));

            const key = speakers.slice().sort().join(",");
            if (key === this._lastSpeakers) return;
            this._lastSpeakers = key;
            this._postJSON("/speaking", { speakers });
        } catch (e) {}
    }

    _isSelfSpeakingFromDOM(meId) {
        try {
            const rows = document.querySelectorAll("[class*='voiceUser']");
            for (const row of rows) {
                const avatarEl = row.querySelector("[class*='userAvatar']");
                if (!avatarEl) continue;
                const bg = avatarEl.style?.backgroundImage || "";
                const m = bg.match(/\/avatars\/(\d+)\//);
                if (!m || m[1] !== meId) continue;

                const computed = getComputedStyle(avatarEl);
                const shadow = computed.boxShadow || "";
                if (!shadow) return false;

                const withoutZero = shadow.replace(/rgba\(0,\s*0,\s*0,\s*0\)/g, "");
                return /rgba?\(/.test(withoutZero) && /\d/.test(withoutZero);
            }
        } catch (e) {}
        return false;
    }

    // Long-poll: the server holds GET /commands?wait=… until a command arrives,
    // so overlay clicks reach Discord immediately instead of on a 1 s poll.
    async startCommandLoop() {
        const gen = this._cmdLoopGen = (this._cmdLoopGen || 0) + 1;
        const WAIT_MS = 20000;
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        while (this._cmdLoopGen === gen) {
            const t0 = Date.now();
            let cmds = null;
            try {
                const r = await BdApi.Net.fetch(`${this.OVERLAY_URL}/commands?wait=${WAIT_MS}`,
                    { method: "GET", timeout: WAIT_MS + 10000 });
                const data = await r.json();
                cmds = Array.isArray(data?.commands) ? data.commands : [];
            } catch (e) {
                cmds = null; // overlay not running
            }
            if (this._cmdLoopGen !== gen) return;

            if (cmds && cmds.length) {
                for (const cmd of cmds) {
                    try { this.executeOverlayCommand(cmd); } catch (e) {}
                    this._postJSON("/command-done", { id: cmd.id });
                }
                continue;
            }

            // Server down, or an older server that answers at once: don't spin
            if (cmds === null) await sleep(2000);
            else if (Date.now() - t0 < 500) await sleep(this.COMMAND_POLL_MS);
        }
    }

    executeOverlayCommand(cmd) {
        const { action, userId, sourceId, name } = cmd;
        if (!action) return;

        if (action === "watch-stream") {
            if (!userId) return;
            vetLog("info", "watch-stream requested for", userId);
            this._watchStream(userId, { reconnect: cmd.name === "reconnect" });
            return;
        }

        if (action === "stop-stream") {
            vetLog("info", "stop-stream requested (viewer closed)");
            // Queued behind any watch in progress, so a half-started watch never
            // has its track released under it; pending watches are cancelled.
            this._watchToken = (this._watchToken || 0) + 1;
            const stop = () => this._stopFramePump();
            this._watchChain = (this._watchChain || Promise.resolve()).then(stop, stop);
            return;
        }

        if (action === "switch-source") {
            if (!sourceId) return;
            this._switchStreamSource(sourceId, name, cmd.sound);
            return;
        }

        if (action === "set-stream-sound") {
            const enabled = cmd.sound !== false;
            this._setStreamSound(enabled);
            return;
        }

        if (action === "open-channel") {
            if (cmd.channelId) this._openChannel(String(cmd.channelId), cmd.name || null);
            return;
        }
        if (action === "call-accept") {
            if (cmd.channelId) { this._selectVoiceChannel(String(cmd.channelId)); this._clearCall(String(cmd.channelId)); }
            return;
        }
        if (action === "call-decline") {
            if (cmd.channelId) this._declineCall(String(cmd.channelId));
            return;
        }
        if (action === "call-reply") {
            if (cmd.channelId) {
                this._sendMessage(String(cmd.channelId), String(cmd.name || ""));
                this._declineCall(String(cmd.channelId));
            }
            return;
        }
        if (action === "watch-camera") {
            if (userId) this._watchCamera(String(userId));
            return;
        }
        if (action === "leave-voice") {
            this._selectVoiceChannel(null);
            return;
        }
        if (action === "join-channel") {
            if (cmd.channelId) this._selectVoiceChannel(String(cmd.channelId));
            return;
        }
        if (action === "dismiss-return") {
            this._returnTo = null;
            this._saveLastVoice({ ...(this._loadLastVoice() || {}), selfLeft: true });
            this.scheduleOverlayPush();
            return;
        }
        if (action === "dismiss-departure") {
            if (userId) this._departures?.delete(String(userId));
            this.scheduleOverlayPush();
            return;
        }

        if (!userId) return;

        const rel = BdApi.Webpack.getByKeys("blockUser", "unblockUser", { searchExports: true });

        if (action === "block" && rel?.blockUser) rel.blockUser(userId);
        else if (action === "unblock" && rel?.unblockUser) rel.unblockUser(userId);
        else if (action === "ignore" && rel?.ignoreUser) rel.ignoreUser(userId);
        else if (action === "unignore" && rel?.unignoreUser) rel.unignoreUser(userId);
        else if (action === "set-volume")   this._setLocalVolume(userId, Number(cmd.name));
        else if (action === "open-dm")      this._openDM(userId);
        else if (action === "open-profile") this._openProfile(userId);
        else if (action === "set-favorite") this.setFavorite(userId, cmd.sound === true);
        else if (action === "set-fav-sound") this.setFavoriteSound(userId, cmd.sound === true);
        else if (action === "set-known") {
            if (cmd.sound === true) this.markUserAsKnown(userId);
            else this.unmarkKnown(userId);
        }
        else if (action === "listen-along") this._listenAlong(userId);
        else if (action === "mute") this.applyLocalMute(userId, true);
        else if (action === "unmute") this.applyLocalMute(userId, false);
        else if (action === "self-mute")   this.toggleSelfMute();
        else if (action === "self-deaf")   this.toggleSelfDeaf();
        else if (action === "self-stream") this.toggleSelfStream();

        this._addTimer(setTimeout(() => {
            try { this.syncRelationshipLists(); } catch (e) {}
            try { this.syncMuteList(); } catch (e) {}
            try { this.pushStateToOverlay(); } catch (e) {}
        }, 300));
    }

    _postJSON(path, payload) {
        try {
            BdApi.Net.fetch(this.OVERLAY_URL + path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }).catch(() => {});
        } catch (e) {}
    }

    // =====================================================================
    // Self actions (mute / deaf / stream)
    // =====================================================================

    toggleSelfMute() {
        try {
            const actions = BdApi.Webpack.getByKeys("toggleSelfMute", { searchExports: true });
            if (actions?.toggleSelfMute) {
                actions.toggleSelfMute();
                return true;
            }
        } catch (e) {}
        vetLog("warn", "toggleSelfMute: not found");
        return false;
    }

    toggleSelfDeaf() {
        try {
            const actions = BdApi.Webpack.getByKeys("toggleSelfDeaf", { searchExports: true });
            if (actions?.toggleSelfDeaf) {
                actions.toggleSelfDeaf();
                return true;
            }
        } catch (e) {}
        vetLog("warn", "toggleSelfDeaf: not found");
        return false;
    }

    toggleSelfStream() {
        const me = this.getCurrentUserId();
        if (!me) return false;
        const mySession = this.active.get(me);
        if (!mySession) return false;

        if (mySession.streaming) {
            return this._stopSelfStream();
        } else {
            this._startSelfStream().catch(() => {});
            return true;
        }
    }

    async _startSelfStream() {
        try {
            const D = BdApi.Webpack.getByStrings("startStream", { searchExports: true });
            if (!D || typeof D !== "function") {
                vetLog("warn", "_startSelfStream: startStream not found");
                return false;
            }

            let sources = [];
            let preferredId = "screen:0:0";
            try {
                const r = await BdApi.Net.fetch(`${this.OVERLAY_URL}/sources`, { method: "GET" });
                const data = await r.json();
                sources = Array.isArray(data?.sources) ? data.sources : [];
                preferredId = data?.preferredId || preferredId;
            } catch (e) {
                vetLog("warn", "_startSelfStream: overlay /sources failed", e);
            }

            if (!Array.isArray(sources) || !sources.length) {
                vetLog("warn", "_startSelfStream: no sources available");
                return false;
            }

            const pick =
                sources.find(s => s.id === preferredId) ||
                sources.find(s => s.id === "screen:0:0") ||
                sources.find(s => s.id.startsWith("screen:")) ||
                sources[0];

            if (!pick) {
                vetLog("warn", "_startSelfStream: no source picked");
                return false;
            }

            let source;
            if (pick.id.startsWith("screen:")) {
                if (pick.handle == null) {
                    vetLog("warn", "_startSelfStream: screen has no HMONITOR handle", pick);
                    return false;
                }
                source = {
                    id: `screen-handle:${pick.handle}`,
                    name: pick.name,
                    type: "screen-handle"
                };
            } else {
                source = {
                    id: pick.id,
                    name: pick.name,
                    type: "window-handle"
                };
            }

            vetLog("info", "_startSelfStream: using", source);

            await D(source).then(result => {
                vetLog("info", "startStream result:", result);
                this._currentStreamSource = { id: source.id, name: source.name };
            }).catch(e => {
                vetLog("error", "_startSelfStream:", e);
            });

            const desiredSound = this._pendingStreamSound !== undefined
                ? !!this._pendingStreamSound
                : true;
            setTimeout(() => {
                try { this._setStreamSound(desiredSound); } catch (e) {}
            }, 1500);

            return true;
        } catch (e) {
            vetLog("error", "_startSelfStream:", e);
            return false;
        }
    }

    _switchStreamSource(discordSourceId, name, soundArg = null) {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("setGoLiveSource", { searchExports: true });

            if (!mes || !actions?.setGoLiveSource) {
                vetLog("warn", "_switchStreamSource: setGoLiveSource not found");
                return false;
            }

            const current = mes.getGoLiveSource?.();
            if (!current) {
                vetLog("info", "_switchStreamSource: not streaming");
                this._currentStreamSource = { id: discordSourceId, name: name || discordSourceId };
                return false;
            }

            const quality = current.quality || {};
            const payload = {
                desktopSettings: {
                    sourceId: discordSourceId,
                    sound: soundArg !== null && soundArg !== undefined
                        ? !!soundArg
                        : (current.desktopSource?.sound ?? true)
                },
                qualityOptions: {
                    preset: 1,
                    resolution: quality.resolution ?? 1080,
                    frameRate: quality.frameRate ?? 30
                },
                context: "stream"
            };

            vetLog("info", "_switchStreamSource:", payload);
            actions.setGoLiveSource(payload);
            this._currentStreamSource = { id: discordSourceId, name: name || discordSourceId };
            return true;
        } catch (e) {
            vetLog("error", "_switchStreamSource:", e);
            return false;
        }
    }

    // Watch requests run one at a time: two overlapping watches (one holding
    // Discord's native track while the other makes Discord rejoin the stream)
    // crash Discord. A request that is superseded while waiting is dropped.
    _watchStream(userId, opts = {}) {
        const token = (this._watchToken = (this._watchToken || 0) + 1);
        const run = async () => {
            if (token !== this._watchToken) {
                vetLog("info", "_watchStream: superseded, skipped");
                return false;
            }
            return this._watchStreamImpl(userId, opts);
        };
        this._watchChain = (this._watchChain || Promise.resolve()).then(run, run);
        return this._watchChain;
    }

    async _watchStreamImpl(userId, { reconnect = false } = {}) {
        try {
            const me = this.getCurrentUserId();
            const mySession = this.active.get(me);
            if (!mySession) {
                vetLog("warn", "_watchStream: no own session");
                return false;
            }

            const streamKey = mySession.guildId
                ? `guild:${mySession.guildId}:${mySession.channelId}:${userId}`
                : `call:${mySession.channelId}:${userId}`;
            vetLog("info", "_watchStream: key =", streamKey);

            if (!reconnect) this._postJSON("/video/open", { userId, streamKey });

            if (!reconnect && this._watchedUserId === userId && this._framePump) {
                vetLog("info", "_watchStream: already watching, reusing");
                return true;
            }
            if (reconnect) {
                vetLog("info", "_watchStream: reconnect for", userId);
                this._stopFramePump();
            }

            // The last pump on this user's stream sent no frames at all:
            // Discord's own copy is frozen, so reusing it can't recover.
            const frozen = this._frozenSource && this._frozenSource.userId === String(userId);
            const lastRewatch = (this._lastRewatchAt ||= {})[userId] || 0;
            const rewatch = frozen && Date.now() - lastRewatch > 30000;
            if (rewatch) {
                this._lastRewatchAt[userId] = Date.now();
                this._stopFramePump();
                // Let Discord's pipeline let go of the old track before it rejoins.
                await new Promise(res => setTimeout(res, 1000));
            }
            const frozenSid = frozen ? this._frozenSource.sid : null;
            this._frozenSource = null;

            const stream = await this._watchStreamByUserId(userId, { rewatch, frozenSid });
            if (!stream) {
                vetLog("warn", "_watchStream: no stream");
                return false;
            }

            this._watchedUserId = userId;
            await this._startWatchStreamPeer(stream);
            return true;
        } catch (e) {
            vetLog("error", "_watchStream:", e);
            return false;
        }
    }

    // rewatch: Discord's copy of the stream is frozen (still ACTIVE, no frames).
    // Our pump is already stopped and its native handle released, so nothing
    // of ours holds the old track when STREAM_WATCH makes Discord rejoin.
    async _watchStreamByUserId(userId, { timeout = 20000, rewatch = false, frozenSid = null } = {}) {
        const me = this.getCurrentUserId();
        const mySession = this.active.get(me);
        if (!mySession) {
            vetLog("warn", "_watchStreamByUserId: no own session");
            return null;
        }

        if (!rewatch && this._watchedUserId === userId) {
            const existing = this._findLiveVideoForStream();
            if (existing) {
                vetLog("info", "_watchStreamByUserId: already live, reusing");
                const track = existing.srcObject.getVideoTracks()[0];
                try { return new MediaStream([track.clone()]); }
                catch { return new MediaStream([track]); }
            }
        }

        if (!rewatch) {
            const reused = await this._reuseDiscordWatch(userId);
            if (reused) return reused;
        }

        const before = new Set(document.querySelectorAll("video"));

        const streamWatch = BdApi.Webpack.getByStrings("STREAM_WATCH", "allowMultiple", { searchExports: true });
        if (typeof streamWatch !== "function") {
            vetLog("error", "_watchStreamByUserId: streamWatch not found");
            return null;
        }
        try {
            streamWatch({
                streamType: "guild",
                guildId: mySession.guildId,
                channelId: mySession.channelId,
                ownerId: userId,
            });
            vetLog("info", "STREAM_WATCH dispatched for", userId, rewatch ? "(rewatch, frozen sid " + frozenSid + ")" : "");
        } catch (e) {
            vetLog("error", "streamWatch failed:", e);
            return null;
        }

        if (rewatch) {
            // Take the track only once Discord has a new stream id; the frozen
            // one is never picked up again.
            const t0 = Date.now();
            while (Date.now() - t0 < timeout) {
                await new Promise(res => setTimeout(res, 1000));
                const fresh = await this._reuseDiscordWatch(userId, { excludeSid: frozenSid });
                if (fresh) return fresh;
            }
            vetLog("warn", "rewatch: no new stream id from Discord");
            return null;
        }

        const video = await this._waitForLiveVideo(timeout, before);
        if (!video) {
            vetLog("warn", "no live video appeared");
            return null;
        }

        const streamId = this._extractStreamId(video);
        if (streamId) {
            vetLog("info", "streamId =", streamId);
            (this._streamIdByUser ||= {})[userId] = streamId;

            const nz = this._findNzFunction();
            if (typeof nz === "function") {
                try {
                    const handle = nz(streamId);
                    if (handle && handle.stream) {
                        this._nativeStreamHandle = handle;
                        this._sourceSid = String(streamId);
                        const nativeTrack = handle.stream.getVideoTracks()[0];
                        if (nativeTrack) {
                            vetLog("info", "native track:",
                                nativeTrack.readyState,
                                "muted:", nativeTrack.muted,
                                "label:", nativeTrack.label
                            );
                            vetLog("info", "returning original native track (no clone)");
                            return new MediaStream([nativeTrack]);
                        }
                    }
                } catch (e) {
                    vetLog("warn", "nz failed, falling back:", e);
                }
            }
        } else {
            vetLog("warn", "no streamId — falling back to srcObject clone");
        }

        const track = video.srcObject?.getVideoTracks?.()[0];
        if (!track) {
            vetLog("error", "no video track on fallback");
            return null;
        }
        let liveTrack = track;
        const t0 = Date.now();
        while (liveTrack.readyState !== "live" && Date.now() - t0 < 3000) {
            await new Promise(r => setTimeout(r, 100));
        }
        try {
            const cloned = liveTrack.clone();
            vetLog("info", "fallback cloned track:", cloned.readyState);
            return new MediaStream([cloned]);
        } catch (e) {
            vetLog("info", "fallback without clone:", liveTrack.readyState);
            return new MediaStream([liveTrack]);
        }
    }

    // If Discord already watches this user's stream, take its video without
    // dispatching STREAM_WATCH again (that makes Discord drop and rejoin the stream).
    async _reuseDiscordWatch(userId, { excludeSid = null } = {}) {
        let active = [];
        try {
            const ass = BdApi.Webpack.getStore("ApplicationStreamingStore");
            active = (ass?.getAllActiveStreams?.() || []).filter(x => x && x.state !== "ENDED");
        } catch (e) {}
        const mine = active.find(x => String(x.ownerId) === String(userId));
        vetLog("info", "_reuseDiscordWatch: active streams =",
            active.map(x => `${x.ownerId}:${x.state}`).join(","), "match:", !!mine);
        if (!mine) return null;

        // 1) Native track via Discord's stream id
        let sid = null;
        try {
            const vss = BdApi.Webpack.getStore("VideoStreamStore");
            sid = vss?.getStreamId?.(userId, "stream") ?? null;
        } catch (e) {}
        if (!sid && active.length === 1 && this._streamIdByUser?.[userId]) sid = this._streamIdByUser[userId];
        if (sid && excludeSid != null && String(sid) === String(excludeSid)) {
            vetLog("info", "_reuseDiscordWatch: still the frozen stream id", sid);
            return null;
        }
        if (sid) {
            const nz = this._findNzFunction();
            if (typeof nz === "function") {
                try {
                    const handle = nz(String(sid));
                    const t = handle?.stream?.getVideoTracks?.()[0];
                    if (t) {
                        this._nativeStreamHandle = handle;
                        this._sourceSid = String(sid);
                        vetLog("info", "_reuseDiscordWatch: native track via streamId", sid);
                        return new MediaStream([t]);
                    }
                } catch (e) { vetLog("warn", "_reuseDiscordWatch nz failed:", e); }
            }
        }

        // 2) Discord's own <video> element (only safe when exactly one stream is watched)
        if (excludeSid != null) return null;
        if (active.length === 1) {
            const v = this._findLiveVideoForStream() || await this._waitForLiveVideo(3000);
            const t = v?.srcObject?.getVideoTracks?.()[0];
            if (t) {
                vetLog("info", "_reuseDiscordWatch: cloned track from Discord video element");
                try { return new MediaStream([t.clone()]); } catch (e) { return new MediaStream([t]); }
            }
        }
        vetLog("warn", "_reuseDiscordWatch: watched in Discord but no track found, will dispatch");
        return null;
    }

    _extractStreamId(video) {
        if (this._lastDiscordStreamId) {
            vetLog("info", "_extractStreamId: using nz-patched streamId:",
                this._lastDiscordStreamId);
            return String(this._lastDiscordStreamId);
        }
        vetLog("warn", "_extractStreamId: no streamId from nz patch");
        return null;
    }

    _findNzFunction() {
        if (this._nzCache) return this._nzCache;
        let found = null;
        try {
            BdApi.Webpack.getModule((m) => {
                if (!m || typeof m !== "object") return false;
                if (typeof m.nz === "function"
                    && m.nz.toString().includes("addDirectVideoOutputSink")) {
                    found = m.nz;
                    return true;
                }
                return false;
            }, { searchExports: true });
        } catch (e) {}
        if (found) this._nzCache = found;
        return found;
    }

    _findLiveVideoForStream() {
        let found = null;
        document.querySelectorAll("video").forEach((v) => {
            if (found) return;
            if (!(v.srcObject instanceof MediaStream)) return;
            const track = v.srcObject.getVideoTracks()[0];
            if (!track || track.readyState !== "live") return;
            const pc = v.parentElement?.className || "";
            if (pc.includes("media-engine-video")) found = v;
        });
        return found;
    }

    _waitForLiveVideo(timeoutMs, exclude = new Set()) {
        return new Promise((resolve) => {
            const seen = new WeakSet();
            const start = Date.now();
            const check = () => {
                let found = null;
                document.querySelectorAll("video").forEach((v) => {
                    if (exclude.has(v)) return;
                    if (seen.has(v)) return;
                    seen.add(v);
                    if (!(v.srcObject instanceof MediaStream)) return;
                    const track = v.srcObject.getVideoTracks()[0];
                    if (!track || track.readyState !== "live") return;
                    const pc = v.parentElement?.className || "";
                    if (pc.includes("media-engine-video")) found = v;
                });
                return found;
            };
            const v0 = check();
            if (v0) return resolve(v0);
            const observer = new MutationObserver(() => {
                const v = check();
                if (v) { observer.disconnect(); resolve(v); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            const timer = setInterval(() => {
                const v = check();
                if (v) {
                    clearInterval(timer);
                    observer.disconnect();
                    resolve(v);
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    observer.disconnect();
                    resolve(null);
                }
            }, 500);
        });
    }

    async _startWatchStreamPeer(stream) {
        // Close only the previous peer. The native handle and user id were
        // just set for THIS stream; releasing the handle here pulled Discord's
        // track out from under the new peer.
        const keepHandle = this._nativeStreamHandle;
        const keepUser = this._watchedUserId;
        const keepSid = this._sourceSid;
        if (this._framePump) {
            this._framePump.stop();
            vetLog("info", "frame pump stopped (replaced)");
        }
        this._nativeStreamHandle = keepHandle;
        this._watchedUserId = keepUser;
        this._sourceSid = keepSid;

        const pc = new RTCPeerConnection({ iceServers: [] });
        this._watchPeer = pc;
        let statsTimer = null;
        let statsPrevPackets = 0;
        const pumpUserId = this._watchedUserId != null ? String(this._watchedUserId) : null;
        const pumpSid = this._sourceSid || null;
        const pumpStartedAt = Date.now();

        pc.onconnectionstatechange = () => {
            vetLog("info", "watch peer state:", pc.connectionState);
            if (pc.connectionState === "failed") {
                vetLog("warn", "watch peer failed");
            }
        };

        for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
            track.addEventListener("ended", () => vetLog("warn", "watch source track ENDED", track.kind));
            track.addEventListener("mute", () => vetLog("warn", "watch source track MUTED", track.kind));
            track.addEventListener("unmute", () => vetLog("info", "watch source track unmuted", track.kind));
        }

        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = 8_000_000;
                params.encodings[0].scaleResolutionDownBy = 1;
                params.encodings[0].networkPriority = "high";
                params.encodings[0].priority = "high";
                params.encodings[0].degradationPreference = "maintain-resolution";
                await sender.setParameters(params);
                vetLog("info", "sender tuned (pre-offer):",
                    JSON.stringify(params.encodings[0]));
            }
        } catch (e) {
            vetLog("warn", "pre-offer setParameters failed:", e.message);
        }

        try {
            const caps = RTCRtpSender.getCapabilities?.("video");
            if (caps?.codecs) {
                const h264 = caps.codecs.filter(c => c.mimeType === "video/H264");
                const rest = caps.codecs.filter(c => c.mimeType !== "video/H264");
                const tr = pc.getTransceivers().find(t => t.sender.track?.kind === "video");
                if (tr && h264.length) {
                    tr.setCodecPreferences([...h264, ...rest]);
                    vetLog("info", "watch peer: preferring H264");
                }
            }
        } catch (e) { vetLog("warn", "setCodecPreferences failed:", e.message); }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") return resolve();
            const check = () => {
                if (pc.iceGatheringState === "complete") {
                    pc.removeEventListener("icegatheringstatechange", check);
                    resolve();
                }
            };
            pc.addEventListener("icegatheringstatechange", check);
            setTimeout(resolve, 1500);
        });

        const desc = pc.localDescription;
        this._postJSON("/webrtc/offer", {
            offer: { type: desc.type, sdp: desc.sdp },
            candidates: []
        });
        vetLog("info", "watch peer: offer sent");

        let answer = null;
        for (let i = 0; i < 60; i++) {
            try {
                const r = await BdApi.Net.fetch(`${this.OVERLAY_URL}/webrtc/answer`, { cache: "no-store" });
                const data = await r.json();
                if (data?.answer) { answer = data.answer; break; }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 250));
        }
        if (!answer) {
            vetLog("warn", "watch peer: no answer from viewer");
            try { pc.close(); } catch (e) {}
            this._watchPeer = null;
            return false;
        }

        try {
            await pc.setRemoteDescription(answer);
            vetLog("info", "watch peer: answer applied");
        } catch (e) {
            vetLog("error", "setRemoteDescription failed:", e);
            try { pc.close(); } catch (er) {}
            this._watchPeer = null;
            return false;
        }

        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = 8_000_000;
                params.encodings[0].scaleResolutionDownBy = 1;
                params.encodings[0].degradationPreference = "maintain-resolution";
                params.encodings[0].networkPriority = "high";
                params.encodings[0].priority = "high";
                await sender.setParameters(params);
                statsTimer = setInterval(async () => {
                    if (pc.connectionState === "closed" || this._watchPeer !== pc) {
                        clearInterval(statsTimer); statsTimer = null; return;
                    }
                    try {
                        const stats = await pc.getStats();
                        stats.forEach(r => {
                            if (r.type === "outbound-rtp" && r.kind === "video") {
                                // Connected for 5 s and not one frame encoded: the
                                // source itself gives nothing. Remember it so the
                                // next watch of this user makes Discord rejoin.
                                if (!r.framesEncoded && pc.connectionState === "connected" &&
                                    Date.now() - pumpStartedAt > 5000 && pumpUserId &&
                                    !(this._frozenSource && this._frozenSource.userId === pumpUserId)) {
                                    this._frozenSource = { userId: pumpUserId, sid: pumpSid };
                                    vetLog("warn", "watch source frozen (0 frames encoded), sid", pumpSid);
                                }
                                const pktPerSec = r.packetsSent - (statsPrevPackets || r.packetsSent);
                                statsPrevPackets = r.packetsSent;
                                vetLog("info", "[sender]", {
                                    fps: r.framesPerSecond,
                                    bitrate: r.targetBitrate,
                                    dropped: r.framesDropped,
                                    encoded: r.framesEncoded,
                                    packetsSent: r.packetsSent,
                                    pktPerSec,
                                    pacerDelayMs: r.packetsSent ? Math.round((r.totalPacketSendDelay || 0) / r.packetsSent * 1000) : null,
                                    retransmits: r.retransmittedPacketsSent,
                                    nackCount: r.nackCount,
                                    res: `${r.frameWidth}x${r.frameHeight}`,
                                    limit: r.qualityLimitationReason,
                                    encoder: r.encoderImplementation,
                                    encMsPerFrame: r.framesEncoded ? Math.round(r.totalEncodeTime / r.framesEncoded * 1000) : null,
                                });
                            }
                        });
                    } catch (e) {}
                }, 1000);
                vetLog("info", "sender tuned:", JSON.stringify(params.encodings[0]));
            } else {
                vetLog("warn", "sender tuned: no video sender");
            }
        } catch (e) {
            vetLog("warn", "sender.setParameters failed:", e.message);
        }

        this._framePump = {
            stop: () => {
                if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
                try { pc.close(); } catch (e) {}
                this._watchPeer = null;
                this._framePump = null;
            }
        };

        vetLog("info", "watch peer started");
        return true;
    }

    // Confirmation dialog drawn inside the tracker window. Discord's own modal
    // opens below it (the tracker sits at the top z-index), so it can't be used.
    _vetConfirm(host, title, text, { confirmText = "OK", cancelText = "Cancel", danger = false, onConfirm } = {}) {
        const back = document.createElement("div");
        back.style.cssText = [
            "position:absolute", "inset:0", "z-index:10", "background:rgba(0,0,0,0.55)",
            "display:flex", "align-items:center", "justify-content:center"
        ].join(";") + ";";
        const box = document.createElement("div");
        box.style.cssText = [
            "background:#313338", "color:#dbdee1", "border-radius:8px", "width:min(440px,90vw)",
            "box-shadow:0 8px 24px rgba(0,0,0,0.5)", "font-family:inherit", "overflow:hidden"
        ].join(";") + ";";
        const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
        const btn = "border:none;border-radius:4px;padding:8px 16px;font-size:14px;font-weight:500;cursor:pointer;";
        box.innerHTML = `
            <div style="padding:16px 16px 8px;font-size:18px;font-weight:600;color:#f2f3f5;">${esc(title)}</div>
            <div style="padding:0 16px 20px;font-size:14px;line-height:1.4;">${esc(text)}</div>
            <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:#2b2d31;">
                <button data-r="cancel" style="${btn}background:transparent;color:#dbdee1;">${esc(cancelText)}</button>
                <button data-r="ok" style="${btn}background:${danger ? "#da373c" : "#5865f2"};color:#fff;">${esc(confirmText)}</button>
            </div>`;
        back.appendChild(box);
        const done = (ok) => {
            document.removeEventListener("keydown", onKey, true);
            back.remove();
            if (ok) { try { onConfirm?.(); } catch (e) { vetLog("error", "confirm action failed:", e); } }
        };
        // Capture phase so Escape/Enter don't reach the tracker (Escape closes it).
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(false); }
            else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); done(true); }
        };
        document.addEventListener("keydown", onKey, true);
        back.addEventListener("click", (e) => {
            e.stopPropagation();
            if (e.target === back) return done(false);
            const r = e.target.closest("[data-r]")?.getAttribute("data-r");
            if (r) done(r === "ok");
        });
        host.appendChild(back);
        box.querySelector("[data-r='ok']").focus();
    }

    // =====================================================================
    // Favorites, departures, return to channel
    // =====================================================================

    // Favorites live apart from encounter history, so clearing logs keeps them.
    // userId -> { sound: bool }
    _loadFavorites() {
        this._favorites = new Map();
        try {
            const raw = BdApi.Data.load(this.meta.name, "favorites");
            if (raw && typeof raw === "object") {
                for (const [id, v] of Object.entries(raw)) this._favorites.set(id, { sound: !!v?.sound });
            }
        } catch (e) {}
    }

    _saveFavorites() {
        try { BdApi.Data.save(this.meta.name, "favorites", Object.fromEntries(this._favorites)); } catch (e) {}
    }

    setFavorite(userId, on) {
        userId = String(userId);
        if (on) this._favorites.set(userId, { sound: this._favorites.get(userId)?.sound ?? true });
        else this._favorites.delete(userId);
        this._saveFavorites();
        this.scheduleOverlayPush();
    }

    setFavoriteSound(userId, on) {
        userId = String(userId);
        if (!this._favorites.has(userId)) return;
        this._favorites.set(userId, { sound: !!on });
        this._saveFavorites();
        this.scheduleOverlayPush();
    }

    _voiceStore() {
        return this._sc?.VoiceStateStore ?? BdApi.Webpack.getStore("VoiceStateStore");
    }

    // Members of a voice channel for a small avatar row: [{userId, name, avatar}]
    _channelMembers(channelId, guildId, limit = 8) {
        const out = [];
        try {
            const states = this._voiceStore()?.getVoiceStatesForChannel?.(channelId) || {};
            const us = this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore");
            for (const id of Object.keys(states)) {
                const u = us?.getUser?.(id);
                out.push({ userId: id, name: this.getDisplayName(id, guildId) || u?.username || id, avatar: u?.avatar ?? null });
            }
        } catch (e) {}
        return { count: out.length, members: out.slice(0, limit) };
    }

    // Someone left my channel for another channel of the same server.
    _noteDeparture(vs) {
        const me = this.getCurrentUserId();
        const uid = vs?.userId != null ? String(vs.userId) : null;
        if (!me || !uid || uid === me) return;
        const mine = this.active.get(me);
        const prev = this.active.get(uid);
        if (!mine || !prev || prev.channelId !== mine.channelId) return;
        const to = vs.channelId ? String(vs.channelId) : null;
        if (to && to !== mine.channelId && mine.guildId && this.getChannelGuildId(to) === mine.guildId) {
            this._departures.set(uid, { channelId: to, at: Date.now() });
            this._addTimer(setTimeout(() => this.scheduleOverlayPush(), this.DEPARTURE_SHOW_MS + 100));
        }
    }

    _departureCards(mySession) {
        const cards = [];
        if (!this._departures?.size) return cards;
        const now = Date.now();
        const us = this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore");
        for (const [uid, d] of [...this._departures]) {
            const cur = this._voiceStore()?.getVoiceStateForUser?.(uid)?.channelId ?? null;
            // Expired, came back, went elsewhere or left voice: drop the card.
            if (now - d.at > this.DEPARTURE_SHOW_MS || !cur || String(cur) !== d.channelId || d.channelId === mySession.channelId) {
                this._departures.delete(uid);
                continue;
            }
            const u = us?.getUser?.(uid);
            cards.push({
                userId: uid,
                name: this.getDisplayName(uid, mySession.guildId) || u?.username || uid,
                avatar: u?.avatar ?? null,
                channelId: d.channelId,
                channelName: this.getChannelName(d.channelId),
                at: d.at,
                ...this._channelMembers(d.channelId, mySession.guildId)
            });
        }
        return cards.sort((a, b) => b.at - a.at).slice(0, 3);
    }

    _loadLastVoice() {
        try { return BdApi.Data.load(this.meta.name, "lastVoice") || null; } catch (e) { return null; }
    }

    _saveLastVoice(v) {
        try { BdApi.Data.save(this.meta.name, "lastVoice", v); } catch (e) {}
    }

    // While in voice, keep the last channel (and a fresh "seen" time, at most
    // once a minute) so a restart knows where we were.
    _rememberOwnChannel() {
        const me = this.getCurrentUserId();
        const mine = me ? this.active.get(me) : null;
        if (!mine?.channelId) return;
        const lv = this._loadLastVoice();
        const now = Date.now();
        if (lv && lv.channelId === mine.channelId && !lv.selfLeft && now - (lv.seenAt || 0) < 60000) return;
        this._saveLastVoice({ channelId: mine.channelId, guildId: mine.guildId ?? null, seenAt: now, selfLeft: false });
    }

    _onOwnChannelSelect(action) {
        if (action.channelId) {
            this._saveLastVoice({ channelId: String(action.channelId), guildId: action.guildId ?? null, seenAt: Date.now(), selfLeft: false });
            this._returnTo = null;
        } else {
            const lv = this._loadLastVoice();
            if (lv) this._saveLastVoice({ ...lv, selfLeft: true });
            this._returnTo = null;
        }
        this.scheduleOverlayPush();
    }

    _checkReturnToChannel() {
        const inVoice = this._voiceStore()?.getVoiceChannelId?.();
        if (inVoice) return;
        const lv = this._loadLastVoice();
        if (!lv || lv.selfLeft || !lv.channelId) return;
        if (Date.now() - (lv.seenAt || 0) > this.RETURN_MAX_AGE_MS) return;
        if (!this.getChannelName(lv.channelId)) return;   // channel gone or no access
        this._returnTo = { channelId: lv.channelId, guildId: lv.guildId ?? null };
        vetLog("info", "return-to-channel offered:", lv.channelId);
        this.scheduleOverlayPush();
    }

    _returnCard() {
        if (!this._returnTo) return null;
        const { channelId, guildId } = this._returnTo;
        return {
            channelId,
            channelName: this.getChannelName(channelId),
            guildName: this.getGuildName(guildId, channelId),
            ...this._channelMembers(channelId, guildId)
        };
    }

    _selectVoiceChannel(channelId) {
        try {
            const actions = BdApi.Webpack.getByKeys("selectVoiceChannel", { searchExports: true });
            if (!actions?.selectVoiceChannel) { vetLog("warn", "selectVoiceChannel not found"); return; }
            if (channelId == null && typeof actions.disconnect === "function") actions.disconnect();
            else actions.selectVoiceChannel(channelId);
            vetLog("info", channelId ? "joined channel " + channelId : "left voice");
        } catch (e) { vetLog("error", "_selectVoiceChannel:", e); }
    }

    // =====================================================================
    // Messages: unread DM badge, notifications for the overlay
    // =====================================================================

    _dmChannelId(userId) {
        try {
            const cs = this._sc?.ChannelStore ?? BdApi.Webpack.getStore("ChannelStore");
            return cs?.getDMFromUserId?.(String(userId)) ?? null;
        } catch (e) { return null; }
    }

    // Unread messages in my DM with this user (in a DM every message counts
    // as a mention, so the mention count is the unread count).
    _unreadDMCount(userId) {
        try {
            const cid = this._dmChannelId(userId);
            if (!cid) return 0;
            const rs = this._sc?.ReadStateStore ?? BdApi.Webpack.getStore("ReadStateStore");
            return Number(rs?.getMentionCount?.(cid)) || 0;
        } catch (e) { return 0; }
    }

    _isDMChannel(ch) {
        return !!ch && !ch.guild_id && (ch.type === 1 || ch.type === 3);
    }

    _onMessageCreate(action) {
        const msg = action?.message;
        if (!msg || action.optimistic) return;
        const me = this.getCurrentUserId();
        const authorId = msg.author?.id != null ? String(msg.author.id) : null;
        if (!me || !authorId || authorId === me) return;
        const ch = this._getChannel(msg.channel_id);
        const isDM = this._isDMChannel(ch);
        const mentioned = Array.isArray(msg.mentions) && msg.mentions.some(m => String(m?.id ?? m) === me);
        if (!isDM && !mentioned) return;

        const rel = this._sc?.RelationshipStore ?? BdApi.Webpack.getStore("RelationshipStore");
        try { if (rel?.isBlocked?.(authorId)) return; } catch (e) {}

        // Badges change whenever a DM arrives.
        this.scheduleOverlayPush();

        // Already reading this chat in a focused Discord: no popup.
        try {
            const sel = (this._sc?.SelectedChannelStore ?? BdApi.Webpack.getStore("SelectedChannelStore"))?.getChannelId?.();
            if (document.hasFocus() && sel === msg.channel_id) return;
        } catch (e) {}

        let text = String(msg.content || "").replace(/<@!?(\d+)>/g, (_, id) => "@" + (this.getDisplayName(id, ch?.guild_id ?? null) || "user"))
            .replace(/<#(\d+)>/g, (_, id) => "#" + (this.getChannelName(id) || "channel"))
            .replace(/<a?:(\w+):\d+>/g, ":$1:")
            .replace(/\s+/g, " ").trim();
        if (!text && msg.attachments?.length) text = "Attachment: " + (msg.attachments[0]?.filename || "file");
        if (!text && msg.embeds?.length) text = "Link";
        if (!text && msg.sticker_items?.length) text = "Sticker";
        if (text.length > 160) text = text.slice(0, 157) + "…";

        const where = isDM
            ? (ch?.type === 3 ? (this.getChannelName(msg.channel_id) || "Group") : null)
            : "#" + (this.getChannelName(msg.channel_id) || "channel") +
              (ch?.guild_id ? " · " + (this.getGuildName(ch.guild_id, msg.channel_id) || "") : "");

        this._postJSON("/notify", {
            id: String(msg.id),
            kind: isDM ? "dm" : "mention",
            authorId,
            name: this.getDisplayName(authorId, ch?.guild_id ?? null) || msg.author?.global_name || msg.author?.username || "user",
            avatar: msg.author?.avatar ?? null,
            channelId: String(msg.channel_id),
            guildId: ch?.guild_id ?? null,
            where,
            text,
            at: Date.now()
        });
    }

    // Read in Discord: drop its popups and refresh badges.
    _onMessageAck(action) {
        const ids = action.type === "BULK_ACK"
            ? (action.channels || []).map(c => c?.channelId ?? c?.channel_id).filter(Boolean)
            : [action.channelId ?? action.channel_id].filter(Boolean);
        if (ids.length) this._postJSON("/notify/clear", { channelIds: ids.map(String) });
        this.scheduleOverlayPush();
    }

    _openChannel(channelId, guildId) {
        try {
            const ch = this._getChannel(channelId);
            const g = ch?.guild_id ?? guildId ?? "@me";
            const go = this._transitionTo();
            if (go) go(`/channels/${g}/${channelId}`);
            else vetLog("warn", "transitionTo not found");
            try { window.DiscordNative?.window?.focus?.(); } catch (e) {}
            try { window.focus(); } catch (e) {}
        } catch (e) { vetLog("error", "_openChannel:", e); }
    }

    // =====================================================================
    // Person card: activity, mobile, volume, quick actions
    // =====================================================================

    // What the person is doing: a small icon on the card, details in a tooltip.
    // { type, platform, name, details, state, icon, image, imageText, start, end, canListen }
    //   platform: "spotify" | "soundcloud" | "youtube" | "apple" | "music" | null
    //   icon:  small app icon (games), image: big picture (album art / game art)
    _activityFor(userId) {
        try {
            const ps = this._sc?.PresenceStore ?? BdApi.Webpack.getStore("PresenceStore");
            const acts = ps?.getActivities?.(String(userId)) || [];
            if (!acts.length) return null;
            const pick = acts.find(a => a.type === 0) || acts.find(a => a.type === 2) ||
                         acts.find(a => a.type === 3) || acts.find(a => a.type === 1) ||
                         acts.find(a => a.type === 4);
            if (!pick) return null;
            const asset = (img, appId) => {
                if (!img) return null;
                if (img.startsWith("spotify:")) return "https://i.scdn.co/image/" + img.slice(8);
                if (img.startsWith("mp:")) return "https://media.discordapp.net/" + img.slice(3);
                if (/^https?:/.test(img)) return img;
                if (appId && /^\d+$/.test(img)) return `https://cdn.discordapp.com/app-assets/${appId}/${img}.png`;
                return null;
            };
            const appIcon = (appId) => {
                try {
                    const app = (this._sc?.ApplicationStore ?? BdApi.Webpack.getStore("ApplicationStore"))?.getApplication?.(appId);
                    if (app?.icon) return `https://cdn.discordapp.com/app-icons/${appId}/${app.icon}.png?size=64`;
                } catch (e) {}
                return null;
            };
            if (pick.type === 4) {
                const text = pick.state || "";
                if (!text && !pick.emoji) return null;
                return { type: "custom", name: (pick.emoji?.name ? pick.emoji.name + " " : "") + text };
            }
            const n = String(pick.name || "").toLowerCase();
            const isSpotify = n === "spotify" || String(pick.id || "").startsWith("spotify");
            const platform = isSpotify ? "spotify"
                : n.includes("soundcloud") ? "soundcloud"
                : n.includes("youtube music") || n === "youtube" ? "youtube"
                : n.includes("apple music") ? "apple"
                : pick.type === 2 ? "music" : null;
            return {
                type: pick.type === 0 ? "game" : pick.type === 2 ? "listening"
                    : pick.type === 3 ? "watching" : "streaming",
                platform,
                name: pick.name || "",
                details: pick.details || null,
                state: pick.state || null,
                icon: pick.application_id ? appIcon(pick.application_id) : null,
                image: asset(pick.assets?.large_image, pick.application_id) || asset(pick.assets?.small_image, pick.application_id),
                imageText: pick.assets?.large_text || null,
                start: pick.timestamps?.start ? Number(pick.timestamps.start) : null,
                end: pick.timestamps?.end ? Number(pick.timestamps.end) : null,
                canListen: isSpotify && !!pick.sync_id
            };
        } catch (e) { return null; }
    }

    _isOnMobile(userId) {
        try {
            const ps = this._sc?.PresenceStore ?? BdApi.Webpack.getStore("PresenceStore");
            if (typeof ps?.isMobileOnline === "function") return !!ps.isMobileOnline(String(userId));
            const cs = ps?.getState?.()?.clientStatuses?.[String(userId)];
            return !!cs && !!cs.mobile && !cs.desktop && !cs.web;
        } catch (e) { return false; }
    }

    // Discord stores user volume as an amplitude, while its slider shows a
    // perceptual scale (50 on the slider is ~25 amplitude). Use Discord's own
    // converters when they're there; otherwise the same dB curve.
    _volConv() {
        if (this._volConvMod !== undefined) return this._volConvMod;
        try { this._volConvMod = BdApi.Webpack.getByKeys("amplitudeToPerceptual", "perceptualToAmplitude", { searchExports: true }) || null; }
        catch (e) { this._volConvMod = null; }
        return this._volConvMod;
    }
    _toPerceptual(a) {
        const m = this._volConv();
        if (m) { try { return m.amplitudeToPerceptual(a); } catch (e) {} }
        if (!(a > 0)) return 0;
        const db = 20 * Math.log10(a / 100);                // 0 dB at 100
        return a <= 100 ? Math.max(0, 100 + db * 10 / 3) : 100 + db / 6 * 100;   // -30 dB floor
    }
    _toAmplitude(p) {
        const m = this._volConv();
        if (m) { try { return m.perceptualToAmplitude(p); } catch (e) {} }
        if (!(p > 0)) return 0;
        const db = p <= 100 ? (p - 100) * 0.3 : (p - 100) / 100 * 6;
        return 100 * Math.pow(10, db / 20);
    }

    // 0..200 on Discord's slider scale (100 = default)
    _localVolume(userId) {
        try {
            const mes = this._sc?.MediaEngineStore ?? BdApi.Webpack.getStore("MediaEngineStore");
            const v = mes?.getLocalVolume?.(String(userId));
            return Number.isFinite(v) ? Math.round(this._toPerceptual(v)) : 100;
        } catch (e) { return 100; }
    }

    _setLocalVolume(userId, v) {
        if (!Number.isFinite(v)) return;
        v = this._toAmplitude(Math.max(0, Math.min(200, v)));
        try {
            const mod = BdApi.Webpack.getByKeys("setLocalVolume", { searchExports: true });
            if (typeof mod?.setLocalVolume !== "function") { vetLog("warn", "setLocalVolume not found"); return; }
            mod.setLocalVolume(String(userId), v);
            this.scheduleOverlayPush();
        } catch (e) { vetLog("error", "_setLocalVolume:", e); }
    }

    _focusDiscord() {
        try { window.DiscordNative?.window?.focus?.(); } catch (e) {}
        try { window.focus(); } catch (e) {}
    }

    // Discord's router function. It isn't exported under a stable name, so find
    // it by the line it logs.
    _transitionTo() {
        if (this._navFn) return this._navFn;
        try {
            let fn = BdApi.Webpack.getByStrings("transitionTo - Transitioning to", { searchExports: true });
            if (typeof fn !== "function") {
                const mod = BdApi.Webpack.getByKeys("transitionTo", { searchExports: true });
                fn = typeof mod?.transitionTo === "function" ? mod.transitionTo.bind(mod) : null;
            }
            this._navFn = typeof fn === "function" ? fn : null;
        } catch (e) { this._navFn = null; }
        return this._navFn;
    }

    // Same as Discord's own "Message" button: opens (or creates) the DM.
    _openDM(userId) {
        try {
            const mod = BdApi.Webpack.getByKeys("openPrivateChannel", { searchExports: true });
            if (typeof mod?.openPrivateChannel === "function") {
                mod.openPrivateChannel(String(userId));
            } else {
                const cid = this._dmChannelId(userId);
                if (cid) { this._openChannel(cid, "@me"); return; }
                vetLog("warn", "openPrivateChannel not found");
            }
            this._focusDiscord();
        } catch (e) { vetLog("error", "_openDM:", e); }
    }

    _openProfile(userId) {
        try {
            const me = this.getCurrentUserId();
            const guildId = me ? (this.active.get(me)?.guildId ?? null) : null;
            const mod = BdApi.Webpack.getByKeys("openUserProfileModal", { searchExports: true });
            if (typeof mod?.openUserProfileModal === "function") {
                mod.openUserProfileModal({ userId: String(userId), guildId, analyticsLocation: {} });
            } else vetLog("warn", "openUserProfileModal not found");
            this._focusDiscord();
        } catch (e) { vetLog("error", "_openProfile:", e); }
    }

    // Spotify "Listen Along". Needs Spotify connected; Discord shows its own
    // prompt if something is missing.
    _listenAlong(userId) {
        try {
            const ps = this._sc?.PresenceStore ?? BdApi.Webpack.getStore("PresenceStore");
            const act = (ps?.getActivities?.(String(userId)) || []).find(a => a.type === 2 && a.sync_id);
            if (!act) { vetLog("warn", "listen-along: no Spotify activity"); return; }
            const mod = BdApi.Webpack.getByKeys("sync", "play", { searchExports: true })
                     || BdApi.Webpack.getByKeys("sync", { searchExports: true });
            if (typeof mod?.sync === "function") { mod.sync(act, String(userId)); vetLog("info", "listen-along started"); }
            else vetLog("warn", "Spotify sync not found");
        } catch (e) { vetLog("error", "_listenAlong:", e); }
    }

    // =====================================================================
    // Incoming calls (DM / group): accept, decline, answer with a message
    // =====================================================================

    _onCall(action) {
        const me = this.getCurrentUserId();
        const cid = action.channelId != null ? String(action.channelId) : null;
        if (!me || !cid) return;
        if (action.type === "CALL_DELETE") { this._clearCall(cid); return; }
        const ringing = (action.ringing || []).map(String);
        const inThisCall = this._voiceStore()?.getVoiceChannelId?.() === cid;
        if (!ringing.includes(me) || inThisCall) { this._clearCall(cid); return; }
        if (this._ringingCall === cid) return;
        this._ringingCall = cid;

        const ch = this._getChannel(cid);
        const others = (Array.isArray(ch?.recipients) ? ch.recipients : [])
            .map(x => String(typeof x === "string" ? x : x?.id)).filter(id => id && id !== me);
        // The caller is whoever is already in the call; else the DM partner.
        let callerId = null;
        try {
            const states = this._voiceStore()?.getVoiceStatesForChannel?.(cid) || {};
            callerId = Object.keys(states).find(id => id !== me) || null;
        } catch (e) {}
        callerId = callerId || others[0] || null;
        const us = this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore");
        const u = callerId ? us?.getUser?.(callerId) : null;
        this._postJSON("/call", {
            channelId: cid,
            callerId,
            name: callerId ? (this.getDisplayName(callerId, null) || u?.username || "Someone") : "Someone",
            avatar: u?.avatar ?? null,
            group: ch?.type === 3 ? (this.getChannelName(cid) || "Group call") : null
        });
        vetLog("info", "incoming call in", cid, "from", callerId);
    }

    _clearCall(cid) {
        if (this._ringingCall !== cid) return;
        this._ringingCall = null;
        this._postJSON("/call/clear", { channelId: cid });
    }

    _declineCall(cid) {
        try {
            const mod = BdApi.Webpack.getByKeys("stopRinging", { searchExports: true });
            if (typeof mod?.stopRinging === "function") mod.stopRinging(cid);
            else vetLog("warn", "stopRinging not found");
        } catch (e) { vetLog("error", "_declineCall:", e); }
        this._clearCall(cid);
    }

    _sendMessage(channelId, text) {
        text = String(text || "").trim();
        if (!text) return;
        try {
            const mod = BdApi.Webpack.getByKeys("sendMessage", "editMessage", { searchExports: true });
            if (typeof mod?.sendMessage !== "function") { vetLog("warn", "sendMessage not found"); return; }
            mod.sendMessage(channelId, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, {});
            vetLog("info", "message sent to", channelId);
        } catch (e) { vetLog("error", "_sendMessage:", e); }
    }

    // =====================================================================
    // My own stream: who watches it, and a heads-up about unexpected viewers
    // =====================================================================

    _myStreamViewers(mySession) {
        try {
            const ass = BdApi.Webpack.getStore("ApplicationStreamingStore");
            const me = this.getCurrentUserId();
            const st = ass?.getCurrentUserActiveStream?.() || ass?.getActiveStreamForUser?.(me, mySession?.guildId);
            if (!st) { this._knownViewers = null; this._viewerSince = null; this._streamStartedAt = 0; return []; }
            let ids = [];
            try { ids = ass.getViewerIds?.(st) || []; } catch (e) {}
            if (!ids.length) { try { ids = ass.getViewerIds?.(st.streamKey || this._streamKeyOf(st)) || []; } catch (e) {} }
            ids = ids.map(String).filter(id => id !== me);
            const us = this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore");
            const now = Date.now();
            this._knownViewers ||= new Set();
            this._viewerSince ||= new Map();      // userId -> when I first saw them watching
            this._streamStartedAt ||= now;
            const out = ids.map(id => {
                const u = us?.getUser?.(id);
                // Unexpected viewer: came into the channel while my stream was
                // already running and opened it within a few minutes of coming in.
                // People who were there before the stream, or sat in the channel a
                // while first, are not.
                if (!this._viewerSince.has(id)) this._viewerSince.set(id, now);
                const watchFrom = this._viewerSince.get(id);
                const sess = this.active.get(id);
                const joinedAt = sess && sess.channelId === mySession?.channelId ? (sess.startedAt || 0) : 0;
                const stranger = !this._favorites?.has(id) && joinedAt > this._streamStartedAt &&
                    watchFrom - joinedAt < this.STRANGER_VIEWER_MS;
                return { userId: id, name: this.getDisplayName(id, mySession?.guildId) || u?.username || id, avatar: u?.avatar ?? null, stranger };
            });
            // Warn once per viewer when someone unexpected starts watching after
            // the stream has been running for a while (an established audience).
            for (const v of out) {
                if (this._knownViewers.has(v.userId)) continue;
                this._knownViewers.add(v.userId);
                if (v.stranger && now - this._streamStartedAt > 60_000) {
                    this._postJSON("/notify", {
                        id: "viewer-" + v.userId + "-" + now, kind: "mention",
                        authorId: v.userId, name: v.name, avatar: v.avatar,
                        channelId: "viewer-" + v.userId, guildId: null,
                        where: "your stream", text: "started watching your stream", at: now
                    });
                }
            }
            return out;
        } catch (e) { return []; }
    }

    _streamKeyOf(st) {
        if (!st) return null;
        return st.guildId ? `guild:${st.guildId}:${st.channelId}:${st.ownerId}` : `call:${st.channelId}:${st.ownerId}`;
    }

    // Which window/screen I'm streaming, as the overlay's source id (for a preview).
    _myStreamSourceId() {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const id = mes?.getGoLiveSource?.()?.desktopSource?.id;
            if (!id) return null;
            const m = /^window-handle:(\d+)/.exec(id);
            if (m) return `window:${m[1]}:0`;
            const sm = /^screen-handle:(\d+)/.exec(id);
            if (sm) return "screen-handle:" + sm[1];
            return String(id);
        } catch (e) { return null; }
    }

    // A camera goes through the same viewer window as streams. Discord only
    // receives someone's camera while its call view subscribes to it.
    async _watchCamera(userId) {
        try {
            const vss = BdApi.Webpack.getStore("VideoStreamStore");
            const sid = vss?.getStreamId?.(userId, "video") ?? vss?.getStreamId?.(userId);
            const nz = this._findNzFunction();
            const handle = sid && typeof nz === "function" ? nz(String(sid)) : null;
            const t = handle?.stream?.getVideoTracks?.()[0];
            if (!t) {
                vetLog("warn", "watch-camera: no camera track for", userId, "sid", sid);
                BdApi.UI.showToast("Camera isn't loaded in Discord — open the call view once", { type: "warning" });
                try { handle?.release?.(); } catch (e) {}
                return;
            }
            this._watchToken = (this._watchToken || 0) + 1;
            const run = async () => {
                this._stopFramePump();
                this._postJSON("/video/open", { userId, camera: true });
                this._nativeStreamHandle = handle;
                this._sourceSid = String(sid);
                this._watchedUserId = userId;
                await this._startWatchStreamPeer(new MediaStream([t]));
            };
            this._watchChain = (this._watchChain || Promise.resolve()).then(run, run);
        } catch (e) { vetLog("error", "_watchCamera:", e); }
    }

    // =====================================================================
    // Tracker: who was there, together, invites
    // =====================================================================

    // Everyone whose sessions with me overlap [from, to] (a single moment when
    // from == to). One row per person: total overlap, first..last overlapping
    // time, and the session to jump to.
    whoWasThere(from, to) {
        const out = [];
        for (const rec of this.encounters.values()) {
            let overlap = 0, first = Infinity, last = 0, best = null;
            (rec.sessions || []).forEach((sn, idx) => {
                const a = Math.max(sn.startedAt, from), b = Math.min(sn.endedAt, to);
                if (b < a || (b === a && !(sn.startedAt <= from && sn.endedAt >= to))) return;
                overlap += b - a;
                first = Math.min(first, a); last = Math.max(last, b);
                if (!best || b - a > best.len) best = { len: b - a, idx, sn };
            });
            if (!best) continue;
            out.push({
                userId: rec.userId, overlapMs: overlap, start: first, end: last, idx: best.idx,
                channelName: best.sn.channelName, guildName: best.sn.guildName
            });
        }
        return out.sort((a, b) => b.overlapMs - a.overlapMs || a.start - b.start);
    }

    // Stretches of time when ALL of these people were in voice with me.
    togetherSpans(userIds, from = null, to = null) {
        const lists = userIds.map(id => {
            const rec = this.encounters.get(id);
            return (rec?.sessions || []).map((sn, idx) => ({ a: sn.startedAt, b: sn.endedAt, idx, sn, userId: id }))
                .filter(x => x.b > x.a).sort((x, y) => x.a - y.a);
        });
        if (lists.some(l => !l.length)) return [];
        let cur = lists[0].map(x => ({ start: x.a, end: x.b, ref: x }));
        for (const l of lists.slice(1)) {
            const next = [];
            let i = 0, j = 0;
            while (i < cur.length && j < l.length) {
                const a = Math.max(cur[i].start, l[j].a), b = Math.min(cur[i].end, l[j].b);
                if (b > a) next.push({ start: a, end: b, ref: cur[i].ref });
                if (cur[i].end < l[j].b) i++; else j++;
            }
            cur = next;
            if (!cur.length) return [];
        }
        if (from != null && to != null) {
            cur = cur.map(x => ({ ...x, start: Math.max(x.start, from), end: Math.min(x.end, to) })).filter(x => x.end > x.start);
        }
        return cur.sort((x, y) => y.start - x.start).map(x => ({
            start: x.start, end: x.end, userId: x.ref.userId, idx: x.ref.idx,
            channelName: x.ref.sn.channelName, guildName: x.ref.sn.guildName
        }));
    }

    _inviteDialog(host, userId) {
        const me = this.getCurrentUserId();
        const mine = me ? this.active.get(me) : null;
        if (!mine?.channelId || !mine.guildId) {
            BdApi.UI.showToast("Join a server voice channel first", { type: "warning" });
            return;
        }
        const channelName = this.getChannelName(mine.channelId) || "voice";
        const link = `https://discord.com/channels/${mine.guildId}/${mine.channelId}`;
        const name = this.getStoredDisplayName(userId) || this.getUserName(userId);
        const back = document.createElement("div");
        back.style.cssText = "position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
        const btn = "border:none;border-radius:4px;padding:8px 14px;font-size:14px;font-weight:500;cursor:pointer;color:#fff;";
        back.innerHTML = `<div style="background:#313338;color:#dbdee1;border-radius:8px;width:min(460px,90vw);box-shadow:0 8px 24px rgba(0,0,0,.5);overflow:hidden">
            <div style="padding:16px 16px 6px;font-size:18px;font-weight:600;color:#f2f3f5">Invite ${this._escape(name)} to #${this._escape(channelName)}</div>
            <div style="padding:0 16px 16px;font-size:13px;line-height:1.45;opacity:.85">
                <b>Server invite</b> — a real Discord invite (works even if they aren't on the server; some servers don't allow creating invites).<br>
                <b>Channel link</b> — opens the channel; works only for members of the server.</div>
            <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:#2b2d31">
                <button data-r="cancel" style="${btn}background:transparent;color:#dbdee1">Cancel</button>
                <button data-r="link" style="${btn}background:#4e5058">Send channel link</button>
                <button data-r="invite" style="${btn}background:#5865f2">Send server invite</button>
            </div></div>`;
        const done = () => { document.removeEventListener("keydown", onKey, true); back.remove(); };
        const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); done(); } };
        document.addEventListener("keydown", onKey, true);
        back.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (e.target === back) return done();
            const r = e.target.closest("[data-r]")?.getAttribute("data-r");
            if (!r) return;
            done();
            if (r === "cancel") return;
            let text = link;
            if (r === "invite") {
                const code = await this._createInvite(mine.channelId);
                if (code) text = `https://discord.gg/${code}`;
                else BdApi.UI.showToast("Couldn't create an invite here — sending the channel link instead", { type: "warning" });
            }
            const ok = await this._sendDM(userId, text);
            BdApi.UI.showToast(ok ? `Sent to ${name}` : "Couldn't open a DM", { type: ok ? "success" : "error" });
        });
        host.appendChild(back);
    }

    async _createInvite(channelId) {
        try {
            const mod = BdApi.Webpack.getByKeys("createInvite", { searchExports: true });
            if (typeof mod?.createInvite !== "function") { vetLog("warn", "createInvite not found"); return null; }
            const inv = await mod.createInvite(channelId, { max_age: 86400, max_uses: 0, temporary: false }, "Voice Encounter Tracker");
            return inv?.code || null;
        } catch (e) { vetLog("warn", "createInvite failed:", e?.message || e); return null; }
    }

    async _sendDM(userId, text) {
        try {
            let cid = this._dmChannelId(userId);
            if (!cid) {
                const mod = BdApi.Webpack.getByKeys("getOrEnsurePrivateChannel", { searchExports: true })
                         || BdApi.Webpack.getByKeys("ensurePrivateChannel", { searchExports: true });
                const fn = mod?.getOrEnsurePrivateChannel || mod?.ensurePrivateChannel;
                if (typeof fn === "function") cid = await fn.call(mod, String(userId));
            }
            if (!cid) return false;
            this._sendMessage(String(cid), text);
            return true;
        } catch (e) { vetLog("error", "_sendDM:", e); return false; }
    }

    // A short heads-up when the microphone or output device changes (plugged
    // in a headset, Windows switched the default, ...). The first look only
    // records the current devices.
    _checkAudioDevices() {
        const mes = this._sc?.MediaEngineStore ?? BdApi.Webpack.getStore("MediaEngineStore");
        if (!mes) return;
        const name = (list, id) => {
            try {
                const all = Object.values(list || {});
                const d = all.find(x => x?.id === id) || (id === "default" ? all.find(x => x?.id === "default") : null);
                return d?.name || (id === "default" ? "System default" : id || "—");
            } catch (e) { return id || "—"; }
        };
        const cur = {
            input: mes.getInputDeviceId?.() ?? null,
            output: mes.getOutputDeviceId?.() ?? null,
            inputs: mes.getInputDevices?.(), outputs: mes.getOutputDevices?.()
        };
        const sig = (o) => `${o.input}|${o.output}|${name(o.inputs, o.input)}|${name(o.outputs, o.output)}`;
        const prev = this._audioDevices;
        this._audioDevices = cur;
        if (!prev || sig(prev) === sig(cur)) return;
        const devices = [];
        if (prev.input !== cur.input || name(prev.inputs, prev.input) !== name(cur.inputs, cur.input)) devices.push({ kind: "input", name: name(cur.inputs, cur.input) });
        if (prev.output !== cur.output || name(prev.outputs, prev.output) !== name(cur.outputs, cur.output)) devices.push({ kind: "output", name: name(cur.outputs, cur.output) });
        if (!devices.length) return;
        vetLog("info", "audio device changed:", devices.map(d => d.kind + "=" + d.name).join(", "));
        this._postJSON("/notify", {
            id: "device-" + Date.now(), kind: "device", authorId: "", name: "Audio device changed",
            avatar: null, channelId: "device", guildId: null, where: null,
            text: "", devices, ttlMs: 30000, at: Date.now()
        });
    }

    // =====================================================================
    // Own voice time + a short stats card after leaving voice
    // =====================================================================

    // My own voice sessions (for "today"), kept for 14 days.
    _loadMyVoice() {
        try {
            const v = BdApi.Data.load(this.meta.name, "myVoice");
            return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
    }

    _trackOwnSession() {
        const me = this.getCurrentUserId();
        const mine = me ? this.active.get(me) : null;
        const now = Date.now();
        if (mine?.channelId) {
            if (!this._mySess || this._mySess.channelId !== mine.channelId) {
                if (this._mySess) this._endOwnSession(now, false);   // moved: one session per channel
                this._mySess = {
                    start: mine.startedAt || now, channelId: mine.channelId, guildId: mine.guildId ?? null,
                    channelName: this.getChannelName(mine.channelId), guildName: this.getGuildName(mine.guildId, mine.channelId)
                };
            }
            return;
        }
        if (this._mySess) this._endOwnSession(now, true);
    }

    _endOwnSession(end, left) {
        const sess = this._mySess;
        this._mySess = null;
        if (!sess || end - sess.start < 5000) return;
        // My own voice log (with or without anyone else there), kept for a year.
        const list = this._loadMyVoice().filter(x => x.end > end - 365 * 86400_000);
        list.push({
            start: sess.start, end, channelId: sess.channelId, guildId: sess.guildId,
            channelName: sess.channelName || this.getChannelName(sess.channelId),
            guildName: sess.guildName || this.getGuildName(sess.guildId, sess.channelId)
        });
        try { BdApi.Data.save(this.meta.name, "myVoice", list); } catch (e) {}
        if (!left) return;
        // People's sessions are written when I leave; read them a moment later.
        this._addTimer(setTimeout(() => {
            try {
                this._leaveStats = this._buildLeaveStats(sess.start, end, list);
                this.pushStateToOverlay();
                this._addTimer(setTimeout(() => this.scheduleOverlayPush(), this.LEAVE_STATS_MS + 200));
            } catch (e) { vetLog("warn", "leave stats:", e); }
        }, 800));
    }

    // "Today" starts after the last pause in voice of DAY_GAP_MS or more.
    _dayStart(list, now) {
        const xs = list.slice().sort((a, b) => b.start - a.start);
        let start = now, prevStart = now;
        for (const x of xs) {
            if (prevStart - x.end >= this.DAY_GAP_MS) break;
            start = Math.min(start, x.start);
            prevStart = Math.min(prevStart, x.start);
        }
        return start;
    }

    _topPeople(from, to, n = 3) {
        const out = [];
        const us = this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore");
        for (const rec of this.encounters.values()) {
            let ms = 0;
            for (const sn of rec.sessions || []) {
                const a = Math.max(sn.startedAt, from), b = Math.min(sn.endedAt, to);
                if (b > a) ms += b - a;
            }
            if (ms < 60_000) continue;
            const u = us?.getUser?.(rec.userId);
            out.push({ userId: rec.userId, name: this.getStoredDisplayName(rec.userId) || this.getUserName(rec.userId), avatar: u?.avatar ?? null, ms });
        }
        return out.sort((a, b) => b.ms - a.ms).slice(0, n);
    }

    _buildLeaveStats(start, end, list) {
        const dayFrom = this._dayStart(list, end);
        const todayMs = list.filter(x => x.end > dayFrom).reduce((a, x) => a + (x.end - Math.max(x.start, dayFrom)), 0);
        // People: anyone in the top of the session or of today, with both numbers.
        const sess = this._topPeople(start, end, 5);
        const today = this._topPeople(dayFrom, end, 5);
        const byId = new Map();
        for (const p of today) byId.set(p.userId, { ...p, sessionMs: 0, todayMs: p.ms });
        for (const p of sess) {
            const cur = byId.get(p.userId) || { ...p, sessionMs: 0, todayMs: this._topPeopleFor(p.userId, dayFrom, end) };
            cur.sessionMs = p.ms;
            byId.set(p.userId, cur);
        }
        const people = [...byId.values()]
            .sort((a, b) => b.sessionMs - a.sessionMs || b.todayMs - a.todayMs)
            .slice(0, 5)
            .map(({ userId, name, avatar, sessionMs, todayMs }) => ({ userId, name, avatar, sessionMs, todayMs }));
        return { until: Date.now() + this.LEAVE_STATS_MS, sessionMs: end - start, todayMs, people };
    }

    _topPeopleFor(userId, from, to) {
        let ms = 0;
        for (const sn of this.encounters.get(userId)?.sessions || []) {
            const a = Math.max(sn.startedAt, from), b = Math.min(sn.endedAt, to);
            if (b > a) ms += b - a;
        }
        return ms;
    }

    // My voice time for the tracker window: per-day totals and per server /
    // channel totals since `from` (null = everything). Includes the session
    // that's running right now.
    myVoiceSummary(from = null) {
        const now = Date.now();
        const list = this._loadMyVoice().slice();
        if (this._mySess) list.push({ ...this._mySess, end: now, live: true });
        const inRange = from ? list.filter(x => x.end > from) : list;
        const clip = (x) => x.end - Math.max(x.start, from || 0);
        const total = inRange.reduce((a, x) => a + clip(x), 0);
        const servers = new Map();
        for (const x of inRange) {
            const gk = x.guildId || "dm";
            const g = servers.get(gk) || { name: x.guildId ? (x.guildName || this.getGuildName(x.guildId, x.channelId) || "Server") : "Calls / DMs", ms: 0, channels: new Map() };
            g.ms += clip(x);
            const ck = x.channelId || "?";
            const c = g.channels.get(ck) || { name: x.channelName || this.getChannelName(x.channelId) || "channel", ms: 0 };
            c.ms += clip(x);
            g.channels.set(ck, c);
            servers.set(gk, g);
        }
        // per calendar day, last 30 days (split sessions across midnight)
        const days = [];
        const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
        for (let i = 29; i >= 0; i--) {
            const a = d0.getTime() - i * 86400_000, b = a + 86400_000;
            let ms = 0;
            for (const x of list) { const s1 = Math.max(x.start, a), e1 = Math.min(x.end, b); if (e1 > s1) ms += e1 - s1; }
            days.push({ day: a, ms });
        }
        return {
            total, sessions: inRange.length, days,
            servers: [...servers.values()].sort((a, b) => b.ms - a.ms).map(g => ({
                name: g.name, ms: g.ms, channels: [...g.channels.values()].sort((a, b) => b.ms - a.ms)
            }))
        };
    }

    _stopFramePump() {
        if (this._framePump) {
            this._framePump.stop();
            vetLog("info", "frame pump stopped");
        }
        if (this._nativeStreamHandle) {
            try { this._nativeStreamHandle.release(); } catch (e) {}
            this._nativeStreamHandle = null;
        }
        this._watchedUserId = null;
        this._sourceSid = null;
    }

    _setStreamSound(enabled) {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("setGoLiveSource", { searchExports: true });

            if (!mes || !actions?.setGoLiveSource) {
                vetLog("warn", "_setStreamSound: setGoLiveSource not found");
                return false;
            }

            const current = mes.getGoLiveSource?.();
            if (!current) {
                this._pendingStreamSound = !!enabled;
                vetLog("info", "_setStreamSound: not streaming, saved");
                return false;
            }

            if (!current.desktopSource?.id) {
                vetLog("warn", "_setStreamSound: no desktopSource.id");
                return false;
            }

            const quality = current.quality || {};
            const soundBool = !!enabled;

            try {
                const settingsStore = (() => {
                    let ref = null;
                    BdApi.Webpack.getModule(m => {
                        if (!m || typeof m !== "object") return false;
                        try {
                            const s = m.getState?.();
                            if (s && "soundshareEnabled" in s) { ref = m; return true; }
                        } catch {}
                        return false;
                    }, { searchExports: false });
                    return ref;
                })();

                if (settingsStore?._dispatcher) {
                    settingsStore._dispatcher.dispatch({
                        type: "STREAM_UPDATE_SETTINGS",
                        preset: 1,
                        resolution: quality.resolution ?? 1080,
                        frameRate: quality.frameRate ?? 30,
                        soundshareEnabled: soundBool
                    });
                    vetLog("info", "_setStreamSound: dispatched STREAM_UPDATE_SETTINGS", soundBool);
                }
            } catch (e) {
                vetLog("warn", "_setStreamSound: STREAM_UPDATE_SETTINGS failed", e);
            }

            const payload = {
                desktopSettings: {
                    sourceId: current.desktopSource.id,
                    sound: soundBool
                },
                qualityOptions: {
                    preset: 1,
                    resolution: quality.resolution ?? 1080,
                    frameRate: quality.frameRate ?? 30
                },
                context: "stream"
            };

            vetLog("info", "_setStreamSound:", payload);
            actions.setGoLiveSource(payload);
            return true;
        } catch (e) {
            vetLog("error", "_setStreamSound:", e);
            return false;
        }
    }

    _getLiveStreamSound() {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const current = mes?.getGoLiveSource?.();
            if (!current) return null;

            if (current.desktopSource && typeof current.desktopSource.sound === "boolean") {
                return current.desktopSource.sound;
            }

            let ref = null;
            BdApi.Webpack.getModule(m => {
                if (!m || typeof m !== "object") return false;
                try {
                    const s = m.getState?.();
                    if (s && "soundshareEnabled" in s) { ref = m; return true; }
                } catch {}
                return false;
            }, { searchExports: false });

            const state = ref?.getState?.();
            if (state && typeof state.soundshareEnabled === "boolean") {
                return state.soundshareEnabled;
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    _stopSelfStream() {
        try {
            const candidates = document.querySelectorAll(
                '[aria-label*="Stop" i][aria-label*="stream" i],' +
                '[aria-label*="Stop" i][aria-label*="share" i],' +
                '[aria-label*="Stop" i][aria-label*="screen" i]'
            );
            for (const el of candidates) {
                if (el instanceof HTMLElement) {
                    el.click();
                    return true;
                }
            }
        } catch (e) {}
        vetLog("warn", "_stopSelfStream: button not found");
        return false;
    }

    // =====================================================================
    // Manual user management
    // =====================================================================

    manualAddUser(input) {
        if (!input) return { ok: false, reason: "empty" };
        const trimmed = String(input).trim();

        const UserStore = BdApi.Webpack.getStore("UserStore");
        if (!UserStore) return { ok: false, reason: "no-userstore" };

        let user = null;
        if (/^\d{15,25}$/.test(trimmed)) {
            user = UserStore.getUser?.(trimmed) ?? null;
        }
        if (!user) {
            const all = UserStore.getUsers?.() ?? {};
            const lower = trimmed.toLowerCase().replace(/^@/, "");
            for (const id in all) {
                const u = all[id];
                if (!u) continue;
                if ((u.username && u.username.toLowerCase() === lower) ||
                    (u.globalName && u.globalName.toLowerCase() === lower)) {
                    user = u;
                    break;
                }
            }
        }
        if (!user) return { ok: false, reason: "not-found" };

        const cur = this.encounters.get(user.id);
        if (cur) {
            cur.manual = true;
            cur.username = user.username ?? user.globalName ?? cur.username;
            this.scheduleSave();
            return { ok: true, user: { id: user.id, username: cur.username }, existed: true };
        }

        this.encounters.set(user.id, {
            userId: user.id,
            username: user.username ?? user.globalName ?? "(unknown)",
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            totalMs: 0, meetings: 0,
            lastGuildId: null, lastChannelId: null,
            lastGuildName: null, lastChannelName: null,
            blocked: false, ignored: false, manual: true,
            sessions: []
        });
        this.scheduleSave();
        this.scheduleOverlayPush();
        return { ok: true, user: { id: user.id, username: this.encounters.get(user.id).username } };
    }

    removeUser(userId) {
        if (!userId) return false;
        const existed = this.encounters.delete(userId);
        if (existed) {
            if (this._vetExpandedUser === userId) this._vetExpandedUser = null;
            if (this._vetExpandedSession?.userId === userId) this._vetExpandedSession = null;
            this.scheduleSave();
            this.scheduleOverlayPush();
        }
        return existed;
    }

    // =====================================================================
    // Settings panel
    // =====================================================================

    getSettingsPanel() {
        const container = document.createElement("div");
        container.style.cssText = "padding:0;color:var(--text-normal);font-size:14px";
        this.settingsContainer = container;

        this._vetSearchQuery = "";

        this.renderSettings(container);

        setTimeout(() => { try { this.stealInputFocus(container); } catch (e) {} }, 50);
        setTimeout(() => { try { this.stealInputFocus(container); } catch (e) {} }, 300);

        return container;
    }

    stealInputFocus(container) {
        const overlay = this._vetOverlay;
        if (!overlay) return;
        const input = overlay.querySelector("[data-role='search-input']");
        if (!input) return;
        if (document.activeElement === input) return;

        const active = document.activeElement;
        if (active && !overlay.contains(active)) {
            try { active.blur(); } catch (e) {}
        }
        try { input.focus({ preventScroll: true }); } catch (e) {}
    }

    renderSettings(container) {
        let overlay = this._vetOverlay;
        if (!overlay || !overlay.isConnected) {
            overlay = this._createSettingsOverlay(container);
            this._vetOverlay = overlay;
        }
        this._refreshSettingsContents(overlay, container);
    }

    _createSettingsOverlay(container) {
        if (!document.getElementById("vet-settings-style")) {
            const style = document.createElement("style");
            style.id = "vet-settings-style";
            style.textContent = `
                .vet-overlay {
                    position: fixed !important; inset: 0 !important;
                    z-index: 2147483647 !important;
                    background: rgba(0,0,0,0.65) !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    padding: 24px !important;
                    box-sizing: border-box !important;
                    font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif) !important;
                    color: var(--text-normal, #dcddde) !important;
                    pointer-events: auto !important;
                }
                .vet-overlay * { box-sizing: border-box; }
                .vet-modal {
                    width: min(1400px, 96vw);
                    max-height: 92vh;
                    background: var(--background-primary, #313338);
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 8px;
                    display: flex; flex-direction: column; overflow: hidden;
                    box-shadow: 0 12px 48px rgba(0,0,0,0.6);
                }
                .vet-header {
                    display: flex; align-items: flex-start; justify-content: space-between;
                    gap: 16px; padding: 16px 20px 12px;
                    border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                    flex-shrink: 0;
                }
                .vet-header h2 { font-size: 20px; margin: 0 0 4px 0; }
                .vet-body {
                    flex: 1; min-height: 0;
                    overflow: auto;
                    padding: 16px 20px 20px;
                }
                .vet-body::-webkit-scrollbar { width: 10px; height: 10px; }
                .vet-body::-webkit-scrollbar-thumb {
                    background: var(--background-modifier-accent, #3f4147);
                    border-radius: 5px;
                }
                .vet-body::-webkit-scrollbar-thumb:hover {
                    background: var(--background-modifier-hover, #4f545c);
                }
                .vet-prefs {
                    display: flex; flex-direction: column; gap: 8px;
                    margin-bottom: 14px; padding: 10px 12px;
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px; background: var(--background-secondary, #2b2d31);
                }
                .vet-pref-label {
                    display: flex; align-items: center; gap: 8px;
                    cursor: pointer; font-size: 13px;
                }

                .vet-input {
                    flex: 1;
                    padding: 6px 10px;
                    font-size: 13px;
                    font-family: inherit;
                    color: var(--text-normal, #dcddde);
                    background: var(--background-primary, #313338);
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px;
                    outline: none;
                    cursor: text !important;
                    user-select: text !important;
                    -webkit-user-select: text !important;
                }
                .vet-input:focus {
                    border-color: #5865f2;
                    box-shadow: 0 0 0 1px #5865f2;
                }

                .vet-search {
                    display: flex; gap: 6px;
                    margin-bottom: 14px;
                }
                .vet-me {
                    margin-bottom: 14px; padding: 10px 12px;
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px; background: var(--background-secondary, #2b2d31);
                }
                .vet-me-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
                .vet-me-head .tot { font-size: 13px; opacity: .85; }
                .vet-me-head .tot b { font-size: 15px; opacity: 1; }
                .vet-seg { display: inline-flex; border: 1px solid var(--background-modifier-accent, #444); border-radius: 4px; overflow: hidden; margin-left: auto; }
                .vet-seg button { background: none; border: none; color: inherit; padding: 3px 9px; cursor: pointer; font-size: 12px; opacity: .7; }
                .vet-seg button.on { background: rgba(88,101,242,0.35); opacity: 1; }
                .vet-me-chart { margin: 8px 0 6px; }
                .vet-me-chart .bar { fill: #5865f2; opacity: .75; }
                .vet-me-chart .bar.today { opacity: 1; }
                .vet-me-chart text { fill: currentColor; opacity: .5; font-size: 10px; }
                .vet-me-list { display: grid; grid-template-columns: 1fr auto; gap: 2px 14px; font-size: 13px; }
                .vet-me-list .g { font-weight: 600; }
                .vet-me-list .c { padding-left: 14px; opacity: .75; }
                .vet-me-list .t { text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
                .vet-me-list .more { padding-left: 14px; opacity: .5; font-size: 12px; }
                .vet-time {
                    margin-bottom: 14px; padding: 10px 12px;
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px; background: var(--background-secondary, #2b2d31);
                }
                .vet-time-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                .vet-time-row input[type=datetime-local] {
                    background: var(--background-tertiary, #1e1f22); color: inherit;
                    border: 1px solid var(--background-modifier-accent, #444); border-radius: 4px;
                    padding: 4px 6px; color-scheme: dark;
                }
                .vet-time-res { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow: auto; }
                .vet-time-res .r {
                    display: flex; gap: 10px; align-items: baseline; padding: 4px 6px; border-radius: 3px;
                    cursor: pointer; font-size: 13px;
                }
                .vet-time-res .r:hover { background: rgba(255,255,255,0.05); }
                .vet-time-res .r b { min-width: 160px; }
                .vet-time-res .r .m { opacity: .65; font-size: 12px; }
                .vet-time-res .empty { opacity: .6; font-size: 12px; padding: 4px 6px; }
                .vet-chip {
                    display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px; border-radius: 10px;
                    background: rgba(88,101,242,0.25); font-size: 12px;
                }
                .vet-chip button { background: none; border: none; color: inherit; cursor: pointer; padding: 0; opacity: .7; }
                .vet-pick { cursor: pointer; accent-color: #5865f2; }
                tr.vet-jump > td { background: rgba(250,166,26,0.18) !important; }

                .vet-manual {
                    margin-bottom: 14px; padding: 10px 12px;
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px; background: var(--background-secondary, #2b2d31);
                }
                .vet-manual-title { font-size: 13px; margin-bottom: 6px; opacity: .8; }
                .vet-manual-row { display: flex; gap: 6px; }
                .vet-manual-status { font-size: 12px; margin-top: 6px; opacity: .7; min-height: 14px; }

                .vet-btn {
                    padding: 6px 12px; font-size: 12px; font-weight: 500;
                    cursor: pointer; color: var(--text-normal, #dcddde);
                    background: var(--background-secondary, #2b2d31);
                    border: 1px solid var(--background-modifier-hover, #4f545c);
                    border-radius: 4px;
                    transition: background .15s, border-color .15s, color .15s;
                    font-family: inherit;
                }
                .vet-btn:hover { background: var(--background-modifier-hover, #4f545c); }
                .vet-btn.primary { color: #fff; background: #5865f2; border-color: #4752c4; }
                .vet-btn.primary:hover { background: #4752c4; }
                .vet-btn.vet-close { padding: 8px 16px; }
                .vet-table-wrap {
                    border: 1px solid var(--background-modifier-accent, #3f4147);
                    border-radius: 4px;
                    overflow-x: auto;
                }
                .vet-table-wrap::-webkit-scrollbar { height: 10px; }
                .vet-table-wrap::-webkit-scrollbar-thumb {
                    background: var(--background-modifier-accent, #3f4147);
                    border-radius: 5px;
                }
                .vet-table {
                    width: 100%; min-width: 1340px;
                    border-collapse: collapse; font-size: 12px;
                }
                .vet-table thead th {
                    position: sticky; top: 0; z-index: 1;
                    background: var(--background-primary, #313338);
                    padding: 8px 10px; text-align: left;
                    font-weight: 600; font-size: 11px;
                    text-transform: uppercase; letter-spacing: 0.4px; opacity: .7;
                    border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                    white-space: nowrap;
                }
                .vet-table thead th[data-sort] { cursor: pointer; user-select: none; }
                .vet-table thead th[data-sort]:hover { opacity: 1; }
                .vet-table thead th.vet-sorted { opacity: 1; color: var(--text-link, #00a8fc); }
                .vet-table td {
                    padding: 8px 10px; white-space: nowrap;
                    border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                    vertical-align: middle;
                }
                .vet-table tr:last-child td { border-bottom: none; }
                .vet-num { text-align: right; font-variant-numeric: tabular-nums; }
                .vet-badge { text-align: center; font-size: 14px; }
                .vet-actions { text-align: right; white-space: nowrap; }
                .vet-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
                .vet-id { font-family: monospace; font-size: 11px; opacity: 0.65; }
                .vet-status { font-weight: 600; }
                .vet-status[data-status="blocked"] { color: #ed4245; }
                .vet-status[data-status="ignored"] { color: #faa61a; }
                .vet-status[data-status="muted"]   { color: #72767d; }
                .vet-date { font-variant-numeric: tabular-nums; }
                .vet-empty { padding: 20px; opacity: .5; text-align: center; }

                .vet-main-row { cursor: pointer; }
                .vet-main-row:hover { background: rgba(255,255,255,0.03); }
                .vet-main-row.expanded { background: rgba(88,101,242,0.08); }
                .vet-main-row.expanded .vet-expand-arrow { color: #5865f2; }

                .vet-expand-arrow {
                    display: inline-block;
                    width: 12px;
                    margin-right: 6px;
                    font-size: 9px;
                    opacity: 0.5;
                    transition: opacity 0.15s, color 0.15s;
                }
                .vet-main-row:hover .vet-expand-arrow { opacity: 1; }

                .vet-actions .vet-btn {
                    padding: 4px 10px;
                    font-size: 11px;
                    margin-left: 4px;
                }
                .vet-actions .vet-btn.block.active  { color: #ed4245; border-color: #ed4245; }
                .vet-actions .vet-btn.ignore.active { color: #faa61a; border-color: #faa61a; }
                .vet-actions .vet-btn.remove { color: #ed4245; border-color: rgba(237, 66, 69, 0.5); }
                .vet-actions .vet-btn.remove:hover { color: #fff; background: #ed4245; border-color: #ed4245; }
                .vet-actions .vet-btn.history {
                    color: var(--text-link, #00a8fc);
                    border-color: rgba(0,168,252,0.35);
                }
                .vet-actions .vet-btn.history:hover {
                    background: #5865f2;
                    color: #fff;
                    border-color: #5865f2;
                }

                .vet-sessions-row > td {
                    padding: 0 !important;
                    background: var(--background-secondary, #2b2d31);
                    border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                }
                .vet-sessions {
                    padding: 10px 16px 12px 40px;
                    font-size: 12px;
                    line-height: 1.6;
                    color: var(--text-normal, #dcddde);
                }
                .vet-sessions-header {
                    font-weight: 600;
                    margin-bottom: 6px;
                    opacity: 0.7;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                }
                .vet-session-pick {
                    cursor: pointer; opacity: .6; font-size: 13px; line-height: 1;
                    user-select: none; text-align: center;
                }
                .vet-session-pick:hover { opacity: 1; }
                .vet-session-entry.selected { background: rgba(59,165,93,0.12); }
                .vet-session-entry.selected .vet-session-pick { opacity: 1; color: #3ba55d; }
                .vet-merge-bar { margin-left: 12px; text-transform: none; letter-spacing: 0; }
                .vet-merge-bar .vet-btn { margin-left: 4px; }
                .vet-merge-bar .vet-btn[disabled] { opacity: .45; cursor: default; }
                .vet-session-entry {
                    display: grid;
                    grid-template-columns: 22px 90px 140px 80px minmax(140px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr) 90px;
                    gap: 12px;
                    padding: 5px 4px;
                    border-bottom: 1px solid rgba(255,255,255,0.04);
                    cursor: pointer;
                    border-radius: 3px;
                    transition: background 0.15s;
                }
                .vet-session-entry:hover { background: rgba(255,255,255,0.04); }
                .vet-session-entry.expanded { background: rgba(88,101,242,0.12); }
                .vet-session-entry.expanded .vet-session-arrow { color: #5865f2; }
                .vet-session-arrow {
                    display: inline-block;
                    width: 10px;
                    font-size: 9px;
                    opacity: 0.5;
                }
                .vet-session-entry:hover .vet-session-arrow { opacity: 1; }
                .vet-session-date { font-variant-numeric: tabular-nums; opacity: 0.8; }
                .vet-session-time { font-variant-numeric: tabular-nums; opacity: 0.8; }
                .vet-session-dur  { font-variant-numeric: tabular-nums; color: #3ba55d; font-weight: 500; }
                .vet-session-guild   { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
                .vet-session-channel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
                .vet-session-more { opacity: 0.5; padding-top: 6px; font-style: italic; }
                .vet-session-open {
                    text-align: right;
                    font-size: 10px;
                    opacity: 0.6;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                }

                .vet-timeline-row > td {
                    padding: 0 !important;
                    background: var(--background-tertiary, #1e1f22);
                    border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                }
                .vet-timeline {
                    padding: 14px 20px 16px 60px;
                }
                .vet-timeline-title {
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    opacity: 0.65;
                    margin-bottom: 10px;
                }
                .vet-timeline-bar {
                    position: relative;
                    height: 22px;
                    width: 100%;
                    background: #2b2d31;
                    border-radius: 3px;
                    overflow: hidden;
                    display: flex;
                }
                .vet-timeline-seg {
                    height: 100%;
                    min-width: 2px;
                    transition: filter 0.15s;
                    cursor: default;
                    position: relative;
                }
                .vet-timeline-seg:hover { filter: brightness(1.25); }

                .vet-timeline-legend {
                    display: flex;
                    gap: 12px;
                    margin-top: 8px;
                    font-size: 10px;
                    opacity: 0.7;
                    flex-wrap: wrap;
                }
                .vet-timeline-legend .dot {
                    display: inline-block;
                    width: 10px;
                    height: 10px;
                    border-radius: 2px;
                    margin-right: 4px;
                    vertical-align: middle;
                }

                .vet-timeline-events {
                    margin-top: 10px;
                    font-size: 11px;
                    line-height: 1.7;
                    font-variant-numeric: tabular-nums;
                    max-height: 220px;
                    overflow-y: auto;
                    border-left: 1px solid var(--background-modifier-accent, #3f4147);
                    padding-left: 10px;
                }
                .vet-timeline-events::-webkit-scrollbar { width: 6px; }
                .vet-timeline-events::-webkit-scrollbar-thumb {
                    background: var(--background-modifier-accent, #3f4147);
                    border-radius: 3px;
                }
                .vet-timeline-events .ev-time { opacity: 0.6; margin-right: 8px; }
                .vet-timeline-events .ev-dur  { opacity: 0.5; margin-left: 8px; font-style: italic; }
            `;
            document.head.appendChild(style);
        }

        const overlay = document.createElement("div");
        overlay.className = "vet-overlay";
        overlay.style.cssText = [
            "position:fixed","top:0","left:0","right:0","bottom:0",
            "z-index:2147483647","background:rgba(0,0,0,0.65)",
            "display:flex","align-items:center","justify-content:center",
            "padding:24px","box-sizing:border-box"
        ].join(";") + ";";

        overlay.innerHTML = `
            <div class="vet-modal">
                <div class="vet-header">
                    <div>
                        <h2>Voice Encounter Tracker</h2>
                        <p class="vet-subtitle" style="opacity:.7;margin:0;font-size:13px"></p>
                    </div>
                    <button type="button" class="vet-btn vet-close" data-action="close">Close</button>
                </div>

                <div class="vet-body">
                    <div class="vet-prefs">
                        <label class="vet-pref-label">
                            <input type="checkbox" data-pref="autoMuteBlocked">
                            <span>Auto-mute users when you block them</span>
                        </label>
                        <label class="vet-pref-label">
                            <input type="checkbox" data-pref="hideMuteForBlocked">
                            <span>Hide Discord's mute icon for blocked / ignored users</span>
                        </label>
                        <label class="vet-pref-label">
                            <input type="checkbox" data-pref="flashIconOnMute">
                            <span>Flash the overlay icon when someone mutes or deafens themselves
                                <span style="opacity:.6">— pulse for 15s, then solid yellow for 15s, then back to normal.</span>
                            </span>
                        </label>
                        <label class="vet-pref-label">
                            <input type="number" min="0" max="1440" step="5" data-pref-num="knownMinMinutes"
                                style="width:64px;padding:2px 4px;background:var(--background-secondary,#2b2d31);color:inherit;border:1px solid var(--background-modifier-accent,#444);border-radius:4px">
                            <span>Minutes together in voice before a user counts as known (✓)</span>
                        </label>
                    </div>

                    <div class="vet-search">
                        <input type="text" class="vet-input" data-role="search-input"
                            placeholder="Search by name, username or user ID"
                            autocomplete="off" spellcheck="false">
                        <button type="button" class="vet-btn" data-action="search-clear">Clear</button>
                    </div>

                    <div class="vet-me">
                        <div class="vet-me-head">
                            <span class="vet-manual-title" style="margin:0">My voice time</span>
                            <span class="tot" data-role="me-total"></span>
                            <span class="vet-seg" data-role="me-range">
                                <button type="button" data-range="7">7 days</button>
                                <button type="button" data-range="30">30 days</button>
                                <button type="button" data-range="all">All</button>
                            </span>
                        </div>
                        <div class="vet-me-chart" data-role="me-chart"></div>
                        <div class="vet-me-list" data-role="me-list"></div>
                    </div>

                    <div class="vet-time">
                        <div class="vet-manual-title">Who was in voice with me</div>
                        <div class="vet-time-row">
                            <span style="opacity:.7">From</span>
                            <input type="datetime-local" data-role="t-from">
                            <span style="opacity:.7">to</span>
                            <input type="datetime-local" data-role="t-to" title="Leave empty to look at one moment">
                            <button type="button" class="vet-btn primary" data-action="t-find">Find</button>
                            <button type="button" class="vet-btn" data-action="t-together"
                                title="Tick 2-3 people in the table, then see when you were all together">Together…</button>
                            <span data-role="t-chips" style="display:flex;gap:4px;flex-wrap:wrap"></span>
                        </div>
                        <div class="vet-time-res" data-role="t-res"></div>
                    </div>

                    <div class="vet-manual">
                        <div class="vet-manual-title">Add user manually</div>
                        <div class="vet-manual-row">
                            <input type="text" class="vet-input" data-role="manual-input"
                                placeholder="User ID or username"
                                autocomplete="off" spellcheck="false">
                            <button type="button" class="vet-btn primary" data-action="manual-add">Add</button>
                            <button type="button" class="vet-btn" data-action="clear-all">Clear all</button>
                        </div>
                        <div class="vet-manual-status" data-role="manual-status"></div>
                    </div>

                    <div class="vet-table-wrap">
                        <table class="vet-table">
                            <thead>
                                <tr>
                                    <th class="vet-num">#</th>
                                    <th data-sort="user">User</th>
                                    <th data-sort="id">User ID</th>
                                    <th data-sort="status">Status</th>
                                    <th class="vet-num" data-sort="total">Total</th>
                                    <th class="vet-num" data-sort="sessions">Sessions</th>
                                    <th data-sort="first">First seen</th>
                                    <th data-sort="last">Last seen</th>
                                    <th class="vet-badge" data-sort="badge">!</th>
                                    <th class="vet-actions">Actions</th>
                                </tr>
                            </thead>
                            <tbody data-role="tbody"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const rerender = () => this._refreshSettingsContents(overlay, container);

        overlay.querySelectorAll("th[data-sort]").forEach(th => {
            th.addEventListener("click", () => {
                const key = th.getAttribute("data-sort");
                const cur = this._vetSort;
                // asc -> desc -> default order
                if (!cur || cur.key !== key) this._vetSort = { key, dir: 1 };
                else if (cur.dir === 1) this._vetSort = { key, dir: -1 };
                else this._vetSort = null;
                rerender();
            });
        });

        const close = () => {
            try { overlay.remove(); } catch (e) {}
            this._vetOverlay = null;
            this._vetSearchQuery = "";

            if (this._vetQueryDebounce) {
                try { clearTimeout(this._vetQueryDebounce); } catch (e) {}
                this._vetQueryDebounce = null;
            }

            document.removeEventListener("keydown", escHandler);
        };

        const escHandler = (e) => {
            if (e.key === "Escape" && this._vetOverlay === overlay) close();
        };
        document.addEventListener("keydown", escHandler);

        overlay.querySelector("[data-action='close']").addEventListener("click", close);
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

        overlay.querySelectorAll("input[data-pref-num]").forEach(inp => {
            inp.addEventListener("change", () => {
                const key = inp.getAttribute("data-pref-num");
                const v = Math.max(0, Math.min(1440, Math.round(Number(inp.value))));
                if (!Number.isFinite(v)) { inp.value = this.prefs[key]; return; }
                inp.value = v;
                this.prefs[key] = v;
                this.savePrefs();
                for (const [uid, el] of this.badgeNodes) {
                    try { this.applyBadgeStyle(el, this.getBadgeKind(uid), uid); } catch (e) {}
                }
                try { this.injectBadges(); } catch (e) {}
                try { this.pushStateToOverlay(); } catch (e) {}
            });
        });

        overlay.querySelectorAll("input[data-pref]").forEach(cb => {
            cb.addEventListener("change", () => {
                const key = cb.getAttribute("data-pref");
                this.prefs[key] = cb.checked;
                this.savePrefs();
                if (key === "hideMuteForBlocked") this.applyNativeMuteCss();
                try { this.injectBadges(); } catch (e) {}
                if (key === "flashIconOnMute") {
                    try { this.pushStateToOverlay(); } catch (e) {}
                }
            });
        });

        const searchInput = overlay.querySelector("[data-role='search-input']");
        searchInput.value = this._vetSearchQuery || "";

        searchInput.addEventListener("input", () => {
            this._vetSearchQuery = searchInput.value;
            clearTimeout(this._vetQueryDebounce);
            this._vetQueryDebounce = setTimeout(() => {
                this._refreshSettingsContents(overlay, container);
            }, 400);
        });

        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                clearTimeout(this._vetQueryDebounce);
                this._vetSearchQuery = searchInput.value;
                this._refreshSettingsContents(overlay, container);
            }
        });

        overlay.querySelector("[data-action='search-clear']").addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this._vetSearchQuery = "";
            searchInput.value = "";
            this._refreshSettingsContents(overlay, container);
            try { searchInput.focus({ preventScroll: true }); } catch (err) {}
        });

        const addBtn = overlay.querySelector("[data-action='manual-add']");
        const input  = overlay.querySelector("[data-role='manual-input']");
        const status = overlay.querySelector("[data-role='manual-status']");
        const doAdd = () => {
            const result = this.manualAddUser(input.value);
            if (result.ok) {
                status.style.color = "#3ba55d";
                status.textContent = result.existed
                    ? `Updated: ${result.user.username}`
                    : `Added: ${result.user.username}`;
                input.value = "";
                setTimeout(rerender, 600);
            } else {
                status.style.color = "#ed4245";
                status.textContent = result.reason === "not-found" ? "User not found"
                    : result.reason === "empty" ? "Enter a user ID or username"
                    : "Failed to add user";
            }
        };
        addBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); doAdd(); });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doAdd(); }
        });

        overlay.querySelector("[data-action='clear-all']").addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            this._vetConfirm(overlay,
                "Clear Encounters",
                "Delete all stored voice encounter history? Blocked / ignored / muted users will be re-imported automatically.",
                {
                    confirmText: "Delete", cancelText: "Cancel", danger: true,
                    onConfirm: () => {
                        this.encounters.clear();
                        if (this._mutedCache) this._mutedCache.clear();
                        if (this._saveDebounce) { clearTimeout(this._saveDebounce); this._saveDebounce = null; }
                        this._clearedAt = Date.now();
                        this._storedUserCount = 0;
                        try {
                            BdApi.Data.save(this.meta.name, this.getStoreKey(),
                                { version: 3, savedAt: Date.now(), clearedAt: this._clearedAt, users: [] });
                        } catch (e) {}
                        try { this.syncRelationshipLists(); } catch (e) {}
                        try { this.syncMuteList(); } catch (e) {}
                        try { this.scheduleOverlayPush(); } catch (e) {}
                        this._vetExpandedUser = null;
                        this._vetExpandedSession = null;
                        rerender();
                    }
                }
            );
        });

        // ── "Who was in voice with me" / "Together" ──
        const tFrom = overlay.querySelector("[data-role='t-from']");
        const tTo = overlay.querySelector("[data-role='t-to']");
        const tRes = overlay.querySelector("[data-role='t-res']");
        const tChips = overlay.querySelector("[data-role='t-chips']");
        const tTogetherBtn = overlay.querySelector("[data-action='t-together']");
        const esc = (x) => this._escape(String(x ?? ""));
        const nameOf = (id) => this.getStoredDisplayName(id) || this.getUserName(id);
        const fmtSpan = (a, b) => {
            const d = (t) => new Date(t);
            const hm = (t) => `${String(d(t).getHours()).padStart(2, "0")}:${String(d(t).getMinutes()).padStart(2, "0")}`;
            const day = (t) => d(t).toLocaleDateString();
            return day(a) === day(b) ? `${day(a)} ${hm(a)}–${hm(b)}` : `${day(a)} ${hm(a)} – ${day(b)} ${hm(b)}`;
        };
        const readRange = () => {
            const a = tFrom.value ? new Date(tFrom.value).getTime() : NaN;
            const b = tTo.value ? new Date(tTo.value).getTime() : NaN;
            if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
            const from = Number.isFinite(a) ? a : b, to = Number.isFinite(b) ? b : a;
            return { from: Math.min(from, to), to: Math.max(from, to) };
        };
        const jumpTo = (userId, idx) => {
            this._vetSearchQuery = "";
            const si = overlay.querySelector("[data-role='search-input']");
            if (si) si.value = "";
            this._vetExpandedUser = userId;
            this._vetExpandedSession = idx != null ? { userId, sessionIndex: idx } : null;
            this._vetJump = { userId, idx };
            rerender();
            setTimeout(() => overlay.querySelector(`tr.vet-main-row[data-user-id="${userId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
        };
        const renderTimeChips = () => {
            const set = this._vetTogether;
            tTogetherBtn.textContent = set ? (set.size >= 2 ? "Show together" : "Pick 2+ in the table…") : "Together…";
            tChips.innerHTML = set ? [...set].map(id =>
                `<span class="vet-chip">${esc(nameOf(id))}<button type="button" data-unpick="${id}">×</button></span>`).join("") +
                `<button type="button" class="vet-btn" data-action="t-cancel">Cancel</button>` : "";
        };

        overlay.querySelector("[data-action='t-find']").addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            const rg = readRange();
            if (!rg) { tRes.innerHTML = `<div class="empty">Pick a date and time first.</div>`; return; }
            const rows = this.whoWasThere(rg.from, rg.to);
            tRes.innerHTML = rows.length ? rows.map(x => `<div class="r" data-jump="${x.userId}" data-idx="${x.idx}">
                    <b>${esc(nameOf(x.userId))}</b>
                    <span>${this.formatDuration(x.overlapMs)}</span>
                    <span class="m">${fmtSpan(x.start, x.end)}${x.channelName ? " · #" + esc(x.channelName) : ""}${x.guildName ? " · " + esc(x.guildName) : ""}</span>
                </div>`).join("")
                : `<div class="empty">Nobody was in voice with you then.</div>`;
        });
        tTogetherBtn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!this._vetTogether) { this._vetTogether = new Set(); renderTimeChips(); rerender(); return; }
            if (this._vetTogether.size < 2) return;
            const rg = readRange();
            const spans = this.togetherSpans([...this._vetTogether], rg?.from, rg?.to);
            const total = spans.reduce((a, x) => a + (x.end - x.start), 0);
            tRes.innerHTML = spans.length
                ? `<div class="empty">All of them with you: ${this.formatDuration(total)} in ${spans.length} stretch(es)</div>` +
                  spans.slice(0, 100).map(x => `<div class="r" data-jump="${x.userId}" data-idx="${x.idx}">
                    <b>${fmtSpan(x.start, x.end)}</b><span>${this.formatDuration(x.end - x.start)}</span>
                    <span class="m">${x.channelName ? "#" + esc(x.channelName) : ""}${x.guildName ? " · " + esc(x.guildName) : ""}</span>
                  </div>`).join("")
                : `<div class="empty">Never all together with you${rg ? " in that period" : ""}.</div>`;
        });
        tChips.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            const un = e.target.closest("[data-unpick]");
            if (un) { this._vetTogether?.delete(un.getAttribute("data-unpick")); renderTimeChips(); rerender(); return; }
            if (e.target.closest("[data-action='t-cancel']")) { this._vetTogether = null; tRes.innerHTML = ""; renderTimeChips(); rerender(); }
        });
        tRes.addEventListener("click", (e) => {
            const row = e.target.closest("[data-jump]");
            if (!row) return;
            e.preventDefault(); e.stopPropagation();
            const idx = row.getAttribute("data-idx");
            jumpTo(row.getAttribute("data-jump"), idx === "" || idx == null ? null : Number(idx));
        });
        renderTimeChips();

        // ── My voice time ──
        const meRange = overlay.querySelector("[data-role='me-range']");
        const renderMe = () => {
            const key = this._vetMeRange || "7";
            meRange.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.getAttribute("data-range") === key));
            const from = key === "all" ? null : Date.now() - Number(key) * 86400_000;
            const sum = this.myVoiceSummary(from);
            overlay.querySelector("[data-role='me-total']").innerHTML =
                `<b>${this.formatDuration(sum.total)}</b> in ${sum.sessions} session${sum.sessions === 1 ? "" : "s"}`;
            // last 30 days, one bar per day
            const W = 600, H = 70, n = sum.days.length, bw = W / n;
            const max = Math.max(3600_000, ...sum.days.map(d => d.ms));
            const bars = sum.days.map((d, i) => {
                const h = d.ms ? Math.max(2, d.ms / max * (H - 14)) : 0;
                const dt = new Date(d.day);
                const tip = `${dt.toLocaleDateString()} — ${this.formatDuration(d.ms)}`;
                return `<rect class="bar${i === n - 1 ? " today" : ""}" x="${(i * bw + 1).toFixed(1)}" y="${(H - 14 - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${tip}</title></rect>`;
            }).join("");
            const lbl = (i) => { const dt = new Date(sum.days[i].day); return `${dt.getDate()}.${String(dt.getMonth() + 1).padStart(2, "0")}`; };
            overlay.querySelector("[data-role='me-chart']").innerHTML =
                `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}
                    <text x="0" y="${H - 2}">${lbl(0)}</text><text x="${W / 2}" y="${H - 2}" text-anchor="middle">${lbl(Math.floor(n / 2))}</text>
                    <text x="${W}" y="${H - 2}" text-anchor="end">today</text></svg>`;
            overlay.querySelector("[data-role='me-list']").innerHTML = sum.servers.length
                ? sum.servers.slice(0, 8).map(g =>
                    `<span class="g">${esc(g.name)}</span><span class="t">${this.formatDuration(g.ms)}</span>` +
                    g.channels.slice(0, 4).map(c => `<span class="c">#${esc(c.name)}</span><span class="t">${this.formatDuration(c.ms)}</span>`).join("") +
                    (g.channels.length > 4 ? `<span class="more">+${g.channels.length - 4} more</span><span></span>` : "")).join("")
                : `<span style="opacity:.6">No voice time recorded yet.</span><span></span>`;
        };
        meRange.addEventListener("click", (e) => {
            const b = e.target.closest("[data-range]");
            if (!b) return;
            e.preventDefault(); e.stopPropagation();
            this._vetMeRange = b.getAttribute("data-range");
            renderMe();
        });
        renderMe();

        overlay.querySelector("[data-role='tbody']").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (btn) {
                const action = btn.getAttribute("data-action");
                const userId = btn.getAttribute("data-user-id");
                if (!action || !userId) return;
                if (action !== "t-pick") e.preventDefault();
                e.stopPropagation();

                const rel = BdApi.Webpack.getByKeys("blockUser", "unblockUser", { searchExports: true });
                const rec = this.encounters.get(userId);

                if (action === "history") {
                    this._vetExpandedUser = this._vetExpandedUser === userId ? null : userId;
                    this._vetExpandedSession = null;
                    this._vetMergeSel = null;
                    rerender();
                } else if (action === "merge-toggle") {
                    const idx = Number(btn.getAttribute("data-session-idx"));
                    if (!Number.isFinite(idx)) return;
                    if (!this._vetMergeSel || this._vetMergeSel.userId !== userId) {
                        this._vetMergeSel = { userId, idx: new Set() };
                    }
                    const set = this._vetMergeSel.idx;
                    if (set.has(idx)) set.delete(idx); else set.add(idx);
                    rerender();
                } else if (action === "merge-clear") {
                    this._vetMergeSel = null;
                    rerender();
                } else if (action === "merge-apply") {
                    const sel = this._vetMergeSel;
                    if (!sel || sel.userId !== userId || sel.idx.size < 2) return;
                    const idxs = [...sel.idx];
                    this._vetConfirm(overlay,
                        "Merge sessions",
                        `Merge ${idxs.length} sessions into one continuous session, as if you never left? ` +
                        `Gaps between them will count as time together. This cannot be undone.`,
                        {
                            confirmText: "Merge",
                            cancelText: "Cancel",
                            onConfirm: () => {
                                this.mergeSessions(userId, idxs);
                                this._vetMergeSel = null;
                                this._vetExpandedSession = null;
                                rerender();
                            }
                        }
                    );
                } else if (action === "toggle-block") {
                    const willBeBlocked = !rec?.blocked;
                    if (willBeBlocked) rel?.blockUser?.(userId);
                    else               rel?.unblockUser?.(userId);
                    this._waitForRelationshipState(userId, willBeBlocked, () => rerender(), "blocked");
                } else if (action === "toggle-ignore") {
                    const willBeIgnored = !rec?.ignored;
                    if (willBeIgnored) rel?.ignoreUser?.(userId);
                    else               rel?.unignoreUser?.(userId);
                    this._waitForRelationshipState(userId, willBeIgnored, () => rerender(), "ignored");
                } else if (action === "remove") {
                    this.removeUser(userId);
                    rerender();
                } else if (action === "invite") {
                    this._inviteDialog(overlay, userId);
                } else if (action === "t-pick") {
                    if (!this._vetTogether) return;
                    if (this._vetTogether.has(userId)) this._vetTogether.delete(userId);
                    else if (this._vetTogether.size < 5) this._vetTogether.add(userId);
                    renderTimeChips();
                    rerender();
                }
                return;
            }

            const sessionEntry = e.target.closest(".vet-session-entry");
            if (sessionEntry) {
                const userId = sessionEntry.getAttribute("data-user-id");
                const idx = Number(sessionEntry.getAttribute("data-session-idx"));
                if (!userId || !Number.isFinite(idx)) return;
                e.preventDefault(); e.stopPropagation();

                if (this._vetExpandedSession &&
                    this._vetExpandedSession.userId === userId &&
                    this._vetExpandedSession.sessionIndex === idx) {
                    this._vetExpandedSession = null;
                } else {
                    this._vetExpandedSession = { userId, sessionIndex: idx };
                }
                rerender();
                return;
            }

            const mainRow = e.target.closest(".vet-main-row");
            if (mainRow) {
                const userId = mainRow.getAttribute("data-user-id");
                if (!userId) return;
                if (e.target.closest("button, a, input")) return;
                this._vetExpandedUser = this._vetExpandedUser === userId ? null : userId;
                this._vetExpandedSession = null;
                rerender();
            }
        });

        this.attachInputFocus(overlay);

        return overlay;
    }

    attachInputFocus(container) {
        const searchInput = container.querySelector("[data-role='search-input']");
        const manualInput = container.querySelector("[data-role='manual-input']");
        const inputs = [searchInput, manualInput].filter(Boolean);

        for (const input of inputs) {
            input.removeAttribute("readonly");
            input.removeAttribute("disabled");
            input.tabIndex = 0;
            input.addEventListener("keydown", (e) => {
                if (e.key === "Tab") return;
                e.stopPropagation();
            }, true);
            input.addEventListener("keyup", (e) => {
                if (e.key === "Tab") return;
                e.stopPropagation();
            }, true);
            input.addEventListener("keypress", (e) => e.stopPropagation(), true);
        }
    }

    _refreshSettingsContents(overlay, container) {
        let entries = Array.from(this.encounters.values())
            .sort((a, b) => {
                const rank = r => r.blocked ? 0 : r.ignored ? 1 : 2;
                const ra = rank(a), rb = rank(b);
                if (ra !== rb) return ra - rb;
                return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
            });

        const sort = this._vetSort;
        if (sort) {
            const kindRank = { blocked: 0, ignored: 1, muted: 2, stranger: 3, known: 4 };
            const getters = {
                user:     r => (this.getStoredDisplayName(r.userId) || this.getUserName(r.userId)).toLowerCase(),
                id:       r => BigInt(r.userId || 0),
                status:   r => kindRank[this.getBadgeKind(r.userId)] ?? 9,
                badge:    r => kindRank[this.getBadgeKind(r.userId)] ?? 9,
                total:    r => r.totalMs || 0,
                sessions: r => (r.sessions || []).length,
                first:    r => r.firstSeenAt || 0,
                last:     r => r.lastSeenAt || 0
            };
            const get = getters[sort.key];
            if (get) {
                const keyed = entries.map(r => {
                    let v; try { v = get(r); } catch (e) { v = 0; }
                    return { r, v };
                });
                keyed.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * sort.dir);
                entries = keyed.map(x => x.r);
            }
        }
        overlay.querySelectorAll("th[data-sort]").forEach(th => {
            const k = th.getAttribute("data-sort");
            const label = th.getAttribute("data-label") ?? th.textContent;
            th.setAttribute("data-label", label);
            const active = sort && sort.key === k;
            th.classList.toggle("vet-sorted", !!active);
            th.textContent = active ? `${label} ${sort.dir === 1 ? "▲" : "▼"}` : label;
        });

        const query = (this._vetSearchQuery || "").trim().toLowerCase();
        if (query) {
            entries = entries.filter(rec => {
                const uid = String(rec.userId || "").toLowerCase();
                const uname = this.getUserName(rec.userId).toLowerCase();
                const disp = (this.getStoredDisplayName(rec.userId) || "").toLowerCase();
                return uid.includes(query)
                    || uname.includes(query)
                    || disp.includes(query);
            });
        }

        const authorName = this.meta.author ?? "unknown";
        const authorUrl  = this.meta.authorLink ?? this.meta.website ?? null;
        const authorHtml = authorUrl
            ? `by <a href="${authorUrl}" target="_blank" rel="noopener noreferrer"
                    style="color:var(--text-link);text-decoration:none">${authorName}</a>`
            : `by ${authorName}`;

        const sub = overlay.querySelector(".vet-subtitle");
        if (sub) {
            sub.innerHTML = `${authorHtml}
                <span style="opacity:.5"> · v${this.meta.version ?? "?"}</span>
                <span style="opacity:.5"> · ${entries.length} users · window ${this.formatDuration(this.RECENT_MS)}</span>`;
        }

        overlay.querySelector("input[data-pref='autoMuteBlocked']").checked = this.prefs.autoMuteBlocked;
        overlay.querySelector("input[data-pref='hideMuteForBlocked']").checked = this.prefs.hideMuteForBlocked;
        overlay.querySelector("input[data-pref='flashIconOnMute']").checked = this.prefs.flashIconOnMute;
        overlay.querySelector("input[data-pref-num='knownMinMinutes']").value = this.prefs.knownMinMinutes ?? 15;

        const tbody = overlay.querySelector("[data-role='tbody']");
        if (!tbody) return;

        const expandedId = this._vetExpandedUser;
        const expandedSession = this._vetExpandedSession;

        const html = entries.map((rec, i) => {
            const rawUsername = this.getUserName(rec.userId);
            const username = this._escape(rawUsername);
            const rawDisplay = this.getStoredDisplayName(rec.userId);
            const displayName = rawDisplay ? this._escape(rawDisplay) : null;
            const kind = this.getBadgeKind(rec.userId);
            // Name history = name changes across recorded sessions
            const prevNames = [];
            let prevKey = null;
            for (const sn of (Array.isArray(rec.sessions) ? rec.sessions : [])) {
                if (!sn?.username && !sn?.globalName) continue;
                const k = `${sn.username}|${sn.globalName}`;
                if (k === prevKey) continue;
                prevKey = k;
                prevNames.push({ at: sn.startedAt, username: sn.username, globalName: sn.globalName });
            }
            const prevNameLines = prevNames
                .map(n => `${this.formatDate(n.at)}  ${n.globalName && n.globalName !== n.username ? n.globalName + " (" + n.username + ")" : (n.username || n.globalName)}`);
            const nameTitle = this._escape(`${this.getUserName(rec.userId)} (${rec.userId})` +
                (prevNameLines.length > 1 ? "\nName history:\n" + prevNameLines.join("\n") : ""));
            let glyph, glyphColor, status;
            if (kind === "blocked")      { glyph = "⊘"; glyphColor = "#ed4245"; status = "blocked"; }
            else if (kind === "ignored") { glyph = "⊘"; glyphColor = "#faa61a"; status = "ignored"; }
            else if (kind === "muted")   { glyph = "○"; glyphColor = "#72767d"; status = "muted"; }
            else if (kind === "known")   { glyph = "✓"; glyphColor = "#3ba55d"; status = "—"; }
            else                          { glyph = "!"; glyphColor = "#a3a6aa"; status = "—"; }

            const blockedCls = rec.blocked ? " active" : "";
            const ignoredCls = rec.ignored ? " active" : "";
            const isExpanded = expandedId === rec.userId;
            const arrow = isExpanded ? "▼" : "▶";

            const picking = !!this._vetTogether;
            const picked = picking && this._vetTogether.has(rec.userId);
            const jumpCls = this._vetJump?.userId === rec.userId ? " vet-jump" : "";
            const mainRow = `<tr class="vet-main-row${isExpanded ? " expanded" : ""}${jumpCls}" data-user-id="${rec.userId}">
                <td class="vet-num">${picking
                    ? `<input type="checkbox" class="vet-pick" data-action="t-pick" data-user-id="${rec.userId}" ${picked ? "checked" : ""}>`
                    : i + 1}</td>
                <td class="vet-name" title="${nameTitle}">
                    <span class="vet-expand-arrow">${arrow}</span>${displayName && rawDisplay !== rawUsername
                        ? `${displayName} <span style="opacity:.55">${username}</span>`
                        : username}
                </td>
                <td class="vet-id" title="${rec.userId}">${rec.userId}</td>
                <td class="vet-status" data-status="${status}">${status}</td>
                <td class="vet-num">${rec.totalMs ? this.formatDuration(rec.totalMs) : "—"}</td>
                <td class="vet-num">${(rec.sessions || []).length || "—"}</td>
                <td class="vet-date">${this.formatDate(rec.firstSeenAt)}</td>
                <td class="vet-date">${this.formatDate(rec.lastSeenAt)}</td>
                <td class="vet-badge" style="color:${glyphColor};font-weight:700">${glyph}</td>
                <td class="vet-actions">
                    <button type="button" class="vet-btn history"
                        data-action="history" data-user-id="${rec.userId}"
                        title="Show voice sessions">${isExpanded ? "Hide" : "History"}</button>
                    <button type="button" class="vet-btn block${blockedCls}"
                        data-action="toggle-block" data-user-id="${rec.userId}">
                        ${rec.blocked ? "Unblock" : "Block"}
                    </button>
                    <button type="button" class="vet-btn ignore${ignoredCls}"
                        data-action="toggle-ignore" data-user-id="${rec.userId}">
                        ${rec.ignored ? "Unignore" : "Ignore"}
                    </button>
                    <button type="button" class="vet-btn"
                        data-action="invite" data-user-id="${rec.userId}"
                        title="Invite to the voice channel you're in">Invite</button>
                    <button type="button" class="vet-btn remove"
                        data-action="remove" data-user-id="${rec.userId}"
                        title="Remove from history">Remove</button>
                </td>
            </tr>`;

            if (!isExpanded) return mainRow;

            const allSessions = Array.isArray(rec.sessions) ? rec.sessions : [];
            const reversed = allSessions.map((s, idx) => ({ s, idx })).reverse();
            let from = 0;
            const jumpIdx = this._vetJump?.userId === rec.userId ? this._vetJump.idx : null;
            if (jumpIdx != null) {
                const pos = reversed.findIndex(x => x.idx === jumpIdx);
                if (pos >= 20) from = Math.max(0, pos - 10);
            }
            const shownSessions = reversed.slice(from, from + 20);

            const hiddenCount = allSessions.length - shownSessions.length;
            const mergeSel = this._vetMergeSel;
            const selCount = mergeSel && mergeSel.userId === rec.userId ? mergeSel.idx.size : 0;

            const sessionLines = shownSessions.map(({ s, idx }) => {
                const start = new Date(s.startedAt);
                const end = new Date(s.endedAt);
                const dateStr = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}-${String(start.getDate()).padStart(2,"0")}`;
                const startTime = `${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`;
                const endTime   = `${String(end.getHours()).padStart(2,"0")}:${String(end.getMinutes()).padStart(2,"0")}`;
                const dur = this.formatDuration(s.durationMs ?? (s.endedAt - s.startedAt));
                const guild = s.guildName || (s.guildId ? s.guildId.slice(-6) : "DM");
                const channel = s.channelName || (s.channelId ? s.channelId.slice(-6) : "—");
                const sessName = this._escape(s.username
                    ? (s.globalName && s.globalName !== s.username ? `${s.globalName} (${s.username})` : s.username)
                    : (s.globalName || "—"));
                const isSessExpanded = expandedSession &&
                    expandedSession.userId === rec.userId &&
                    expandedSession.sessionIndex === idx;
                const arrowS = isSessExpanded ? "▼" : "▶";
                const hasEvents = Array.isArray(s.events) && s.events.length > 0;
                const openLabel = hasEvents
                    ? (isSessExpanded ? "Hide" : "Timeline")
                    : "—";

                const isSel = !!(mergeSel && mergeSel.userId === rec.userId && mergeSel.idx.has(idx));
                const mergedNote = s.mergedFrom > 1 ? ` title="Merged from ${s.mergedFrom} sessions"` : "";
                return `<div class="vet-session-entry${isSessExpanded ? " expanded" : ""}${isSel ? " selected" : ""}"
                        data-user-id="${rec.userId}" data-session-idx="${idx}">
                    <span class="vet-session-pick" data-action="merge-toggle"
                        data-user-id="${rec.userId}" data-session-idx="${idx}"
                        title="Select for merge">${isSel ? "☑" : "☐"}</span>
                    <span class="vet-session-date"${mergedNote}>
                        <span class="vet-session-arrow">${arrowS}</span>${dateStr}
                    </span>
                    <span class="vet-session-time">${startTime} → ${endTime}</span>
                    <span class="vet-session-dur">${dur}</span>
                    <span class="vet-session-guild" title="${guild}">${guild}</span>
                    <span class="vet-session-channel" title="${channel}">${channel}</span>
                    <span class="vet-session-name" title="${sessName}">${sessName}</span>
                    <span class="vet-session-open">${openLabel}</span>
                </div>`;
            }).join("");

            const sessionsEmpty = allSessions.length === 0
                ? `<div class="vet-session-more">No sessions recorded.</div>`
                : "";

            const sessionsMore = hiddenCount > 0
                ? `<div class="vet-session-more">… and ${hiddenCount} more session${hiddenCount > 1 ? "s" : ""}</div>`
                : "";

            const expandedRow = `<tr class="vet-sessions-row" data-parent="${rec.userId}">
                <td colspan="10">
                    <div class="vet-sessions">
                        <div class="vet-sessions-header">Voice sessions (newest first) — click a session to see the state timeline, tick ☐ to merge
                            ${selCount > 0 ? `<span class="vet-merge-bar">
                                <button type="button" class="vet-btn" data-action="merge-apply" data-user-id="${rec.userId}"
                                    ${selCount < 2 ? "disabled" : ""}>Merge ${selCount} selected</button>
                                <button type="button" class="vet-btn" data-action="merge-clear" data-user-id="${rec.userId}">Clear</button>
                            </span>` : ""}
                        </div>
                        ${sessionLines || sessionsEmpty}
                        ${sessionsMore}
                    </div>
                </td>
            </tr>`;

            let timelineRow = "";
            if (expandedSession && expandedSession.userId === rec.userId) {
                const sIdx = expandedSession.sessionIndex;
                const sess = allSessions[sIdx];
                if (sess) timelineRow = this._renderTimeline(sess);
            }

            return mainRow + expandedRow + timelineRow;
        }).join("");

        tbody.innerHTML = html || `<tr><td colspan="10" class="vet-empty">No data yet.</td></tr>`;
    }

    // =====================================================================
    // Timeline with combo segments
    // =====================================================================

    _comboKey(f) {
        const active = [];
        if (f.serverDeaf) active.push("sd");
        if (f.serverMute && !f.serverDeaf) active.push("sm");
        if (f.selfDeaf) active.push("d");
        if (f.selfMute && !f.selfDeaf) active.push("m");
        if (f.streaming) active.push("s");
        if (f.video) active.push("v");
        if (active.length === 0) return "base";
        return active.join("+");
    }

    _comboColor(key) {
        if (key === "base") return "hsla(140, 40%, 40%, 0.25)";
        let h = 0;
        for (let i = 0; i < key.length; i++) {
            h = (h * 31 + key.charCodeAt(i)) & 0xffff;
        }
        const hue = h % 360;
        return `hsl(${hue}, 65%, 45%)`;
    }

    _comboLabel(key) {
        if (key === "base") return "base";
        const map = {
            sd: "server deaf",
            sm: "server mute",
            d:  "self deaf",
            m:  "self mute",
            s:  "streaming",
            v:  "camera"
        };
        return key.split("+").map(k => map[k] || k).join(" + ");
    }

    _renderTimeline(session) {
        const startedAt = session.startedAt;
        const endedAt   = session.endedAt;
        const totalMs   = endedAt - startedAt;
        const events    = Array.isArray(session.events) ? session.events : [];

        const sorted = events.slice().sort((a, b) => a.at - b.at);

        const changePoints = [startedAt];
        for (const ev of sorted) {
            if (ev.at > startedAt && ev.at < endedAt) {
                if (changePoints[changePoints.length - 1] !== ev.at) {
                    changePoints.push(ev.at);
                }
            }
        }
        changePoints.push(endedAt);

        const stateAt = (t) => {
            const flags = {
                serverDeaf: false, serverMute: false,
                selfDeaf:   false, selfMute:   false,
                streaming:  false, video:      false
            };
            for (const ev of sorted) {
                if (ev.at > t) break;
                if (ev.flag in flags) flags[ev.flag] = !!ev.value;
            }
            return flags;
        };

        const segments = [];
        for (let i = 0; i < changePoints.length - 1; i++) {
            const from = changePoints[i];
            const to = changePoints[i + 1];
            const dur = to - from;
            if (dur <= 0) continue;
            const f = stateAt(from);
            const key = this._comboKey(f);
            segments.push({ from, to, dur, key });
        }

        if (totalMs <= 0 || segments.length === 0) {
            return `<tr class="vet-timeline-row"><td colspan="10">
                <div class="vet-timeline">
                    <div class="vet-timeline-title">Timeline</div>
                    <div style="opacity:.5;font-size:11px">No state data for this session.</div>
                </div>
            </td></tr>`;
        }

        const segHtml = segments.map(seg => {
            const tooltip = `${this.formatTime(seg.from)} → ${this.formatTime(seg.to)} (${this.formatDuration(seg.dur)}) · ${this._comboLabel(seg.key)}`;
            const color = this._comboColor(seg.key);
            return `<div class="vet-timeline-seg" style="flex-grow:${seg.dur};background:${color}" title="${tooltip}"></div>`;
        }).join("");

        const seenKeys = [];
        const seenSet = new Set();
        for (const seg of segments) {
            if (seenSet.has(seg.key)) continue;
            seenSet.add(seg.key);
            seenKeys.push(seg.key);
        }
        const legendItems = seenKeys.map(key =>
            `<span><span class="dot" style="background:${this._comboColor(key)}"></span>${this._comboLabel(key)}</span>`
        ).join("");

        const legend = `<div class="vet-timeline-legend">${legendItems}</div>`;

        const evLines = [];
        evLines.push({ at: startedAt, label: "joined channel" });
        for (const ev of sorted) {
            const labelMap = {
                selfMute:   ev.value ? "self-muted"         : "self-unmuted",
                selfDeaf:   ev.value ? "self-deafened"      : "self-undeafened",
                serverMute: ev.value ? "server-muted"       : "server-unmuted",
                serverDeaf: ev.value ? "server-deafened"    : "server-undeafened",
                streaming:  ev.value ? "stream started"     : "stream stopped",
                video:      ev.value ? "camera on"          : "camera off"
            };
            evLines.push({ at: ev.at, label: labelMap[ev.flag] || ev.flag });
        }
        evLines.push({ at: endedAt, label: "left channel" });

        const evHtml = evLines.map((ev, i) => {
            const next = evLines[i + 1];
            const dur = next ? next.at - ev.at : 0;
            const durHtml = next ? `<span class="ev-dur">+${this.formatDuration(dur)}</span>` : "";
            return `<div>
                <span class="ev-time">${this.formatTime(ev.at)}</span>
                <span>${ev.label}</span>
                ${durHtml}
            </div>`;
        }).join("");

        return `<tr class="vet-timeline-row"><td colspan="10">
            <div class="vet-timeline">
                <div class="vet-timeline-title">Timeline — ${this.formatDuration(totalMs)} total</div>
                <div class="vet-timeline-bar">${segHtml}</div>
                ${legend}
                <div class="vet-timeline-events">${evHtml}</div>
            </div>
        </td></tr>`;
    }

    _waitForRelationshipState(userId, expected, callback, field = "blocked") {
        const start = Date.now();
        const tick = () => {
            let actual = false;
            try {
                const rel = BdApi.Webpack.getStore("RelationshipStore");
                if (field === "blocked") {
                    actual = (rel?.getBlockedIDs?.() ?? []).includes(userId);
                } else if (field === "ignored") {
                    actual = (rel?.getIgnoredIDs?.() ?? []).includes(userId);
                }
            } catch (e) {}

            if (actual === !!expected) {
                try { this.syncRelationshipLists(); } catch (e) {}
                callback();
                return;
            }
            if (Date.now() - start > 2000) {
                try { this.syncRelationshipLists(); } catch (e) {}
                callback();
                return;
            }
            setTimeout(tick, 100);
        };
        tick();
    }
};