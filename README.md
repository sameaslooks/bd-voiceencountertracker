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
- **Desktop overlay (optional).** A separate frameless, translucent, always-on-top window that shows the current channel, the current participants, their badges, and a live speaking indicator. Includes quick-action buttons (block / ignore / mute) for every participant.
- **Persistent.** Everything is stored locally through `BdApi.Data` — survives Discord restarts and plugin reloads.
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
- every participant in the current channel — including yourself — with their badge,
- a live green ring around the avatar of whoever is speaking.

Buttons appear when the cursor enters the overlay window:

- `⊘` (block / unblock),
- `⊘` (ignore / unignore),
- `○` (mute / unmute in voice).

Each action is executed inside Discord within ~1 second.

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

- The `✓` / `!` decision is based on `RECENT_MS` (8 hours by default). If a user was last seen within that window, they show as `!` (just met). If it was earlier than that, they show as `✓` (known).
- To change the threshold, edit `this.RECENT_MS` in the plugin constructor.

**After restarting Discord, users already in voice don't show up in the overlay**

- Users who were already sitting in a channel when the plugin started are recorded from the moment of startup, not from their actual join time. They appear in the overlay once they send any voice state update (mute, unmute, move, disconnect) or once you yourself move.
- This is by design: Discord does not replay the original join events for users who were already in voice.

**Encounters aren't recorded**

- The plugin only records sessions while *you* are in a voice channel. Sitting in a text channel or having Discord closed does not produce encounters.
- A session with a user is recorded only after the session ends — one of you leaves the channel, switches to another channel, or Discord closes. If you both stay in the same channel, no session is written until then.
- Check the console for `[VoiceEncounterTracker]` errors around `VOICE_STATE_UPDATES`.

**Overlay shows "Server offline"**

- The overlay is a separate Electron app in `server/`. It must be running (`npm start` or `start.bat`) for the plugin to push data into it.
- Open `http://127.0.0.1:17842/state` in a browser. If nothing comes back, the overlay process is not running or is not listening on that port.
- If the port is taken by another program, change `PORT` in `server/overlay-app.js` and `OVERLAY_URL` in the plugin to the same new value.

**Speaking ring doesn't appear for yourself**

- Discord does not expose the local user's speaking state through any store. The plugin detects your own speaking by reading the `box-shadow` of your avatar in Discord's DOM. This requires the voice channel to be visible in the Discord window — if Discord is minimised or you've scrolled the channel out of view, your own speaking ring may not update.
- For other users this works regardless, because their speaking state is available through `SpeakingStore`.

**Block / ignore / mute buttons in the overlay do nothing**

- The plugin polls the overlay's command queue once per second. Wait a moment after clicking.
- Make sure Discord and the plugin are running. If Discord is closed, no one executes the command.

**Auto-mute on block doesn't fire**

- The option `Auto-mute users when you block them` is off by default. Enable it in the plugin settings.
- Auto-mute only reacts to blocks, not to ignores.
- The mute is applied ~500 ms after Discord emits the relationship update, to give the store time to settle.

## Data

All data is stored locally by BetterDiscord under the plugin's data folder:

- `encounters` — per-user encounter records, including the session log.
- `prefs` — plugin preferences (auto-mute, native-icon hiding).

Deleting the plugin file from BetterDiscord's plugin folder does **not** erase this data. To reset, use the **Clear Encounters** button in the plugin settings.

## Repository layout

```
.
├── VoiceEncounterTracker.plugin.js   # the BetterDiscord plugin
├── server/                           # the optional overlay (Electron)
│   ├── overlay-app.js
│   ├── overlay.html
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