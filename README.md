# VoiceEncounterTracker

A BetterDiscord plugin that remembers every user you've ever shared a voice channel with, and lets you tag them with custom colored labels (e.g. "blacklist", "unreliable", "friend") that show up right next to their name.

Discord doesn't tell you who you've crossed paths with before. VoiceEncounterTracker does — and keeps your notes about them.

![preview](docs/preview.png)

## Features

- **Encounter log.** Every user who was ever in the same voice channel as you is recorded with first seen, last seen, and total encounter count.
- **Custom labels.** Create your own labels with a name, emoji icon, and color (e.g. `⛔ ЧС` red, `⚠️ Unreliable` orange, `⭐ Friend` green).
- **Color-coded badges.** Labels appear as small colored chips next to the username everywhere Discord shows it.
- **Right-click to tag.** Assign or remove labels directly from Discord's user context menu under `VoiceEncounter: Labels`.
- **Persistent.** Saved through `BdApi.Data` — survives Discord restarts and plugin reloads.
- **No API requests.** Reads Discord's in-memory `VoiceStateStore`. Nothing is sent anywhere.
- **Native look.** Uses Discord's own CSS variables and text colors.

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/) if you haven't already.
2. Download `VoiceEncounterTracker.plugin.js` from the [releases page](../../releases).
3. Drop the file into your BetterDiscord plugins folder:
   - Windows: `%AppData%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
4. Restart Discord or press `Ctrl+R`.
5. Enable VoiceEncounterTracker in Settings → Plugins.

## Usage

### Creating labels

Open plugin settings → **Labels** tab → fill in name, emoji icon, color → **Create**.

You can reorder labels with ↑/↓, edit with ✎, delete with ✕.

Default labels created on first run:
| Icon | Name        | Color     |
|------|-------------|-----------|
| ⛔   | ЧС          | `#ed4245` |
| ⚠️   | Ненадёжный  | `#faa61a` |
| ⭐   | Друг        | `#3ba55d` |

### Assigning labels to a user

- **Context menu:** right-click any username in Discord → `VoiceEncounter: Labels` → toggle labels.
- **Settings panel:** open the **People** tab and click a label chip next to a user to toggle it.

### Viewing encounters

Open plugin settings → **People** tab. You'll see every user you've encountered, with:
- total number of encounters,
- last seen time,
- currently assigned labels.

## How it works

Discord delivers every voice state change through its gateway connection. The plugin subscribes to these updates via `BdApi.Patcher`, watches where *you* are in voice, and every time you share a channel with someone, records the encounter. Nothing leaves your machine.

## Preview

    # General
       alice      [⭐ Friend]        12:34
       bob        [⚠️ Unreliable]    3:21
       charlie    [⛔ ЧС]           1:05:47

## Limitations

- Discord doesn't send voice states for servers you've never opened. Encounters for those servers only start once you visit them.
- Encounters start from the moment the plugin first sees a user in voice. If someone was already in a channel when you launched Discord, the timer starts then.
- Badge injection relies on Discord's current CSS class names. If Discord changes them, the plugin will need an update.

## Troubleshooting

**No badges appear**

- Check the console (`Ctrl+Shift+I`) for `[VoiceEncounterTracker]` logs.
- Make sure the plugin is enabled under Settings → Plugins.
- Reload Discord (`Ctrl+R`).
- Make sure you've actually created labels and assigned them to users.

**Labels don't appear in the context menu**

- Reload Discord. The context menu patch is installed on `start()`.
- Verify no other plugin is patching `user-context` and conflicting.

**Encounters don't get recorded**

- Open the console and check for `VOICE_STATE_UPDATES` handling errors.
- Make sure you're actually in a voice channel — the plugin only records when *you* are in voice.

## Data

All data is stored locally by BetterDiscord:

- `encounters` — per-user encounter records
- `labelDefinitions` — your custom labels
- `userLabels` — mapping of user → assigned label IDs

Deleting the plugin from BetterDiscord's plugin folder does **not** erase this data. To reset, clear it via the plugin's settings or BetterDiscord's data directory.

## License

MIT. See [LICENSE](LICENSE).

## Support

- Found a bug? [Open an issue](../../issues).
- Pull requests are welcome.

---

Made by [sameaslooks](https://github.com/sameaslooks).