/**
 * @name VoiceEncounterTracker
 * @author sameaslooks
 * @authorLink https://github.com/sameaslooks
 * @version 1.0.0
 * @description Marks users you've shared a voice channel with, and keeps a persistent encounter history.
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

        this._saveDebounce = null;
        this._injectDebounce = null;
        this._heartbeatTimer = null;
        this._refreshTimer = null;

        this.settingsContainer = null;

        this.HEARTBEAT_MS       = 60_000;
        this.SAVE_DEBOUNCE_MS   = 60_000;
        this.RECENT_MS          = 8 * 60 * 60_000;
        this.INJECT_THROTTLE_MS = 250;
        this.REFRESH_MS         = 30_000;

        this.DEBUG              = false;

        // Persistent user preferences.
        this.prefs = {
            autoMuteBlocked: false,   // auto-mute user when blocked
            hideMuteForBlocked: true  // hide Discord's native mute icon for blocked/ignored
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
        this.seedSelfSession();

        this._heartbeatTimer = setInterval(() => {
            try { this.heartbeat(); } catch (e) {}
        }, this.HEARTBEAT_MS);

        this._refreshTimer = setInterval(() => {
            try {
                this.syncMuteList();
                this.injectBadges();
            } catch (e) {}
        }, this.REFRESH_MS);

        BdApi.Logger.info(this.meta.name, "Started.");
    }

    stop() {
        BdApi.Logger.info(this.meta.name, "Stopping...");

        if (this._saveDebounce)   clearTimeout(this._saveDebounce);
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
        if (this._refreshTimer)   clearInterval(this._refreshTimer);
        if (this._injectDebounce) clearTimeout(this._injectDebounce);

        this._saveDebounce = null;
        this._heartbeatTimer = null;
        this._refreshTimer = null;
        this._injectDebounce = null;

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

        try { BdApi.DOM.removeStyle(this.NATIVE_MUTE_STYLE_ID); } catch (e) {}
        try { BdApi.Patcher.unpatchAll(this.meta.name); } catch (e) {}

        this.encounters.clear();
        this.modifiedStyles.clear();
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
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "loadPrefs failed:", e);
        }
    }

    savePrefs() {
        try {
            BdApi.Data.save(this.meta.name, "prefs", this.prefs);
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "savePrefs failed:", e);
        }
    }

    /**
     * Applies or removes the CSS rule that hides Discord's native mute icon
     * for users marked as blocked/ignored by us.
     *
     * Uses BdApi.DOM.addStyle so the CSS lives as long as the plugin is
     * enabled, independent of whether the settings panel is open.
     */
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
        } catch {
            return null;
        }
    }

    getCurrentUserId() {
        try {
            return BdApi.Webpack.getStore("UserStore")?.getCurrentUser?.()?.id ?? null;
        } catch {
            return null;
        }
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
                    self._injectDebounce = setTimeout(() => {
                        try { self.injectBadges(); } catch (e) {}
                    }, self.INJECT_THROTTLE_MS);
                } else if (
                    action.type === "RELATIONSHIP_ADD" ||
                    action.type === "RELATIONSHIP_REMOVE" ||
                    action.type === "RELATIONSHIP_UPDATE"
                ) {
                    try { self.handleRelationshipUpdate(action); } catch (e) {}
                    try { self.syncRelationshipLists(); } catch (e) {}
                    try { self.injectBadges(); } catch (e) {}
                } else if (
                    action.type === "AUDIO_TOGGLE_LOCAL_MUTE" ||
                    action.type === "MEDIA_ENGINE_SETTINGS_UPDATE" ||
                    action.type === "AUDIO_SETTINGS_UPDATE"
                ) {
                    try { self.syncMuteList(); } catch (e) {}
                    try { self.injectBadges(); } catch (e) {}
                }
            } catch (e) {
                BdApi.Logger.error(self.meta.name, "dispatch hook error:", e);
            }
        });

        BdApi.Logger.info(this.meta.name, "Dispatcher hooked.");
    }

    // =====================================================================
    // Relationship handling (incl. optional auto-mute)
    // =====================================================================

    /**
     * On RELATIONSHIP_* if the user just got blocked AND auto-mute is
     * enabled, we also mute them locally. On unblock we do nothing —
     * a manual mute the user set themselves stays.
     */
    handleRelationshipUpdate(action) {
        if (!this.prefs.autoMuteBlocked) return;

        const rel = action.relationship ?? action;
        const userId = rel?.id || rel?.userId || action.userId;
        const type = rel?.type;
        if (!userId) return;

        const isBlocked = type === 2;   // RelationshipTypes.BLOCKED
        if (!isBlocked) return;

        setTimeout(() => {
            try { this.applyLocalMute(userId, true); } catch (e) {}
        }, 500);
    }

    /**
     * Discord's MediaEngineStore only exposes `isLocalMute(userId)` for
     * reading. Writing goes through an action creator `toggleLocalMute(
     * userId)` on a separate module (found via getByKeys). Because it's a
     * toggle, we compare current state first and only toggle if needed.
     */
    applyLocalMute(userId, muted) {
        try {
            const mes = BdApi.Webpack.getStore("MediaEngineStore");
            if (!mes || typeof mes.isLocalMute !== "function") return false;

            const currentlyMuted = mes.isLocalMute(userId) === true;
            if (currentlyMuted === !!muted) return true; // already in desired state

            const mod = BdApi.Webpack.getByKeys("toggleLocalMute", { searchExports: true });
            if (!mod || typeof mod.toggleLocalMute !== "function") {
                BdApi.Logger.warn(this.meta.name,
                    "toggleLocalMute action not found — cannot auto-mute.");
                return false;
            }
            mod.toggleLocalMute(userId);
            return true;
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "applyLocalMute failed:", e);
            return false;
        }
    }

    // =====================================================================
    // Relationship lists (blocked / ignored)
    // =====================================================================

    syncRelationshipLists() {
        let rel;
        try {
            rel = BdApi.Webpack.getStore("RelationshipStore");
        } catch { return; }
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
                    firstSeenAt: 0,
                    lastSeenAt: 0,
                    totalMs: 0,
                    meetings: 0,
                    lastGuildId: null,
                    lastChannelId: null,
                    blocked: isBlocked,
                    ignored: !isBlocked
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
            }
        }

        for (const [id, rec] of this.encounters) {
            if (allKnownIds.has(id)) continue;
            if (rec.blocked || rec.ignored) {
                const hadNoHistory = !rec.totalMs && !rec.firstSeenAt;
                if (hadNoHistory) {
                    this.encounters.delete(id);
                } else {
                    rec.blocked = false;
                    rec.ignored = false;
                }
                changed = true;
            }
        }

        if (changed) {
            BdApi.Logger.info(this.meta.name,
                `Relationship sync: ${blocked.size} blocked, ${ignored.size} ignored.`);
            this.scheduleSave();
        }
    }

    // =====================================================================
    // Local mute sync
    // =====================================================================

    syncMuteList() {
        let mes;
        try {
            mes = BdApi.Webpack.getStore("MediaEngineStore");
        } catch { return; }
        if (!mes || typeof mes.isLocalMute !== "function") return;

        if (!this._mutedCache) this._mutedCache = new Set();

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
            try {
                if (mes.isLocalMute(id) === true) newCache.add(id);
            } catch (e) {}
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
    // Seed ONLY our own current voice session
    // =====================================================================

    seedSelfSession() {
        try {
            const me = this.getCurrentUserId();
            if (!me) return;

            const store = BdApi.Webpack.getStore("VoiceStateStore");
            if (!store || typeof store.getVoiceState !== "function") return;

            const guilds = BdApi.Webpack.getStore("GuildStore")?.getGuilds?.() ?? {};
            const now = Date.now();

            for (const guildId of Object.keys(guilds)) {
                const vs = store.getVoiceState(guildId, me);
                if (vs?.channelId) {
                    this.active.set(me, {
                        userId: me,
                        channelId: vs.channelId,
                        guildId,
                        startedAt: now,
                        lastSeen: now
                    });
                    BdApi.Logger.info(this.meta.name,
                        `Seeded self session: guild=${guildId} channel=${vs.channelId}`);
                    return;
                }
            }
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "seedSelfSession failed:", e);
        }
    }

    // =====================================================================
    // Active session tracking
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
                startedAt: now,
                lastSeen: now
            });
            return;
        }

        if (!existing) {
            this.active.set(userId, {
                userId, channelId, guildId,
                startedAt: now,
                lastSeen: now
            });
        } else {
            existing.lastSeen = now;
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

        if (mySession.channelId !== otherSession.channelId) {
            if (this.DEBUG) {
                BdApi.Logger.info(this.meta.name,
                    `[skip] ${userId}: channel mismatch`);
            }
            return;
        }

        const start = Math.max(mySession.startedAt, otherSession.startedAt);
        const end   = Math.min(
            endedAt,
            otherSession.lastSeen ?? endedAt,
            mySession.lastSeen ?? endedAt
        );

        if (end <= start) {
            if (this.DEBUG) {
                BdApi.Logger.info(this.meta.name, `[skip] ${userId}: no time overlap`);
            }
            return;
        }

        if (this.DEBUG) {
            BdApi.Logger.info(this.meta.name,
                `[record] ${userId} in channel ${otherSession.channelId} ` +
                `for ${Math.round((end - start) / 1000)}s`);
        }

        this.recordEncounter(
            userId,
            otherSession.channelId,
            otherSession.guildId,
            start,
            end
        );
    }

    recordEncounter(userId, channelId, guildId, startedAt, endedAt) {
        if (endedAt <= startedAt) return;
        if (!guildId) return;

        const me = this.getCurrentUserId();
        if (me && me === userId) return;

        const duration = endedAt - startedAt;
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
                lastChannelId: channelId
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
            if (!cur.username || cur.username === "(unknown)") {
                cur.username = this.getUserName(userId);
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
                if (rec && rec.userId) this.encounters.set(rec.userId, rec);
            }
            BdApi.Logger.info(this.meta.name, `Loaded ${this.encounters.size} encounter records.`);
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "loadEncounters failed:", e);
            this.encounters.clear();
        }
    }

    saveEncounters() {
        try {
            BdApi.Data.save(this.meta.name, this.getStoreKey(), {
                version: 1,
                users: Array.from(this.encounters.values())
            });
        } catch (e) {
            BdApi.Logger.error(this.meta.name, "saveEncounters failed:", e);
        }
    }

    flushEncounters() { this.saveEncounters(); }

    scheduleSave() {
        if (this._saveDebounce) clearTimeout(this._saveDebounce);
        this._saveDebounce = setTimeout(() => {
            try { this.flushEncounters(); } catch (e) {}
        }, this.SAVE_DEBOUNCE_MS);
    }

    clearAllEncounters() {
        this.encounters.clear();
        if (this._mutedCache) this._mutedCache.clear();

        if (this._saveDebounce) {
            clearTimeout(this._saveDebounce);
            this._saveDebounce = null;
        }
        try {
            BdApi.Data.delete(this.meta.name, this.getStoreKey());
        } catch (e) {
            BdApi.Logger.warn(this.meta.name, "clearAllEncounters: delete failed:", e);
        }

        for (const node of this.badgeNodes.values()) {
            try { node.remove(); } catch (e) {}
        }
        this.badgeNodes.clear();
        document.querySelectorAll("[data-vet-badge]").forEach(el => el.remove());
        this.restoreModifiedStyles();

        try { this.syncRelationshipLists(); } catch (e) {}
        try { this.syncMuteList(); } catch (e) {}
        try { this.injectBadges(); } catch (e) {}
    }

    // =====================================================================
    // Query helpers
    // =====================================================================

    getUserName(userId) {
        try {
            const user = BdApi.Webpack.getStore("UserStore")?.getUser?.(userId);
            return user?.username ?? user?.globalName ?? "(unknown)";
        } catch {
            return "(unknown)";
        }
    }

    isRecent(userId) {
        const rec = this.encounters.get(userId);
        if (!rec || !rec.lastSeenAt) return false;
        return (Date.now() - rec.lastSeenAt) <= this.RECENT_MS;
    }

    hasMet(userId) { return this.encounters.has(userId); }

    /**
     * Priority: blocked > ignored > muted > known > stranger.
     * `hideMuteForBlocked` affects the *native* Discord mute icon (handled
     * via CSS), not our own badge — our badge already prioritizes
     * blocked/ignored over muted.
     */
    getBadgeKind(userId) {
        const rec = this.encounters.get(userId);
        if (rec?.blocked) return "blocked";
        if (rec?.ignored) return "ignored";

        const muted = this.isUserLocallyMuted(userId);
        if (muted) return "muted";

        if (!rec) return "stranger";
        return this.isRecent(userId) ? "known" : "stranger";
    }

    formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
        if (m > 0) return `${m}m`;
        return `${totalSec}s`;
    }

    formatDate(ts) {
        if (!ts) return "—";
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
               `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    // =====================================================================
    // DOM injection
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
            glyph = "⊘";
            title = "Blocked user";
            color = "var(--status-danger, #ed4245)";
            opacity = "0.75";
        } else if (kind === "ignored") {
            glyph = "⊘";
            title = "Ignored user";
            color = "var(--text-warning, #faa61a)";
            opacity = "0.65";
        } else if (kind === "muted") {
            glyph = "○";
            title = "You muted this user in voice";
            color = "#72767d";
            opacity = "0.55";
        } else if (kind === "known") {
            glyph = "✓";
            title = rec
                ? `Met ${rec.meetings}× · total ${this.formatDuration(rec.totalMs)} · last ${this.formatDate(rec.lastSeenAt)}`
                : "You've shared a voice channel with this user";
            color = "var(--text-positive, #3ba55d)";
            opacity = "0.55";
        } else {
            glyph = "!";
            title = rec
                ? `Not seen recently (last ${this.formatDate(rec.lastSeenAt)})`
                : "You've never shared a voice channel with this user";
            color = "var(--text-muted, #a3a6aa)";
            opacity = "0.40";
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
            if (kind === "blocked")     { glyph = "⊘"; glyphColor = "#ed4245"; status = "blocked"; }
            else if (kind === "ignored") { glyph = "⊘"; glyphColor = "#faa61a"; status = "ignored"; }
            else if (kind === "muted")   { glyph = "○"; glyphColor = "#72767d"; status = "muted"; }
            else if (kind === "known")   { glyph = "✓"; glyphColor = "#3ba55d"; status = "—"; }
            else                          { glyph = "!"; glyphColor = "#a3a6aa"; status = "—"; }

            return `<tr>
                <td class="vet-num">${i + 1}</td>
                <td class="vet-name" title="${username}">${username}</td>
                <td class="vet-id" title="${rec.userId}">${rec.userId}</td>
                <td class="vet-status" data-status="${status}">${status}</td>
                <td class="vet-num">${rec.totalMs ? this.formatDuration(rec.totalMs) : "—"}</td>
                <td class="vet-num">${rec.meetings || "—"}</td>
                <td class="vet-date" title="${this.formatDate(rec.firstSeenAt)}">${this.formatDate(rec.firstSeenAt)}</td>
                <td class="vet-date" title="${this.formatDate(rec.lastSeenAt)}">${this.formatDate(rec.lastSeenAt)}</td>
                <td class="vet-badge" style="color:${glyphColor};font-weight:700">${glyph}</td>
            </tr>`;
        }).join("");

        const authorName = this.meta.author ?? "unknown";
        const authorUrl  = this.meta.authorLink ?? this.meta.website ?? null;
        const authorHtml = authorUrl
            ? `by <a href="${authorUrl}" target="_blank" rel="noopener noreferrer"
                    style="color:var(--text-link);text-decoration:none"
                    onmouseover="this.style.textDecoration='underline'"
                    onmouseout="this.style.textDecoration='none'"
                 >${authorName}</a>`
            : `by ${authorName}`;

        container.innerHTML = `
            <div style="max-height:65vh;overflow-y:auto;padding-right:4px">
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

                <div style="margin-bottom:12px">
                    <button type="button" data-action="clear-all"
                        style="padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer;
                               color:var(--text-normal);
                               background:var(--background-secondary);
                               border:1px solid var(--background-modifier-hover);
                               border-radius:4px;
                               transition:background .15s,border-color .15s">
                        Clear Encounters
                    </button>
                </div>

                <div style="overflow-x:auto;border:1px solid var(--background-modifier-accent);border-radius:4px">
                    <table style="width:100%;min-width:880px;border-collapse:collapse;font-size:13px">
                        <thead>
                            <tr style="opacity:.6;border-bottom:1px solid var(--background-modifier-accent);
                                       position:sticky;top:0;background:var(--background-primary)">
                                <th class="vet-num">#</th>
                                <th>User</th>
                                <th>User ID</th>
                                <th>Status</th>
                                <th class="vet-num">Total</th>
                                <th class="vet-num">Meetings</th>
                                <th>First seen</th>
                                <th>Last seen</th>
                                <th class="vet-badge">!</th>
                            </tr>
                        </thead>
                        <tbody>${rows || `<tr><td colspan="9" style="padding:8px;opacity:.5">No data yet.</td></tr>`}</tbody>
                    </table>
                </div>

                <p style="opacity:.5;margin-top:12px;font-size:12px">
                    Data is stored locally in BetterDiscord's data folder.
                </p>
            </div>

            <style>
                .vet-num, .vet-badge { text-align: right; }
                .vet-badge { text-align: center; }
                .vet-num, .vet-badge, td, th {
                    padding: 6px 8px;
                    white-space: nowrap;
                }
                .vet-id {
                    font-family: monospace;
                    font-size: 11px;
                    opacity: 0.7;
                }
                .vet-date { font-variant-numeric: tabular-nums; }
                .vet-status[data-status="blocked"] { color: #ed4245; font-weight: 600; }
                .vet-status[data-status="ignored"] { color: #faa61a; font-weight: 600; }
                .vet-status[data-status="muted"]   { color: #72767d; font-weight: 600; }
            </style>
        `;

        // Checkbox handlers.
        container.querySelectorAll("input[data-pref]").forEach(cb => {
            cb.addEventListener("change", () => {
                const key = cb.getAttribute("data-pref");
                this.prefs[key] = cb.checked;
                this.savePrefs();

                if (key === "hideMuteForBlocked") {
                    this.applyNativeMuteCss();
                }
                try { this.injectBadges(); } catch (err) {}
            });
        });

        // Clear button.
        const clearBtn = container.querySelector("[data-action='clear-all']");
        if (clearBtn) {
            clearBtn.addEventListener("mouseenter", () => {
                clearBtn.style.background = "var(--background-modifier-hover)";
            });
            clearBtn.addEventListener("mouseleave", () => {
                clearBtn.style.background = "var(--background-secondary)";
            });
            clearBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                BdApi.UI.showConfirmationModal(
                    "Clear Encounters",
                    "Delete all stored voice encounter history? Blocked/ignored/muted users will be re-imported automatically.",
                    {
                        confirmText: "Delete",
                        cancelText: "Cancel",
                        danger: true,
                        onConfirm: () => {
                            this.clearAllEncounters();
                            this.renderSettings(container);
                        }
                    }
                );
            });
        }
    }
};