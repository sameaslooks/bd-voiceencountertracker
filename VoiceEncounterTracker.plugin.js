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

        // Currently tracked voice sessions (built from VOICE_STATE_UPDATES).
        // userId -> { userId, channelId, guildId, startedAt, lastSeen }
        this.active = new Map();

        // Persistent encounter store.
        // userId -> {
        //   userId, username,
        //   firstSeenAt, lastSeenAt, totalMs, meetings,
        //   lastGuildId, lastChannelId, lastGuildName, lastChannelName,
        //   blocked, ignored, manual,
        //   sessions: [{ startedAt, endedAt, durationMs, guildId, guildName, channelId, channelName }]
        // }
        this.encounters = new Map();

        // DOM badge nodes: userId -> HTMLElement
        this.badgeNodes = new Map();
        // Saved inline styles on username elements so we can restore on stop().
        this.modifiedStyles = new Map();

        // Timer/listener registries — cleaned up in stop().
        this._timers = [];
        this._listeners = [];
        this._domNodes = [];

        // Local mute cache (userId set) — refreshed periodically.
        this._mutedCache = new Set();

        // Tunables
        this.HEARTBEAT_MS        = 60_000;
        this.SAVE_DEBOUNCE_MS    = 60_000;
        this.RECENT_MS           = 8 * 60 * 60_000;
        this.INJECT_THROTTLE_MS  = 250;
        this.REFRESH_MS          = 30_000;
        this.SPEAKING_MS         = 250;
        this.FULL_PUSH_MS        = 5_000;
        this.COMMAND_POLL_MS     = 1_000;
        this.MAX_SESSIONS        = 500;

        this.OVERLAY_URL = "http://127.0.0.1:17842";

        this.DEBUG = false;

        // Persistent user preferences.
        this.prefs = {
            autoMuteBlocked: false,
            hideMuteForBlocked: true
        };

        this.NATIVE_MUTE_STYLE_ID = "VoiceEncounterTracker-native-mute";
    }

    // =====================================================================
    // Lifecycle
    // =====================================================================

    start() {
        BdApi.Logger.info(this.meta.name, "Starting...");

        this.loadPrefs();
        this.loadEncounters();
        this.applyNativeMuteCss();
        this.syncRelationshipLists();
        this.syncMuteList();
        this.hookDispatcher();
        this.seedActiveSessions();

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
            try { this.pushSpeakingToOverlay(); } catch (e) {}
        }, this.SPEAKING_MS));

        this._addTimer(setInterval(() => {
            try { this.pollOverlayCommands(); } catch (e) {}
        }, this.COMMAND_POLL_MS));

        try { this.pushStateToOverlay(); } catch (e) {}
        try { this.pushSpeakingToOverlay(); } catch (e) {}

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

        try {
            this._postJSON("/state", {
                guildId: null, channelId: null, channelName: null, users: []
            });
            this._postJSON("/speaking", { speakers: [] });
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
    // Dispatcher hook
    // =====================================================================

    getDispatcher() {
        try {
            const store = BdApi.Webpack.getStore("VoiceStateStore");
            return store?._dispatcher ?? null;
        } catch { return null; }
    }

    getCurrentUserId() {
        try {
            return BdApi.Webpack.getStore("UserStore")?.getCurrentUser?.()?.id ?? null;
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
                }
            } catch (e) {}
        });

        BdApi.Logger.info(this.meta.name, "Dispatcher hooked.");
    }

    scheduleOverlayPush() {
        if (this._overlayDebounce) clearTimeout(this._overlayDebounce);
        this._overlayDebounce = this._addTimer(setTimeout(() => {
            try { this.pushStateToOverlay(); } catch (e) {}
        }, 500));
    }

    // =====================================================================
    // Relationships
    // =====================================================================

    handleRelationshipUpdate(action) {
        if (!this.prefs.autoMuteBlocked) return;

        const rel = action.relationship ?? action;
        const userId = rel?.id || rel?.userId || action.userId;
        const type = rel?.type;
        if (!userId) return;
        if (type !== 2) return; // 2 = BLOCKED

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
        try { rel = BdApi.Webpack.getStore("RelationshipStore"); } catch { return; }
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
        try { mes = BdApi.Webpack.getStore("MediaEngineStore"); } catch { return; }
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
    // Self session seeding
    // =====================================================================

    seedActiveSessions() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;

            const store = BdApi.Webpack.getStore("VoiceStateStore");
            if (!store) return;

            const guilds = BdApi.Webpack.getStore("GuildStore")?.getGuilds?.() ?? {};
            const now = Date.now();

            for (const guildId of Object.keys(guilds)) {
                const states = store.getVoiceStates?.(guildId) ?? {};
                for (const userId in states) {
                    const vs = states[userId];
                    if (!vs?.channelId) continue;

                    // Do not overwrite sessions that were already updated by a
                    // real VOICE_STATE_UPDATE — those are authoritative.
                    if (this.active.has(userId)) continue;

                    this.active.set(userId, {
                        userId,
                        channelId: vs.channelId,
                        guildId,
                        startedAt: now,
                        lastSeen: now,
                        seeded: true     // mark: not confirmed by a real update yet
                    });
                }
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "seedActiveSessions failed:", e);
        }
    }

    // =====================================================================
    // Voice session tracking
    // =====================================================================

    handleVoiceState(vs) {
        const { userId, channelId, guildId } = vs;
        if (!userId) return;

        const existing = this.active.get(userId);
        const now = Date.now();

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
            this.active.set(userId, {
                userId, channelId, guildId,
                startedAt: now, lastSeen: now,
                seeded: false
            });
            return;
        }

        if (!existing) {
            this.active.set(userId, {
                userId, channelId, guildId,
                startedAt: now, lastSeen: now,
                seeded: false
            });
        } else {
            existing.lastSeen = now;
            // A real VOICE_STATE_UPDATE for this user means our seeded session
            // (if any) is now authoritative.
            existing.seeded = false;
        }
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
    }

    // =====================================================================
    // Encounter recording
    // =====================================================================

    finalizeMeeting(userId, mySession, otherSession, endedAt) {
        if (!mySession || !otherSession) return;
        // Seeded sessions are placeholders — don't count them as real meetings.
        if (mySession.seeded || otherSession.seeded) return;
        if (mySession.channelId !== otherSession.channelId) return;

        const start = Math.max(mySession.startedAt, otherSession.startedAt);
        const end = Math.min(
            endedAt,
            otherSession.lastSeen ?? endedAt,
            mySession.lastSeen ?? endedAt
        );
        if (end <= start) return;

        this.recordEncounter(userId, otherSession.channelId, otherSession.guildId, start, end);
    }

    recordEncounter(userId, channelId, guildId, startedAt, endedAt) {
        if (endedAt <= startedAt) return;
        if (!guildId) return;

        // Never record sessions with ourselves.
        const me = this.getCurrentUserId();
        if (me && me === userId) return;

        const duration = endedAt - startedAt;
        const guildName = this.getGuildName(guildId);
        const channelName = this.getChannelName(channelId);

        const session = {
            startedAt, endedAt, durationMs: duration,
            guildId, guildName, channelId, channelName
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
                version: 2,
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
            const user = BdApi.Webpack.getStore("UserStore")?.getUser?.(userId);
            return user?.username ?? user?.globalName ?? "(unknown)";
        } catch { return "(unknown)"; }
    }

    getGuildName(guildId) {
        try {
            return BdApi.Webpack.getStore("GuildStore")?.getGuild?.(guildId)?.name ?? null;
        } catch { return null; }
    }

    getChannelName(channelId) {
        try {
            return BdApi.Webpack.getStore("ChannelStore")?.getChannel?.(channelId)?.name ?? null;
        } catch { return null; }
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
        if (this.isUserLocallyMuted(userId)) return "muted";
        if (!rec) return "stranger";
        // Known = we've met them a while ago (>= RECENT_MS).
        // Stranger = we're only just meeting them (< RECENT_MS), or never met.
        return this.isRecent(userId) ? "stranger" : "known";
    }

    formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
        if (m > 0) return `${m}m`;
        return `${s}s`;
    }

    formatDate(ts) {
        if (!ts) return "—";
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
               `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
                ? `Met ${rec.meetings}× · total ${this.formatDuration(rec.totalMs)} · last ${this.formatDate(rec.lastSeenAt)}`
                : "You've shared a voice channel with this user";
            color = "var(--text-positive, #3ba55d)"; opacity = "0.55";
        } else {
            glyph = "!";
            title = rec
                ? `Not seen recently (last ${this.formatDate(rec.lastSeenAt)})`
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
                    guildId: null, channelId: null, channelName: null, users: []
                });
                return;
            }

            const users = [];
            for (const [userId, s] of this.active) {
                if (s.channelId !== mySession.channelId) continue;

                const isSelf = userId === me;
                const kind = isSelf ? "known" : this.getBadgeKind(userId);
                const user = BdApi.Webpack.getStore("UserStore")?.getUser?.(userId);
                const rec = this.encounters.get(userId);

                users.push({
                    userId,
                    username: user?.username ?? user?.globalName ?? "(unknown)",
                    avatar: user?.avatar ?? null,
                    kind,
                    blocked: !!rec?.blocked,
                    ignored: !!rec?.ignored,
                    muted: isSelf ? false : this.isUserLocallyMuted(userId),
                    isSelf
                });
            }

            this._postJSON("/state", {
                guildId: mySession.guildId ?? null,
                channelId: mySession.channelId,
                channelName: this.getChannelName(mySession.channelId),
                guildName: this.getGuildName(mySession.guildId),
                users
            });
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

            // 1) Base list from SpeakingStore. This works for remote users,
            //    but in newer Discord builds it does NOT include the local user.
            let speakers = [];
            try {
                const ss = BdApi.Webpack.getStore("SpeakingStore");
                if (ss && typeof ss.getSpeakers === "function") {
                    speakers = ss.getSpeakers() ?? [];
                }
            } catch (e) {}

            // 2) DOM fallback for ourselves.
            //    Discord renders the speaking ring on our avatar using a
            //    box-shadow with var(--status-speaking). When silent, the
            //    shadow is fully transparent; when speaking it resolves to
            //    the green "status-speaking" color.
            try {
                const selfSpeaking = this._isSelfSpeakingFromDOM(me);
                if (selfSpeaking && !speakers.includes(me)) {
                    speakers = speakers.concat([me]);
                } else if (!selfSpeaking) {
                    speakers = speakers.filter(id => id !== me);
                }
            } catch (e) {}

            // 3) Filter to users in our channel (including ourselves).
            const inChannel = new Set();
            for (const [userId, s] of this.active) {
                if (s.channelId !== mySession.channelId) continue;
                inChannel.add(userId);
            }
            speakers = speakers.filter(id => inChannel.has(id));

            this._postJSON("/speaking", { speakers });
        } catch (e) {}
    }

    /**
     * Reads the current speaking state of our own avatar directly from
     * Discord's DOM. Discord reflects speaking via `box-shadow` containing
     * `var(--status-speaking)`, which resolves to green when speaking and
     * to a fully transparent color when silent.
     */
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

                // Strip out the fully-transparent entries — silent state only
                // consists of rgba(0, 0, 0, 0). Anything left means a real
                // color is being applied, which is the speaking indicator.
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
        const { action, userId } = cmd;
        if (!action || !userId) return;

        const rel = BdApi.Webpack.getByKeys("blockUser", "unblockUser", { searchExports: true });

        if (action === "block" && rel?.blockUser) rel.blockUser(userId);
        else if (action === "unblock" && rel?.unblockUser) rel.unblockUser(userId);
        else if (action === "ignore" && rel?.ignoreUser) rel.ignoreUser(userId);
        else if (action === "unignore" && rel?.unignoreUser) rel.unignoreUser(userId);
        else if (action === "mute") this.applyLocalMute(userId, true);
        else if (action === "unmute") this.applyLocalMute(userId, false);

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
        container.style.cssText = "padding:16px;color:var(--text-normal);font-size:14px";
        this.settingsContainer = container;
        this.renderSettings(container);
        return container;
    }

    renderSettings(container) {
        const entries = Array.from(this.encounters.values())
            .sort((a, b) => {
                const rank = r => r.blocked ? 0 : r.ignored ? 1 : 2;
                const ra = rank(a), rb = rank(b);
                if (ra !== rb) return ra - rb;
                return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
            });

        const rows = entries.map((rec, i) => {
            const username = this.getUserName(rec.userId);
            const kind = this.getBadgeKind(rec.userId);
            let glyph, glyphColor, status;
            if (kind === "blocked")      { glyph = "⊘"; glyphColor = "#ed4245"; status = "blocked"; }
            else if (kind === "ignored") { glyph = "⊘"; glyphColor = "#faa61a"; status = "ignored"; }
            else if (kind === "muted")   { glyph = "○"; glyphColor = "#72767d"; status = "muted"; }
            else if (kind === "known")   { glyph = "✓"; glyphColor = "#3ba55d"; status = "—"; }
            else                          { glyph = "!"; glyphColor = "#a3a6aa"; status = "—"; }

            return `<tr data-user-id="${rec.userId}">
                <td class="vet-num">${i + 1}</td>
                <td class="vet-name" title="${username} ${rec.userId}">${username}</td>
                <td class="vet-status" data-status="${status}">${status}</td>
                <td class="vet-num">${rec.totalMs ? this.formatDuration(rec.totalMs) : "—"}</td>
                <td class="vet-num">${rec.meetings || "—"}</td>
                <td class="vet-num">${(rec.sessions || []).length || "—"}</td>
                <td class="vet-date" title="${this.formatDate(rec.firstSeenAt)}">${this.formatDate(rec.firstSeenAt)}</td>
                <td class="vet-date" title="${this.formatDate(rec.lastSeenAt)}">${this.formatDate(rec.lastSeenAt)}</td>
                <td class="vet-badge" style="color:${glyphColor};font-weight:700">${glyph}</td>
                <td class="vet-actions">
                    <button type="button" class="vet-row-remove" data-action="remove" data-user-id="${rec.userId}"
                        title="Remove from history">×</button>
                </td>
            </tr>`;
        }).join("");

        const authorName = this.meta.author ?? "unknown";
        const authorUrl  = this.meta.authorLink ?? this.meta.website ?? null;
        const authorHtml = authorUrl
            ? `by <a href="${authorUrl}" target="_blank" rel="noopener noreferrer"
                    style="color:var(--text-link);text-decoration:none">${authorName}</a>`
            : `by ${authorName}`;

        container.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box">

                <!-- ─── Header: fixed, doesn't scroll ─── -->
                <div style="flex-shrink:0">
                    <h2 style="margin:0 0 4px 0">Voice Encounter Tracker</h2>
                    <p style="opacity:.7;margin:0 0 4px 0;font-size:13px">
                        ${authorHtml}
                        <span style="opacity:.5"> · v${this.meta.version ?? "?"}</span>
                    </p>
                    <p style="opacity:.7;margin:0 0 12px 0;font-size:13px">
                        Known users: <span data-role="count">${entries.length}</span>
                        · recent window: ${this.formatDuration(this.RECENT_MS)}
                    </p>

                    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;
                                padding:10px 12px;border:1px solid var(--background-modifier-accent);
                                border-radius:4px;background:var(--background-secondary)">
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                            <input type="checkbox" data-pref="autoMuteBlocked"
                                ${this.prefs.autoMuteBlocked ? "checked" : ""}>
                            <span>Auto-mute users when you block them</span>
                        </label>
                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                            <input type="checkbox" data-pref="hideMuteForBlocked"
                                ${this.prefs.hideMuteForBlocked ? "checked" : ""}>
                            <span>Hide Discord's mute icon for blocked / ignored users</span>
                        </label>
                    </div>

                    <div style="margin-bottom:14px;padding:10px 12px;
                                border:1px solid var(--background-modifier-accent);
                                border-radius:4px;background:var(--background-secondary)">
                        <div style="font-size:13px;margin-bottom:6px;opacity:.8">Add user manually</div>
                        <div style="display:flex;gap:6px">
                            <input type="text" data-role="manual-input"
                                placeholder="User ID or username"
                                style="flex:1;padding:6px 8px;font-size:13px;
                                    color:var(--text-normal);background:var(--background-primary);
                                    border:1px solid var(--background-modifier-accent);border-radius:4px;outline:none">
                            <button type="button" data-action="manual-add"
                                style="padding:6px 14px;font-size:13px;cursor:pointer;
                                    color:#fff;background:#5865f2;border:none;border-radius:4px">
                                Add
                            </button>
                        </div>
                        <div data-role="manual-status" style="font-size:12px;margin-top:6px;opacity:.7"></div>
                    </div>

                    <div style="margin-bottom:12px">
                        <button type="button" data-action="clear-all"
                            style="padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer;
                                color:var(--text-normal);background:var(--background-secondary);
                                border:1px solid var(--background-modifier-hover);border-radius:4px">
                            Clear Encounters
                        </button>
                    </div>
                </div>

                <!-- ─── Table wrapper: fills remaining space, scrolls both ways ─── -->
                <div style="flex:1 1 auto;min-height:0;overflow:auto;
                            border:1px solid var(--background-modifier-accent);border-radius:4px">
                    <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <thead>
                            <tr style="opacity:.6;border-bottom:1px solid var(--background-modifier-accent);
                                    position:sticky;top:0;background:var(--background-primary)">
                                <th class="vet-num">#</th>
                                <th>User</th>
                                <th>Status</th>
                                <th class="vet-num">Total</th>
                                <th class="vet-num">Meetings</th>
                                <th class="vet-num">Sessions</th>
                                <th>First seen</th>
                                <th>Last seen</th>
                                <th class="vet-badge">!</th>
                                <th class="vet-actions"></th>
                            </tr>
                        </thead>
                        <tbody>${rows || `<tr><td colspan="10" style="padding:8px;opacity:.5">No data yet.</td></tr>`}</tbody>
                    </table>
                </div>
            </div>

            <style>
                .vet-num, .vet-badge, .vet-actions { text-align: right; }
                .vet-badge { text-align: center; }
                .vet-num, .vet-badge, .vet-actions, td, th {
                    padding: 6px 8px;
                    white-space: nowrap;
                }
                .vet-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
                .vet-date { font-variant-numeric: tabular-nums; }
                .vet-status[data-status="blocked"] { color: #ed4245; font-weight: 600; }
                .vet-status[data-status="ignored"] { color: #faa61a; font-weight: 600; }
                .vet-status[data-status="muted"]   { color: #72767d; font-weight: 600; }
                .vet-row-remove {
                    background: transparent; border: none; color: #ed4245;
                    font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1;
                }
                .vet-row-remove:hover { color: #ff6b6e; }
            </style>
        `;

        container.querySelectorAll("input[data-pref]").forEach(cb => {
            this._addListener(cb, "change", () => {
                const key = cb.getAttribute("data-pref");
                this.prefs[key] = cb.checked;
                this.savePrefs();
                if (key === "hideMuteForBlocked") this.applyNativeMuteCss();
                try { this.injectBadges(); } catch (e) {}
            });
        });

        const clearBtn = container.querySelector("[data-action='clear-all']");
        if (clearBtn) {
            this._addListener(clearBtn, "click", (e) => {
                e.preventDefault(); e.stopPropagation();
                BdApi.UI.showConfirmationModal(
                    "Clear Encounters",
                    "Delete all stored voice encounter history? Blocked/ignored/muted users will be re-imported automatically.",
                    {
                        confirmText: "Delete",
                        cancelText: "Cancel",
                        danger: true,
                        onConfirm: () => {
                            this.encounters.clear();
                            if (this._mutedCache) this._mutedCache.clear();
                            if (this._saveDebounce) {
                                clearTimeout(this._saveDebounce);
                                this._saveDebounce = null;
                            }
                            try { BdApi.Data.delete(this.meta.name, this.getStoreKey()); } catch (e) {}
                            try { this.syncRelationshipLists(); } catch (e) {}
                            try { this.syncMuteList(); } catch (e) {}
                            try { this.scheduleOverlayPush(); } catch (e) {}
                            this.renderSettings(container);
                        }
                    }
                );
            });
        }

        const addBtn = container.querySelector("[data-action='manual-add']");
        const input  = container.querySelector("[data-role='manual-input']");
        const status = container.querySelector("[data-role='manual-status']");

        if (addBtn && input && status) {
            const doAdd = () => {
                const result = this.manualAddUser(input.value);
                if (result.ok) {
                    status.style.color = "#3ba55d";
                    status.textContent = result.existed
                        ? `Updated: ${result.user.username}`
                        : `Added: ${result.user.username}`;
                    input.value = "";
                    setTimeout(() => this.renderSettings(container), 600);
                } else {
                    status.style.color = "#ed4245";
                    status.textContent = result.reason === "not-found"
                        ? "User not found"
                        : result.reason === "empty"
                        ? "Enter a user ID or username"
                        : "Failed to add user";
                }
            };
            this._addListener(addBtn, "click", (e) => { e.preventDefault(); e.stopPropagation(); doAdd(); });
            this._addListener(input, "keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doAdd(); }
            });
        }

        container.querySelectorAll("[data-action='remove']").forEach(btn => {
            this._addListener(btn, "click", (e) => {
                e.preventDefault(); e.stopPropagation();
                const userId = btn.getAttribute("data-user-id");
                if (!userId) return;
                this.removeUser(userId);
                this.renderSettings(container);
            });
        });
    }
};