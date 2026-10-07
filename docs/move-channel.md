# Moving a channel to another Mac

Since 2026-10-07 each channel can carry everything it needs inside its own folder,
so moving a channel means copying one folder.

## What lives inside a self-contained channel

```
<Library>/<channel>/
├── project.json, config.json, ideas.json, …
├── episodes/            scripts, audio, images, subtitles   → ${PROJECT}/…
├── assets/              logos, intros, music beds, overlays, stills, fonts → ${CHANNEL}/assets/…
├── music/ backgrounds/ overlays/ ambient/                      → ${CHANNEL}/…
├── Exports/             finished videos (Season NNN/<code> - <title>/)
├── youtube/             publishing state for this channel
└── _trash/              what the app moved aside (empty it yourself)
```

- **Picking a file** (Video Assembly, Audio Assembly, Subtitles, Music, B-roll
  pickers) copies it into `assets/` when it lives outside the channel, and saves it
  as `${CHANNEL}/assets/<name>`.
- **New finished videos** go to `<channel>/Exports/…`, unless you chose a separate
  finished-videos folder in Settings → Files & maintenance, or the channel keeps
  heavy media on its own drive (`media_root`). Those two keep working exactly as
  before.

## Making existing channels self-contained (one time)

Settings → Project files & behavior → **Make this channel self-contained**, or
Settings → Files & maintenance → **Make All Channels Self-Contained**.

1. **Preview** lists every file to copy (with sizes), every saved setting that will
   point at the channel's copy, the finished videos to move, and any file that is
   missing on this Mac (left as it is).
2. **Apply**:
   - copies each shared file (`${ASSET}/…` in `_Project Assets`, or an absolute path
     outside the Library) into `<channel>/assets/`, checks the copy by sha256, and
     only then rewrites the setting;
   - rewrites absolute paths that already point inside the channel to
     `${CHANNEL}/…` / `${PROJECT}/…` (no copy); an old iCloud path is re-pointed at
     the same file inside this channel folder when it is there;
   - moves finished videos from `<Library>/Exports/<channel>/` to
     `<channel>/Exports/` (a rename on the same drive; across drives it copies,
     verifies, and puts the original in `_trash`). This part waits while a render
     or upload for that channel is queued or running;
   - leaves `_Project Assets/` and every original untouched — remove the shared
     folder yourself once you are happy.

Running it again is safe: a finished channel previews as "Already self-contained".

## Moving the channel

1. Quit Story Studio on the old Mac (or make sure nothing is running for that channel).
2. Copy the whole `<Library>/<channel>/` folder into the new Mac's Library folder.
   It appears in the channel list by itself — there is no import step.
3. On the new Mac, **reconnect YouTube**: connect the account in Settings →
   Connections, then pick it for this channel in Settings → Publishing. Sign-in
   tokens and the account-to-channel assignment are kept in each Mac's own app data
   (encrypted) and never travel with the folder. Upload records (`youtube/` and each
   episode's `youtube_upload.json`) do travel, so uploaded episodes stay uploaded.
4. **Install the channel's Content Pack versions.** The self-contained preview shows
   "Content packs this channel uses" with the exact versions and whether each is
   installed on this Mac. Install any that are missing from the Content Store.
5. Open the channel's Preview once more: everything should resolve, and anything
   still missing is listed by name.

## What stays app-wide (not in the channel folder)

| Thing | Where it lives | On the new Mac |
|---|---|---|
| Voices, models, generation | the Gateway (and its Studio Hub fleet) | point Story at the Gateway in Settings → Connections |
| Content Packs (formulas, styles, topic packs) | installed per Mac | install the same versions (see step 4) |
| App settings (Gateway address, alerts, server mode, finished-videos folder choice) | each Mac's app settings | set again |
| YouTube sign-in and channel assignment | each Mac's app data (encrypted) | reconnect and assign |
| Library-wide libraries: `.character-library`, `.thumbnail-templates`, `.niches`, `.formats`, `.topic-packs`, music library, B-roll pools | the Library root / app data | copy them too if the channel uses them |
| `_Project Assets/` | the Library root | no longer needed once the channel is self-contained |

## Keep channel names unique across Macs

A channel is identified by its folder name (its slug). Two Macs that each create a
channel called `night-atlas` cannot both be brought into one Library. Give every
channel a unique name across all your Macs, and run each channel on one Mac only.
