# VoiceEncounterTracker

A BetterDiscord plugin that remembers everyone you've ever shared a voice channel with — and shows a small badge next to their name so you can tell at a glance whether you've met them before, blocked them, or muted them. Comes with an optional desktop overlay that sits on top of any window (including games and Discord's PiP) and lets you block / ignore / mute people with one click.

Discord doesn't tell you who you've crossed paths with before. VoiceEncounterTracker does — and keeps the full history of every voice session you've spent together.

## Features

- **Encounter history.** Every user who was ever in the same voice channel as you is recorded with `firstSeenAt`, `lastSeenAt`, total time spent together, and number of meetings.
- **Session log.** Each individual voice session is stored separately: when it started, when it ended, how long it lasted, in which guild and in which channel.
- **Badges next to usernames.** A small colored symbol appears next to every user in the voice channel:
  - `!` — never met, or only just met (within the last 8 hours)
  - `✓` — known user (met more than 8 hours ago)
  - `○` — you muted this user in voice
  - `⊘` red — blocked
  - `⊘` orange — ignored
- **Auto-mute on block.** Optional checkbox: whenever you block someone, they are muted in voice automatically.
- **Hide Discord's native mute icon** for blocked / ignored users, so you don't see two mute indicators at once.
- **Manual add.** Add any user to your history by ID or username, right from the plugin settings.
- **Desktop overlay (optional).** A separate frameless, translucent, always-on-top window that shows the current channel, the current participants, their badges, and a live speaking indicator. Includes quick-action buttons (block / ignore / mute) for every participant. On top of that it can:
  - show **favorites**, who just **moved to another channel**, and offer to **return to your channel** after Discord restarts;
  - show **DMs, mentions and incoming calls** without leaving the game, and an **unread-DM badge** on people in voice;
  - give every person a **right-click menu** (volume, DM, profile, favorite, …) and show what they're **playing / listening to**;
  - **watch streams** — several at once, your own included — in separate windows with a magnifier;
  - remember **window layouts per game** and go **click-through** whenever a game owns the mouse.
- **Your own voice time.** A log of the time *you* spend in voice (alone or not), per server and channel, with a 30-day chart.
- **Time search.** Who was in voice with you at a given moment or period, and when a group of people were all together with you.
- **Persistent.** Everything is stored locally through `BdApi.Data` — survives Discord restarts and plugin reloads; the history is mirrored into rolling backups.
- **No API requests.** All data is read from Discord's in-memory stores. Nothing leaves your machine.

## Installation

### Plugin

1. Install [BetterDiscord](https://betterdiscord.app/) if you haven't already.
2. Download `VoiceEncounterTracker.plugin.js` from the [releases page](../../releases).
3. Drop the file into your BetterDiscord plugins folder:
   - Windows: `%AppData%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
4. Restart Discord (`Ctrl+R`).
5. Enable **VoiceEncounterTracker** in Settings → Plugins.

The plugin works on its own. The overlay is optional.

### Overlay (optional)

The overlay lives in the `server/` folder of this repository. It's a small Electron app that reads data from the plugin over `http://127.0.0.1:17842` and renders a translucent always-on-top window.

1. Install [Node.js](https://nodejs.org/) (LTS).
2. Copy the `server/` folder somewhere convenient, e.g. `C:\VoiceEncounterOverlay\`.
3. Open a terminal inside that folder and run:
   ```
   npm install
   ```
4. Start the overlay:
   ```
   npm start
   ```
   or double-click `start.bat`.
5. A small window appears — by default on the second monitor, top-right corner. Drag it by the top bar to move it.

The overlay lives in the system tray. Right-click the tray icon for options: show/hide, reset position, opacity, quit.

## Usage

### Badges in Discord

Badges appear automatically next to usernames of users in your current voice channel. Hover the badge to see details:

- For a `✓` badge, the tooltip shows how many times you've met, the total time spent together, and the last-seen date.
- For a `⊘` badge, it tells you whether the user is blocked or ignored.

### Auto-mute and native-icon hiding

Open plugin settings and toggle:

- **Auto-mute users when you block them** — when enabled, blocking a user also mutes them in voice. Off by default.
- **Hide Discord's mute icon for blocked / ignored users** — when enabled, Discord's own mute icon is suppressed for users you've blocked or ignored, so only your `⊘` badge remains. On by default.

### Manual add

In plugin settings, under **Add user manually**, type a user ID (15–25 digits) or an exact username / global name, then press **Add**. The user is added to your history with no session time, marked as `manual`.

### Clear history

Click **Clear Encounters**. This wipes the local history and re-imports blocked / ignored / muted users from Discord automatically.

### Overlay

When the overlay is running, it shows:

- channel name and participant count in the top bar,
- every participant in the current channel — including yourself — in Discord's order (alphabetical), with their badge,
- a live green ring around the avatar of whoever is speaking.

Buttons appear when the cursor enters the overlay window:

- `⊘` (block / unblock),
- `⊘` (ignore / unignore),
- `○` (mute / unmute in voice).

Each action is executed inside Discord within ~1 second.

**Click-through in games.** While a game owns the mouse (the cursor is hidden and the game is fullscreen or locks the cursor), every overlay window dims and lets clicks pass through. Alt-Tab out (or open the game's menu) to use it.

#### Header

- **Hold-to-leave** (phone icon, only in voice): hold until the ring around it closes to disconnect.
- **Stream source** (screen icon, only in voice): pick what you stream — screens and windows with live thumbnails, minimized and borderless games included; only windows that have a taskbar button are listed.
- **Signal**: hover for the current / average / worst ping and a 10-minute graph. Time out of voice is a gap; separate voice visits are joined by a grey dashed line.
- **Time**: shows the current time; in voice it alternates every 8 s with your session time (e.g. `38m`, `1h 05m`, `1d 2h`).

#### People in voice

- **Right-click a person** for a quick menu: their activity, **user volume** (same scale as Discord's slider), **Message** (opens your DM), **Profile**, **Listen along** (Spotify), **Favorite** and its **join / leave sound**, **Known** (only a manual mark can be removed), copy username / ID.
- **Favorites** (also from Discord's own user menu → *Add to Favorites*) have their names in a calm gold accent and flash yellow when they join; with the sound on (off for a new favorite) you hear a short tone when they actually come or go — nobody else makes a sound, and favoriting someone already in the channel is silent. Your own row is never gold.
- **Activity**: a game icon or the music platform's icon next to the name; hover it for the art and the full status.
- **Phone icon** = in voice from mobile. **Red number** on the avatar = unread DMs from them.
- **Right-click your own card** to write a one-line **session note** under the list (click it to edit, clear it to remove; it's gone when you leave the channel).

#### Cards under the list

- **"Name → #channel"** for 20 s when someone moves to another channel of the same server — click to follow.
- **"Return to #channel"** when Discord restarted or crashed while you were in voice (offered for 30 min) — click to rejoin. Leaving voice yourself never shows it.
- **Session stats** for 90 s after you leave voice: this session and *today* for you, and the people you spent the most time with. "Today" starts after your last pause in voice of 8 h or more.

### Messages and calls

Each overlay window has its own block docked under it, shown only when there's something to show. It hides and closes together with its overlay. No cards or calls are shown or queued while no overlay is visible; hiding all overlays (`Ctrl+Alt+H`) or closing the last one clears the cards and the pending call.

What the block can show:

- **DMs and mentions** — one card per chat, gone after 12 s or as soon as you read it in Discord. With the cursor visible, click a card to open the chat in Discord.
- **Incoming calls** — *Accept*, *Decline*, or *Message*: type a reply (the box grows as you type), press Enter, and the call is declined with your message sent.
- **Audio device changed** — a short notice with the new input / output device.
- **Someone unexpected started watching your stream** — see below.

Who gets through is set in the plugin settings under *Overlay notifications*: direct messages, mentions and incoming calls each have *All / Friends / Favorites only / Nobody*, and audio device notices can be turned off. Favorites follow their own *Show messages in overlay* / *Show calls in overlay* toggles (overlay user menu or Discord context menu, both on by default) regardless of those choices. Blocked and ignored users are never shown.

### Streams

- **Watch**: click **LIVE** on someone's card. Every stream (and **camera** — click the camera icon) opens in its own window, so you can watch several at once. Hover **LIVE** for Discord's preview of the stream. Every overlay window can open streams on its own, and the same stream can be open in several overlays: Discord watches each stream once, and every window gets a clone of the same track over its own local loopback connection (no extra network). Discord stops watching a stream only after the last window of it closes.
- **Your own stream**: click your own **LIVE**. It comes from Discord's own pipeline (what it captured to send) at a light 360p / 25 fps, or, if Discord doesn't have it, from a local capture of the streamed window that follows source switches.
- **Viewers**: the number next to your LIVE is how many people watch; hover it to see who. A small yellow dot marks someone who came into the channel while you were streaming and opened it within 3 minutes (cleared after 3 minutes).
- **In the stream window**: drag to move, resize from the edges (the aspect ratio stays), the pin button switches between full and preview size, the half-moon button sets opacity; the size and fill-screen buttons show their current state. **Magnifier** (cursor visible; also works in small windows): click to zoom 2× there and click again to go back, wheel to zoom 1–4×, drag to pan; remembered per streamer. The zoomed area is rendered at a higher resolution.
- **Paused**: when the streamer minimizes their window, Discord pauses the stream — the window shows the last frame blurred (or a black screen with the pause plate) with *Stream paused* instead of reconnecting.
- **Closing** a stream window closes only that window. Closing an overlay closes its stream windows.
- Windows open in order: #1 in the main place, #2, #3… in the places set up for them (see layouts); if one in the middle closes, the later ones move up. Viewer windows of extra overlays open next to their overlay; saved layout places apply to the main (first) overlay's viewers.
- **Queues**: each stream has its own connection queue, so a stuck stream doesn't block the others. Closing a stream window while it waits stops watching in Discord at once.
- **Waiting states**: *Waiting for stream*, then *Connected, waiting for the first frame* (the first connection waits up to 45 s, later attempts 8 s), then a reconnect card with *Attempt N*. After the first frame, silence is normal for a static picture; after 15 s without frames the window reconnects quietly and keeps the last frame on screen.
- **Frozen streams**: recovered on reconnect by leaving and rejoining the stream in Discord (at most once per 15 s per stream).
- **Small windows** (narrower than 240 px or lower than 130 px) show only icons and *Attempt N*; header buttons shrink.
- **Own stream source**: the overlay finds the streamed window even when Discord's id format differs. A minimized source shows *Stream paused* instead of an error.
- **Performance**: the plugin encodes each stream to the window's real size (20 fps up to 240 px tall, 30 fps up to 480 px, 60 fps above; never above the source), and zooming in raises the resolution of the zoomed area. A 0.5 s smoothing buffer hides Discord's bursty frame delivery (about 0.5 s extra delay). Tray **Light stream rendering (may stutter)** switches to a lighter renderer without the smoothing buffer. Stream windows are opaque; their opacity slider still works.

### Window layouts

Tray icon → **Window layouts…** lists *Desktop* and every game you've played with the overlay running. A layout is where the overlay, the stream windows (#1, its preview size, #2, #3…) and the message block go; it's applied automatically when that game is in front (*Desktop* everywhere else). Auto-switch fires when a game is fullscreen with a hidden cursor.

- **Setup** — for 30 s the overlay stays clickable even inside the game, turns translucent, and numbered frames appear for the stream windows and the message block. Switch to the game and drag them; **+ Stream window** adds a place for one more stream (hidden in Tiled). It's saved 5 s after your last move (the timer holds while you're dragging), or press **Done**.
- **Save** stores where the windows are right now; **Apply** moves them there now.
- Dragging a window by hand also updates the layout that's active at that moment.
- Profiles match overlay windows by id, then by order if the ids changed; the profile then heals itself to the new ids. The log shows how many windows moved.
- **Snapping** — a dragged overlay, stream window or setup frame sticks to the edges of other windows and the screen within 12 px, and then follows the window it stuck to when that one moves or resizes. Overlay-to-overlay links are saved in the layout. Pull a window away to unstick it. The message block sits flush under its overlay.
- **Streams: Tiled** — per layout, under *Streams*: 1–3 main windows (laid out Right / Left / Down / Up) and the rest as small windows (1/3 or 1/4 width) in a strip on the left, right, above or below, all flush. The layout rebuilds itself as streams come and go: if a main one closes, the next stream takes its place and the small ones re-stick to the remaining block. Drop a window onto another to swap them, use the star button on a small window to make it the main one, drag or resize the first main window to move or scale the whole block. The size toggle on the first main window also resizes the block, and a fill-screen button on a stream window scales the whole tiled block to fit the screen. In setup only the main frame is shown, plus ghost frames for the extra streams. *Free* keeps the old free placement.
- A game whose cursor is locked (shooters) can only be set up while it shows a cursor — in its menu, paused, or windowed.
- Overlay windows no longer flash on the taskbar during layout switches.

### Tracker window

Open it from the plugin settings or from a user's context menu → *Open Encounter Tracker*.

- **Your own row** — pinned first in the table and marked *(you)*: your total time in voice, sessions, first and last seen; expand it for your sessions with server and channel. Your sessions can be merged like anyone else's.
- **Deleting and merging sessions** — every session line has a trash button that deletes it at once. Tick sessions (across several people) to delete or merge them from the bar above the table; merging joins only each person's own selected sessions. Totals are recalculated. Long session lists load in chunks of 30 as you scroll. Own time excludes the AFK channel, and your open session survives plugin and Discord restarts.
- **Who was in voice with me** — set *At / from* and *to (optional)*: get everyone whose sessions overlap the moment or period; leave *to* empty for a single moment. Click a row to jump to that session in the table.
- **Together…** — tick 2–5 people in the table to see when they were all in voice with you. A *to* time is required.
- **History → merge** — tick sessions of one person and merge them into one.
- **Favorites** — a gold star in the "!" column; the status reads *favorite* (the tooltip lists their toggles).
- **Last seen** — people you're in voice with now show *now* instead of a date.
- **Live session** — the ongoing session appears at the top of an expanded row. It can be merged with earlier sessions (the live session then counts from the earliest start and keeps running), but it can't be deleted.

## How it works

Discord delivers every voice state change through its gateway connection. The plugin subscribes to these updates via `BdApi.Patcher`, watches where *you* are in voice, and every time you share a channel with someone, records a session. Speaking state is read from `SpeakingStore` (for other users) and from the local avatar's computed style (for yourself, since Discord doesn't expose your own speaking state through any store). Blocked / ignored lists come from `RelationshipStore`. Mute state comes from `MediaEngineStore.isLocalMute`.

The overlay is optional. When running, the plugin pushes the current state to `http://127.0.0.1:17842/state` and the speaking list to `/speaking`. Commands from the overlay are queued at `/command` and drained by the plugin once per second via `GET /commands`.

## Limitations

- Discord doesn't send voice state for guilds you've never opened. Encounters for those guilds only start once you visit them.
- Encounters begin from the moment the plugin first sees a user in voice. Users who were already in a channel when you launched Discord get a "seeded" session that does not count as a real meeting until either of you leaves or switches channel.
- Badge injection relies on Discord's current CSS class names. If Discord changes them, the plugin will need an update.
- The overlay only works on the same machine as Discord, since it reads from a local HTTP server on `127.0.0.1:17842`.
- The overlay cannot render inside Discord's PiP window — BetterDiscord does not inject there, and the PiP window has no access to Discord's stores.

## Troubleshooting

**Badges don't appear in Discord**

- Make sure the plugin is enabled in Settings → Plugins and Discord was reloaded (`Ctrl+R`).
- Open the console (`Ctrl+Shift+I`) and check for `[VoiceEncounterTracker]` logs. On startup you should see `Starting...`, `Dispatcher hooked.`, and `Started.`.
- Badges only render for users visible in the voice channel list. If Discord is minimised or the channel is scrolled out of view, badges may not update until you bring it back.

**Wrong user shows a `✓` / `!` badge**

- The `✓` / `!` decision is based on `RECENT_MS` (8 hours by default). If you first met a user within that window, they show as `!` (just met). If it was earlier than that, they show as `✓` (known).
- A user also needs at least *N* minutes together in voice (15 by default, configurable in the settings panel) before turning `✓`.
- To change the 8-hour window, edit `this.RECENT_MS` in the plugin constructor.

**After restarting Discord, users already in voice don't show up in the overlay**

- Users who were already sitting in a channel when the plugin started are recorded from the moment of startup, not from their actual join time. They appear in the overlay once they send any voice state update (mute, unmute, move, disconnect) or once you yourself move.
- This is by design: Discord does not replay the original join events for users who were already in voice.

**Encounters aren't recorded**

- The plugin only records sessions while *you* are in a voice channel. Sitting in a text channel or having Discord closed does not produce encounters.
- A session with a user is recorded only after the session ends — one of you leaves the channel, switches to another channel, or Discord closes. If you both stay in the same channel, it shows up in history only then. Open sessions are saved as they start, so after a crash they are closed at the last 30 s alive mark on the next start.
- Check the console for `[VoiceEncounterTracker]` errors around `VOICE_STATE_UPDATES`.

**Overlay shows "Server offline"**

- The overlay is a separate Electron app in `server/`. It must be running (`npm start` or `start.bat`) for the plugin to push data into it.
- Open `http://127.0.0.1:17842/state` in a browser. If nothing comes back, the overlay process is not running or is not listening on that port.
- If the port is taken by another program, change `PORT` in `server/overlay-app.js` and `OVERLAY_URL` in the plugin to the same new value.

**Speaking ring doesn't appear for yourself**

- Discord does not expose the local user's speaking state through any store. The plugin detects your own speaking by reading the `box-shadow` of your avatar in Discord's DOM. This requires the voice channel to be visible in the Discord window — if Discord is minimised or you've scrolled the channel out of view, your own speaking ring may not update.
- For other users this works regardless, because their speaking state is available through `SpeakingStore`.

**Something in the overlay does nothing (Message, volume, calls, stop watching…)**

- These use Discord's internal functions, whose names change between Discord versions. Look in `server/logs/plugin.log` for a line ending in `not found` and report it.

**A stream window stays on "Attempt N" for a long time**

- Check `server/logs/plugin.log` around `watch-stream`. A stream the streamer minimized shows *Stream paused* instead and comes back by itself.
- A frozen stream is recovered by rejoining it in Discord automatically (at most once per 15 s per stream). If it keeps failing, check `server/logs/video.log`.

**Block / ignore / mute buttons in the overlay do nothing**

- The plugin polls the overlay's command queue once per second. Wait a moment after clicking.
- Make sure Discord and the plugin are running. If Discord is closed, no one executes the command.

**Auto-mute on block doesn't fire**

- The option `Auto-mute users when you block them` is off by default. Enable it in the plugin settings.
- Auto-mute only reacts to blocks, not to ignores.
- The mute is applied ~500 ms after Discord emits the relationship update, to give the store time to settle.

**The overlay closes or crashes unexpectedly**

- Unexpected errors are written to `server/logs/video.log` as `[fatal]` or `[exit]` lines.
- Native crashes leave a minidump in `%APPDATA%\Electron\Crashpad\reports`. Nothing is uploaded.

## Data

All data is stored locally by BetterDiscord under the plugin's data folder:

- `encounters` — per-user encounter records, including the session log. Mirrored into `backup-last` and three daily backups; a damaged or emptied store is restored from them automatically.
- `prefs` — plugin preferences (auto-mute, native-icon hiding).
- `favorites` — your favorites and their sound setting (kept apart from the history).
- `myVoice` — your own voice sessions for the last year.
- `lastVoice` — the last channel you were in (for *Return to channel*).
- `myVoiceOpen` — your currently open voice session.
- `openSessions` — sessions in progress for everyone, saved as they happen.
- `aliveAt` — heartbeat mark, written every 30 s.

On the next start, open sessions resume if you're still in the same channel (within 2 min); otherwise they are closed at the last `aliveAt`. Each meeting is recorded once.

The overlay keeps its settings (window places, layouts, stream window prefs) in Electron's user-data folder, and logs in `server/logs/` — `plugin.log` (the plugin's log) and `video.log` (stream windows, click-through, and `[fatal]` / `[exit]` lines for unexpected overlay errors). Native crash dumps go to `%APPDATA%\Electron\Crashpad\reports`; nothing is uploaded.

Deleting the plugin file from BetterDiscord's plugin folder does **not** erase this data. To reset, use the **Clear Encounters** button in the plugin settings.

## Repository layout

```
.
├── VoiceEncounterTracker.plugin.js   # the BetterDiscord plugin
├── server/                           # the optional overlay (Electron)
│   ├── overlay-app.js                # main process: HTTP bridge, windows, click-through, layouts
│   ├── overlay.html                  # the voice overlay
│   ├── notify.html                   # messages / calls block
│   ├── video.html                    # stream viewer
│   ├── menu.html, tip.html           # right-click menu, hover tooltips
│   ├── popup.html                    # stream source picker
│   ├── layouts.html, placeholder.html# window layouts and setup frames
│   ├── package.json
│   └── start.bat
├── README.md
└── LICENSE
```

## License

MIT. See [LICENSE](LICENSE).

## Support

- Found a bug? [Open an issue](../../issues).
- Pull requests are welcome.

---

Made by [sameaslooks](https://github.com/sameaslooks).