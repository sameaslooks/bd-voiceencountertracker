/**
 * @name VoiceEncounterTracker
 * @author sameaslooks
 * @authorLink https://github.com/sameaslooks
 * @version 1.0.0
 * @description Marks users you've shared a voice channel with, keeps encounter history, and drives a desktop overlay.
 * @source https://github.com/sameaslooks/bd-voiceencountertracker
 * @website https://github.com/sameaslooks
 */

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
        this.RECENT_MS           = 8 * 60 * 60_000;
        this.INJECT_THROTTLE_MS  = 250;
        this.REFRESH_MS          = 30_000;
        this.SPEAKING_MS         = 2000;
        this.FULL_PUSH_MS        = 5_000;
        this.PING_PUSH_MS        = 1000;
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
            showPingLost: true
        };

        this.NATIVE_MUTE_STYLE_ID = "VoiceEncounterTracker-native-mute";
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    start() {
        BdApi.Logger.info(this.meta.name, "Starting...");

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
                        BdApi.Logger.info(self.meta.name, "caught streamId from log:", m[1]);
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
                            BdApi.Logger.info(self.meta.name, "caught streamId from nz patch:", id);
                        }
                    } catch (e) {}
                });
                this._nzModule = nzMod;
                BdApi.Logger.info(this.meta.name, "nz patched");
            } else {
                BdApi.Logger.warn(this.meta.name, "nz module not found for patching");
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

        this._addTimer(setInterval(() => {
            try { this.pollOverlayCommands(); } catch (e) {}
        }, this.COMMAND_POLL_MS));

        try { this.pushStateToOverlay(); } catch (e) {}
        try { this.pushSpeakingToOverlay(); } catch (e) {}
        try { this.pushPingToOverlay(); } catch (e) {}

        BdApi.Logger.info(this.meta.name, "Started.");
    }

    stop() {
        BdApi.Logger.info(this.meta.name, "Stopping...");

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

        this.encounters.clear();
        this.modifiedStyles.clear();
        this._mutedCache.clear();

        BdApi.Logger.info(this.meta.name, "Stopped.");
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
                        BdApi.Logger.error(this.meta.name, "user-context patch error:", e);
                    }
                },
                this.meta.name
            );
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "patchUserContextMenu failed:", e);
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
            BdApi.Logger.error(this.meta.name, "Dispatcher not found.");
            return;
        }

        const self = this;
        BdApi.Patcher.after(this.meta.name, d, "dispatch", (_, args) => {
            const action = args?.[0];
            if (!action) return;
            try {
                if (action.type === "VOICE_STATE_UPDATES") {
                    for (const vs of (action.voiceStates ?? [])) {
                        try { self.handleVoiceState(vs); } catch (e) {}
                    }
                    if (self._injectDebounce) clearTimeout(self._injectDebounce);
                    self._injectDebounce = self._addTimer(setTimeout(() => {
                        try { self.injectBadges(); } catch (e) {}
                        try { self.pushStateToOverlay(); } catch (e) {}
                    }, self.INJECT_THROTTLE_MS));
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
                    action.type === "SPEAKING_START" ||
                    action.type === "SPEAKING_STOP" ||
                    action.type === "SPEAKING_STOP_USERS"
                ) {
                    try { self.pushSpeakingToOverlay(); } catch (e) {}
                }
            } catch (e) {}
        });

        BdApi.Logger.info(this.meta.name, "Dispatcher hooked.");
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
                            BdApi.Logger.info(self.meta.name, "srcObject captured", streamId || "(no id)");
                        }
                    } catch (e) {}
                    return origSet.call(this, v);
                }
            });
            BdApi.Logger.info(this.meta.name, "srcObject hooked");
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "hookSrcObject failed:", e);
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
                try {
                    const ch = (this._sc?.ChannelStore ?? BdApi.Webpack.getStore("ChannelStore"))?.getChannel?.(myChannelId);
                    myGuildId = ch?.guild_id ?? null;
                } catch (e) {}
            }

            if (!myChannelId || !myGuildId) return;

            let guildStates = null;

            try {
                if (typeof store.getVoiceStates === "function") {
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
                BdApi.Logger.info(this.meta.name, `syncActiveFromStore: seeded ${added} user(s)`);
            }
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "syncActiveFromStore:", e);
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
            if (existing) {
                this.closeSessionAndMeetings(userId, existing, now);
                this.active.delete(userId);
            }
            return;
        }

        if (!guildId) return;

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

    closeSessionAndMeetings(userId, session, endedAt) {
        const me = this.getCurrentUserId();
        if (!me) return;

        if (userId === me) {
            for (const [otherId, otherSession] of this.active) {
                if (otherId === me) continue;
                this.finalizeMeeting(otherId, session, otherSession, endedAt);
            }
        } else {
            const mySession = this.active.get(me);
            if (mySession) {
                this.finalizeMeeting(userId, mySession, session, endedAt);
            }
        }
    }

    heartbeat() {
        const now = Date.now();
        for (const s of this.active.values()) s.lastSeen = now;
        this._pruneGhosts();
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
                try { live = store.getVoiceState(s.guildId, userId); } catch (e) {}
                if (!live || live.channelId !== s.channelId) {
                    try { this.closeSessionAndMeetings(userId, s, now); } catch (e) {}
                    this.active.delete(userId);
                    continue;
                }
            } else {
                if (now - (s.lastSeen ?? now) > STALE_MS) {
                    try { this.closeSessionAndMeetings(userId, s, now); } catch (e) {}
                    this.active.delete(userId);
                }
            }
        }
    }

    // =====================================================================
    // Encounter recording
    // =====================================================================

    finalizeMeeting(userId, mySession, otherSession, endedAt) {
        if (!mySession || !otherSession) return;
        if (mySession.channelId !== otherSession.channelId) return;

        const start = Math.max(mySession.startedAt, otherSession.startedAt);
        const end = Math.min(
            endedAt,
            otherSession.lastSeen ?? endedAt,
            mySession.lastSeen ?? endedAt
        );
        if (end <= start) return;

        const rawEvents = Array.isArray(otherSession.events) ? otherSession.events : [];
        const events = rawEvents
            .filter(ev => ev.at >= start && ev.at <= end)
            .map(ev => ({ at: ev.at, flag: ev.flag, value: ev.value }));

        this.recordEncounter(userId, otherSession.channelId, otherSession.guildId, start, end, events);
    }

    recordEncounter(userId, channelId, guildId, startedAt, endedAt, events = []) {
        if (endedAt <= startedAt) return;
        if (!guildId) return;

        const me = this.getCurrentUserId();
        if (me && me === userId) return;

        const duration = endedAt - startedAt;
        const guildName = this.getGuildName(guildId);
        const channelName = this.getChannelName(channelId);

        const session = {
            startedAt, endedAt, durationMs: duration,
            guildId, guildName, channelId, channelName,
            events
        };

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
            if (!cur.username || cur.username === "(unknown)") {
                cur.username = this.getUserName(userId);
            }
            if (!Array.isArray(cur.sessions)) cur.sessions = [];
            cur.sessions.push(session);
            if (cur.sessions.length > this.MAX_SESSIONS) {
                cur.sessions.splice(0, cur.sessions.length - this.MAX_SESSIONS);
            }
        }

        this.scheduleSave();
    }

    // =====================================================================
    // Persistence
    // =====================================================================

    getStoreKey() { return "encounters"; }

    loadEncounters() {
        try {
            const data = BdApi.Data.load(this.meta.name, this.getStoreKey());
            const arr = Array.isArray(data?.users) ? data.users : [];
            this.encounters.clear();
            for (const rec of arr) {
                if (rec && rec.userId) {
                    if (!Array.isArray(rec.sessions)) rec.sessions = [];
                    for (const s of rec.sessions) {
                        if (!Array.isArray(s.events)) s.events = [];
                    }
                    this.encounters.set(rec.userId, rec);
                }
            }
        } catch (e) {
            this.encounters.clear();
        }
    }

    saveEncounters() {
        try {
            BdApi.Data.save(this.meta.name, this.getStoreKey(), {
                version: 3,
                users: Array.from(this.encounters.values())
            });
        } catch (e) {}
    }

    flushEncounters() { this.saveEncounters(); }

    scheduleSave() {
        if (this._saveDebounce) clearTimeout(this._saveDebounce);
        this._saveDebounce = this._addTimer(setTimeout(() => {
            try { this.flushEncounters(); } catch (e) {}
        }, this.SAVE_DEBOUNCE_MS));
    }

    // =====================================================================
    // Query helpers
    // =====================================================================

    getUserName(userId) {
        try {
            const user = (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getUser?.(userId);
            return user?.username ?? user?.globalName ?? "(unknown)";
        } catch { return "(unknown)"; }
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

    getGuildName(guildId) {
        try {
            return (this._sc?.GuildStore ?? BdApi.Webpack.getStore("GuildStore"))?.getGuild?.(guildId)?.name ?? null;
        } catch { return null; }
    }

    getChannelName(channelId) {
        try {
            return (this._sc?.ChannelStore ?? BdApi.Webpack.getStore("ChannelStore"))?.getChannel?.(channelId)?.name ?? null;
        } catch { return null; }
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
        if (!rec || !rec.lastSeenAt) return false;
        return (Date.now() - rec.lastSeenAt) <= this.RECENT_MS;
    }

    getBadgeKind(userId) {
        const rec = this.encounters.get(userId);
        if (rec?.blocked) return "blocked";
        if (rec?.ignored) return "ignored";
        if (rec?.manual) return "known";
        if (this.isUserLocallyMuted(userId)) return "muted";
        if (!rec) return "stranger";
        return this.isRecent(userId) ? "stranger" : "known";
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

            const usernameEl = row.querySelector("[class*='username__']");
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
                ? `New encounter · first seen ${this.formatDate(rec.firstSeenAt)}`
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
                    streamSound: null
                });
                return;
            }

            const guildId = mySession.guildId;
            const users = [];
            for (const [userId, s] of this.active) {
                if (s.channelId !== mySession.channelId) continue;

                const isSelf = userId === me;
                const kind = isSelf ? "known" : this.getBadgeKind(userId);
                const user = (this._sc?.UserStore ?? BdApi.Webpack.getStore("UserStore"))?.getUser?.(userId);
                const rec = this.encounters.get(userId);

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
                    serverDeafAt: s.serverDeafAt || 0
                });
            }

            this._postJSON("/state", {
                guildId: mySession.guildId ?? null,
                channelId: mySession.channelId,
                channelName: this.getChannelName(mySession.channelId),
                guildName: this.getGuildName(mySession.guildId),
                users,
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

    pollOverlayCommands() {
        try {
            BdApi.Net.fetch(`${this.OVERLAY_URL}/commands`, { method: "GET" })
                .then(r => r.json())
                .then(data => {
                    const cmds = Array.isArray(data?.commands) ? data.commands : [];
                    if (!cmds.length) return;
                    for (const cmd of cmds) {
                        try { this.executeOverlayCommand(cmd); } catch (e) {}
                        this._postJSON("/command-done", { id: cmd.id });
                    }
                })
                .catch(() => {});
        } catch (e) {}
    }

    executeOverlayCommand(cmd) {
        const { action, userId, sourceId, name } = cmd;
        if (!action) return;

        if (action === "watch-stream") {
            if (!userId) return;
            BdApi.Logger.info(this.meta.name, "watch-stream requested for", userId);
            this._watchStream(userId);
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

        if (!userId) return;

        const rel = BdApi.Webpack.getByKeys("blockUser", "unblockUser", { searchExports: true });

        if (action === "block" && rel?.blockUser) rel.blockUser(userId);
        else if (action === "unblock" && rel?.unblockUser) rel.unblockUser(userId);
        else if (action === "ignore" && rel?.ignoreUser) rel.ignoreUser(userId);
        else if (action === "unignore" && rel?.unignoreUser) rel.unignoreUser(userId);
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
        BdApi.Logger.warn(this.meta.name, "toggleSelfMute: not found");
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
        BdApi.Logger.warn(this.meta.name, "toggleSelfDeaf: not found");
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
                BdApi.Logger.warn(this.meta.name, "_startSelfStream: startStream not found");
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
                BdApi.Logger.warn(this.meta.name, "_startSelfStream: overlay /sources failed", e);
            }

            if (!Array.isArray(sources) || !sources.length) {
                BdApi.Logger.warn(this.meta.name, "_startSelfStream: no sources available");
                return false;
            }

            const pick =
                sources.find(s => s.id === preferredId) ||
                sources.find(s => s.id === "screen:0:0") ||
                sources.find(s => s.id.startsWith("screen:")) ||
                sources[0];

            if (!pick) {
                BdApi.Logger.warn(this.meta.name, "_startSelfStream: no source picked");
                return false;
            }

            let source;
            if (pick.id.startsWith("screen:")) {
                if (pick.handle == null) {
                    BdApi.Logger.warn(this.meta.name, "_startSelfStream: screen has no HMONITOR handle", pick);
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

            BdApi.Logger.info(this.meta.name, "_startSelfStream: using", source);

            await D(source).then(result => {
                BdApi.Logger.info(this.meta.name, "startStream result:", result);
                this._currentStreamSource = { id: source.id, name: source.name };
            }).catch(e => {
                BdApi.Logger.error(this.meta.name, "_startSelfStream:", e);
            });

            const desiredSound = this._pendingStreamSound !== undefined
                ? !!this._pendingStreamSound
                : true;
            setTimeout(() => {
                try { this._setStreamSound(desiredSound); } catch (e) {}
            }, 1500);

            return true;
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "_startSelfStream:", e);
            return false;
        }
    }

    _switchStreamSource(discordSourceId, name, soundArg = null) {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("setGoLiveSource", { searchExports: true });

            if (!mes || !actions?.setGoLiveSource) {
                BdApi.Logger.warn(this.meta.name, "_switchStreamSource: setGoLiveSource not found");
                return false;
            }

            const current = mes.getGoLiveSource?.();
            if (!current) {
                BdApi.Logger.info(this.meta.name, "_switchStreamSource: not streaming");
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

            BdApi.Logger.info(this.meta.name, "_switchStreamSource:", payload);
            actions.setGoLiveSource(payload);
            this._currentStreamSource = { id: discordSourceId, name: name || discordSourceId };
            return true;
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "_switchStreamSource:", e);
            return false;
        }
    }

    async _watchStream(userId) {
        try {
            const me = this.getCurrentUserId();
            const mySession = this.active.get(me);
            if (!mySession) {
                BdApi.Logger.warn(this.meta.name, "_watchStream: no own session");
                return false;
            }

            const streamKey = `guild:${mySession.guildId}:${mySession.channelId}:${userId}`;
            BdApi.Logger.info(this.meta.name, "_watchStream: key =", streamKey);

            this._postJSON("/video/open", { userId, streamKey });

            if (this._watchedUserId === userId && this._framePump) {
                BdApi.Logger.info(this.meta.name, "_watchStream: already watching, reusing");
                return true;
            }

            const stream = await this._watchStreamByUserId(userId);
            if (!stream) {
                BdApi.Logger.warn(this.meta.name, "_watchStream: no stream");
                return false;
            }

            this._watchedUserId = userId;
            await this._startWatchStreamPeer(stream);
            return true;
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "_watchStream:", e);
            return false;
        }
    }

    async _watchStreamByUserId(userId, { timeout = 20000 } = {}) {
        const me = this.getCurrentUserId();
        const mySession = this.active.get(me);
        if (!mySession) {
            BdApi.Logger.warn(this.meta.name, "_watchStreamByUserId: no own session");
            return null;
        }

        if (this._watchedUserId === userId) {
            const existing = this._findLiveVideoForStream();
            if (existing) {
                BdApi.Logger.info(this.meta.name, "_watchStreamByUserId: already live, reusing");
                const track = existing.srcObject.getVideoTracks()[0];
                try { return new MediaStream([track.clone()]); }
                catch { return new MediaStream([track]); }
            }
        }

        const before = new Set(document.querySelectorAll("video"));

        const streamWatch = BdApi.Webpack.getByStrings("STREAM_WATCH", "allowMultiple", { searchExports: true });
        if (typeof streamWatch !== "function") {
            BdApi.Logger.error(this.meta.name, "_watchStreamByUserId: streamWatch not found");
            return null;
        }
        try {
            streamWatch({
                streamType: "guild",
                guildId: mySession.guildId,
                channelId: mySession.channelId,
                ownerId: userId,
            });
            BdApi.Logger.info(this.meta.name, "STREAM_WATCH dispatched for", userId);
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "streamWatch failed:", e);
            return null;
        }

        const video = await this._waitForLiveVideo(timeout, before);
        if (!video) {
            BdApi.Logger.warn(this.meta.name, "no live video appeared");
            return null;
        }

        const streamId = this._extractStreamId(video);
        if (streamId) {
            BdApi.Logger.info(this.meta.name, "streamId =", streamId);

            const nz = this._findNzFunction();
            if (typeof nz === "function") {
                try {
                    const handle = nz(streamId);
                    if (handle && handle.stream) {
                        this._nativeStreamHandle = handle;
                        const nativeTrack = handle.stream.getVideoTracks()[0];
                        if (nativeTrack) {
                            BdApi.Logger.info(
                                this.meta.name,
                                "native track:",
                                nativeTrack.readyState,
                                "muted:", nativeTrack.muted,
                                "label:", nativeTrack.label
                            );
                            BdApi.Logger.info(this.meta.name, "returning original native track (no clone)");
                            return new MediaStream([nativeTrack]);
                        }
                    }
                } catch (e) {
                    BdApi.Logger.warn(this.meta.name, "nz failed, falling back:", e);
                }
            }
        } else {
            BdApi.Logger.warn(this.meta.name, "no streamId — falling back to srcObject clone");
        }

        const track = video.srcObject?.getVideoTracks?.()[0];
        if (!track) {
            BdApi.Logger.error(this.meta.name, "no video track on fallback");
            return null;
        }
        let liveTrack = track;
        const t0 = Date.now();
        while (liveTrack.readyState !== "live" && Date.now() - t0 < 3000) {
            await new Promise(r => setTimeout(r, 100));
        }
        try {
            const cloned = liveTrack.clone();
            BdApi.Logger.info(this.meta.name, "fallback cloned track:", cloned.readyState);
            return new MediaStream([cloned]);
        } catch (e) {
            BdApi.Logger.info(this.meta.name, "fallback without clone:", liveTrack.readyState);
            return new MediaStream([liveTrack]);
        }
    }

    _extractStreamId(video) {
        if (this._lastDiscordStreamId) {
            BdApi.Logger.info(this.meta.name, "_extractStreamId: using nz-patched streamId:",
                this._lastDiscordStreamId);
            return String(this._lastDiscordStreamId);
        }
        BdApi.Logger.warn(this.meta.name, "_extractStreamId: no streamId from nz patch");
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
        this._stopFramePump();

        const pc = new RTCPeerConnection({ iceServers: [] });
        this._watchPeer = pc;

        pc.onconnectionstatechange = () => {
            BdApi.Logger.info(this.meta.name, "watch peer state:", pc.connectionState);
            if (pc.connectionState === "failed") {
                BdApi.Logger.warn(this.meta.name, "watch peer failed");
            }
        };

        for (const track of stream.getTracks()) {
            pc.addTrack(track, stream);
        }

        try {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = 20_000_000;
                params.encodings[0].networkPriority = "high";
                params.encodings[0].priority = "high";
                params.encodings[0].degradationPreference = "maintain-framerate";
                await sender.setParameters(params);
                BdApi.Logger.info(this.meta.name, "sender tuned (pre-offer):",
                    JSON.stringify(params.encodings[0]));
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "pre-offer setParameters failed:", e.message);
        }

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
        BdApi.Logger.info(this.meta.name, "watch peer: offer sent");

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
            BdApi.Logger.warn(this.meta.name, "watch peer: no answer from viewer");
            try { pc.close(); } catch (e) {}
            this._watchPeer = null;
            return false;
        }

        try {
            await pc.setRemoteDescription(answer);
            BdApi.Logger.info(this.meta.name, "watch peer: answer applied");
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "setRemoteDescription failed:", e);
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
                params.encodings[0].maxBitrate = 20_000_000;
                params.encodings[0].degradationPreference = "maintain-framerate";
                params.encodings[0].networkPriority = "high";
                params.encodings[0].priority = "high";
                await sender.setParameters(params);
                setInterval(async () => {
                    try {
                        const stats = await pc.getStats();
                        stats.forEach(r => {
                            if (r.type === "outbound-rtp" && r.kind === "video") {
                                console.log("[sender]", {
                                    fps: r.framesPerSecond,
                                    bitrate: r.targetBitrate,
                                    dropped: r.framesDropped,
                                    encoded: r.framesEncoded,
                                    packetsSent: r.packetsSent,
                                    retransmits: r.retransmittedPacketsSent,
                                    nackCount: r.nackCount,
                                });
                            }
                        });
                    } catch (e) {}
                }, 1000);
                BdApi.Logger.info(this.meta.name, "sender tuned:", JSON.stringify(params.encodings[0]));
            } else {
                BdApi.Logger.warn(this.meta.name, "sender tuned: no video sender");
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "sender.setParameters failed:", e.message);
        }

        this._framePump = {
            stop: () => {
                try { pc.close(); } catch (e) {}
                this._watchPeer = null;
                this._framePump = null;
            }
        };

        BdApi.Logger.info(this.meta.name, "watch peer started");
        return true;
    }

    _stopFramePump() {
        if (this._framePump) {
            this._framePump.stop();
            BdApi.Logger.info(this.meta.name, "frame pump stopped");
        }
        if (this._nativeStreamHandle) {
            try { this._nativeStreamHandle.release(); } catch (e) {}
            this._nativeStreamHandle = null;
        }
        this._watchedUserId = null;
    }

    _setStreamSound(enabled) {
        try {
            const mes = BdApi.Webpack.getByKeys("getGoLiveSource", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("setGoLiveSource", { searchExports: true });

            if (!mes || !actions?.setGoLiveSource) {
                BdApi.Logger.warn(this.meta.name, "_setStreamSound: setGoLiveSource not found");
                return false;
            }

            const current = mes.getGoLiveSource?.();
            if (!current) {
                this._pendingStreamSound = !!enabled;
                BdApi.Logger.info(this.meta.name, "_setStreamSound: not streaming, saved");
                return false;
            }

            if (!current.desktopSource?.id) {
                BdApi.Logger.warn(this.meta.name, "_setStreamSound: no desktopSource.id");
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
                    BdApi.Logger.info(this.meta.name, "_setStreamSound: dispatched STREAM_UPDATE_SETTINGS", soundBool);
                }
            } catch (e) {
                BdApi.Logger.warn(this.meta.name, "_setStreamSound: STREAM_UPDATE_SETTINGS failed", e);
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

            BdApi.Logger.info(this.meta.name, "_setStreamSound:", payload);
            actions.setGoLiveSource(payload);
            return true;
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "_setStreamSound:", e);
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
        BdApi.Logger.warn(this.meta.name, "_stopSelfStream: button not found");
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
                .vet-session-entry {
                    display: grid;
                    grid-template-columns: 90px 140px 80px minmax(140px, 1fr) minmax(120px, 1fr) 90px;
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
                    </div>

                    <div class="vet-search">
                        <input type="text" class="vet-input" data-role="search-input"
                            placeholder="Search by name, username or user ID"
                            autocomplete="off" spellcheck="false">
                        <button type="button" class="vet-btn" data-action="search-clear">Clear</button>
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
                                    <th>User</th>
                                    <th>User ID</th>
                                    <th>Status</th>
                                    <th class="vet-num">Total</th>
                                    <th class="vet-num">Sessions</th>
                                    <th>First seen</th>
                                    <th>Last seen</th>
                                    <th class="vet-badge">!</th>
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
            BdApi.UI.showConfirmationModal(
                "Clear Encounters",
                "Delete all stored voice encounter history? Blocked / ignored / muted users will be re-imported automatically.",
                {
                    confirmText: "Delete", cancelText: "Cancel", danger: true,
                    onConfirm: () => {
                        this.encounters.clear();
                        if (this._mutedCache) this._mutedCache.clear();
                        if (this._saveDebounce) { clearTimeout(this._saveDebounce); this._saveDebounce = null; }
                        try { BdApi.Data.delete(this.meta.name, this.getStoreKey()); } catch (e) {}
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

        overlay.querySelector("[data-role='tbody']").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]");
            if (btn) {
                const action = btn.getAttribute("data-action");
                const userId = btn.getAttribute("data-user-id");
                if (!action || !userId) return;
                e.preventDefault(); e.stopPropagation();

                const rel = BdApi.Webpack.getByKeys("blockUser", "unblockUser", { searchExports: true });
                const rec = this.encounters.get(userId);

                if (action === "history") {
                    this._vetExpandedUser = this._vetExpandedUser === userId ? null : userId;
                    this._vetExpandedSession = null;
                    rerender();
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

        const query = (this._vetSearchQuery || "").trim().toLowerCase();
        if (query) {
            entries = entries.filter(rec => {
                const uid = String(rec.userId || "").toLowerCase();
                const uname = this.getUserName(rec.userId).toLowerCase();
                const disp = this.getDisplayName(rec.userId, null).toLowerCase();
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

        const tbody = overlay.querySelector("[data-role='tbody']");
        if (!tbody) return;

        const expandedId = this._vetExpandedUser;
        const expandedSession = this._vetExpandedSession;

        const html = entries.map((rec, i) => {
            const username = this.getUserName(rec.userId);
            const kind = this.getBadgeKind(rec.userId);
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

            const mainRow = `<tr class="vet-main-row${isExpanded ? " expanded" : ""}" data-user-id="${rec.userId}">
                <td class="vet-num">${i + 1}</td>
                <td class="vet-name" title="${username} (${rec.userId})">
                    <span class="vet-expand-arrow">${arrow}</span>${username}
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
                    <button type="button" class="vet-btn remove"
                        data-action="remove" data-user-id="${rec.userId}"
                        title="Remove from history">Remove</button>
                </td>
            </tr>`;

            if (!isExpanded) return mainRow;

            const allSessions = Array.isArray(rec.sessions) ? rec.sessions : [];
            const shownSessions = allSessions
                .map((s, idx) => ({ s, idx }))
                .reverse()
                .slice(0, 20);

            const hiddenCount = allSessions.length - shownSessions.length;

            const sessionLines = shownSessions.map(({ s, idx }) => {
                const start = new Date(s.startedAt);
                const end = new Date(s.endedAt);
                const dateStr = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}-${String(start.getDate()).padStart(2,"0")}`;
                const startTime = `${String(start.getHours()).padStart(2,"0")}:${String(start.getMinutes()).padStart(2,"0")}`;
                const endTime   = `${String(end.getHours()).padStart(2,"0")}:${String(end.getMinutes()).padStart(2,"0")}`;
                const dur = this.formatDuration(s.durationMs ?? (s.endedAt - s.startedAt));
                const guild = s.guildName || (s.guildId ? s.guildId.slice(-6) : "—");
                const channel = s.channelName || (s.channelId ? s.channelId.slice(-6) : "—");
                const isSessExpanded = expandedSession &&
                    expandedSession.userId === rec.userId &&
                    expandedSession.sessionIndex === idx;
                const arrowS = isSessExpanded ? "▼" : "▶";
                const hasEvents = Array.isArray(s.events) && s.events.length > 0;
                const openLabel = hasEvents
                    ? (isSessExpanded ? "Hide" : "Timeline")
                    : "—";

                return `<div class="vet-session-entry${isSessExpanded ? " expanded" : ""}"
                        data-user-id="${rec.userId}" data-session-idx="${idx}">
                    <span class="vet-session-date">
                        <span class="vet-session-arrow">${arrowS}</span>${dateStr}
                    </span>
                    <span class="vet-session-time">${startTime} → ${endTime}</span>
                    <span class="vet-session-dur">${dur}</span>
                    <span class="vet-session-guild" title="${guild}">${guild}</span>
                    <span class="vet-session-channel" title="${channel}">${channel}</span>
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
                        <div class="vet-sessions-header">Voice sessions (newest first) — click a session to see the state timeline</div>
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