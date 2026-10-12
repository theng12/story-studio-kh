# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.4.298 — 2026-10-12

- Re-aligning a Scene Plan no longer leaves a scene with no length. When two short scenes fell inside one caption, both were moved to the same moment and the first one ended up with no time at all, so Video Assembly stopped (Brain Wise EP0047). Such a scene is now removed and its words go to the scene beside it, the same way the Scene Plan already tidies its own timeline.

## v1.4.297 — 2026-10-12

- New narration for a part the episode did not have before is now used. When a rewritten script gains a part that the last Audio Assembly did not include (MineePod EP0003 gained an Introduction), the new narration for it is added to the episode, and Audio Assembly fits it in next. Before, Audio stopped with "the active audio selection has no row for Introduction".

## v1.4.296 — 2026-10-12

- Story now fixes small mismatches itself instead of stopping the episode (owner: "Imperfection is often accepted. I'm very lenient."). Each fix is written in the job log in plain words. What still stops an episode: missing or silent narration, a missing video, loudness outside your 20 % allowance, and anything that would upload public.
- Scene Plan out of step with the narration or captions. If the narration or the captions changed a little after the Scene Plan was made (for example one more caption, or a narration 0.9 s shorter), Story moves each scene to where its words are now spoken and carries on. Every scene, prompt, approval and picture is kept. The same happens to an older plan that has no record of its captions. It still asks for a rebuild only when the plan and today's narration differ by more than 10 % in length.
- Overlapping scene times. Video Assembly now fixes overlaps of any size the same way before it renders (before, it only fixed up to 2 s each and 5 s in all). If a plan starts its first scene a little after the narration begins, the first picture is shown from the start.
- Out-of-date pictures. A scene picture drawn from an older wording of its prompt is used as it is, and the job log names it. Scene Review still marks it, so you can re-render it if you want.
- Scene pictures on your Macs. If a free picture request was lost, or a re-render had already used its one try, Story sends a fresh request instead of stopping; free pictures cost nothing to repeat. If one scene still cannot be made on the last automatic try, it keeps its earlier picture or uses the picture of the scene next to it, and the log says so. Scene Review shows that scene so you can regenerate it later. If more than 1 in 10 scenes fail, the episode still stops, because that means the Macs are not working. Paid picture models keep the careful path.
- Narration read twice. A chapter saved both as a new file and as an old Word file was put into the narration script twice, so the voice was asked to read it twice and Audio could not finish (MineePod EP0003–EP0005). Each chapter is now used once, both when the script is put together and when Audio reads it.
- New narration that is complete is used. When every new narration file exists, plays and is not silent, Story uses it even if its record of how it was made is incomplete. A missing or broken file, or one made by a different voice model, still stops.
- Lost writing requests. If the Gateway loses track of a writing request after it was sent (for example a network timeout), Story now sends it once more as a fresh request and says so in the log. Before, it stopped, because a paid writing model could charge twice; you accepted that small risk on Haiku. This also clears a Scene Plan that was stuck on one lost prompt request (Hidden Mechanics HMH0003, 0 of 185 prompts). If the second send is lost too, the step stops as before. Pictures, voices, video and transcription are never resent this way.

## v1.4.295 — 2026-10-12

- Scene pictures are now always the lowest-priority work on your Macs (your standing rule): scene images, Scene Review re-rolls, continuity renders and Image Pool stills are sent to the Gateway as background work, so they only take a Mac nobody else is waiting for. Thumbnails stay normal, and sung songs are normal too, so the order is thumbnails and songs first, scene pictures last. Each Mac still makes one thing at a time.
- Songs with lyrics: the listen-back now asks for 70 % of the lyric words by default (was 50 %). The test songs scored 96–99 %, so 70 % still only turns away takes that are clearly broken. A channel that already saved its own level keeps it.

## v1.4.294 — 2026-10-12

- Songs with lyrics for music channels. Music Formula has a new "Songs with lyrics" switch, off for every channel until you tick it. When it is on, Generate Songs has the writing model (for example the channel's Claude Haiku 5.5) also write each song's original lyrics and a short style line (genre, instruments, the singer's voice), and a model that sings (YuE2, on your 16 GB Macs) makes the song. Sung songs go to the fleet as normal work, one for each Mac that can sing, and take their turn like any other job (each Mac still makes one thing at a time). The writing step is the only paid part, as before; the lyrics are written fresh for your channel, never naming or imitating real artists or songs, and your formula's "never" words are checked in the lyrics too.
- Every sung song is listened back by a free transcription model on your Macs (Whisper turbo), which checks how many of the lyric words were actually sung, in order. Below your level (50 % to start) the take goes to Story's Trash and the song is sung again, up to 3 takes; a song that never passes stays in the Song Pool switched off, so it is never used unheard. The Song Pool shows each sung song's score.
- Everything after that works as for Coffee Jazz today: Episode Builder, the −14 LUFS level, thumbnails, metadata and uploads. The episode metadata knows the songs are sung, and the lyrics can be added to the YouTube description (off by default; when the description is too long, the lyrics that fit are kept, from the first song).

## v1.4.293 — 2026-10-12

- Idea generator, the rest of the approved plan. Every new switch is per channel under Settings → Channel identity → "Idea supply and repeat checks" and is off until you turn it on; with them off, ideas are made exactly as before.
- Repeat check by meaning can now reject: the mode "On" throws away a new campaign idea that means the same as an earlier one (after the existing word check) and makes that slot again; the job log says which earlier idea it matched and how close. If the free embeddings model cannot be reached, the word check alone decides for that run and the log says so; idea generation is never stopped by it. Ideas you paste, add or import are only reported, never blocked.
- The "counts as a repeat" level is now 0.84 (was 0.78). Replaying Night Atlas History's 101 real ideas through the embeddings model showed 0.78 would have called 43% of them repeats although none is; 0.84 calls 3% (all near-repeats) and still catches the measured reworded repeats (Voynich, Roman roads, Opium Wars). A channel that already saved its own level keeps it.
- More variety per batch: each idea in a batch gets its own starting point (an era, a region, a theme and a kind of story, never the same one twice in a batch), and on Topic Pack channels a campaign takes subjects from every pack in turn instead of using up one pack first. Best left off for prayer, music and lullaby channels.
- Self-growing Topic Packs: when a Topic Pack channel has fewer unused subjects than its running-low number, Story asks the channel's idea helper model (for example Claude Haiku 5.5, a small paid call of about a fifth of a cent) for up to 40 new subjects, at most once a day, and puts them in that channel's own "Grown subjects" pack. Your Topic Packs are never changed, subjects already used, covered or removed are never added, and a run that finds nothing new adds nothing and says so. After three runs in a row that each add fewer than five, it stops trying on its own and sends one alert. You get an alert (Telegram and/or desktop, as set in Notifications) listing what was added. The Ideas page lists the grown subjects with where each came from, a Remove button (a removed subject is never suggested again) and "Grow Subjects Now". The first run copies your Topic Packs folder to the channel's `_backups` first.
- Ideas grounded in real sources: save a list of Wikipedia categories for a channel ("Suggest Categories" asks the helper model for a first list for you to edit) and switch on "Real sources". Topic Pack channels then grow only from real Wikipedia articles in those categories, each with its link; other channels show the idea model a few real articles they have not covered yet in every batch. Wikipedia is free and read without an account: at most one request a second, a weekly cached list per channel (or "Fetch Articles Now"), nothing sent about you, and if Wikipedia cannot be reached the last list is used.

## v1.4.292 — 2026-10-12

- A restart no longer tries to rebuild episodes whose files Free Up Space removed on purpose. On the Mac mini, after Free Up Space moved the chapter narration of nine uploaded TerraNash episodes (TN0162–TN0170) to the Trash, the next restart's recovery check queued Audio Assembly for each of them, and all nine failed three times ("required audio files are missing"). Story now treats those files as removed on purpose, not as missing work: the automatic recovery check leaves such an episode alone and says why. If you do want an episode back, Retry it yourself; that still rebuilds it, along with the steps that follow.

## v1.4.291 — 2026-10-12

- Backup and restore (owner: "say i plug in an SSD and points it at the SSD to create a backup … so we can start new and continue on a new machine"). Settings → Backup & restore: choose a backup folder (usually an external drive) and press Back Up Now, or turn on automatic backup (once a day, and whenever that drive is plugged in, only while nothing is in the job queue). It runs in the background with real progress and never waits for, or holds up, Video Assembly. The panel shows the last backup's time, size and what changed.
- What goes in: everything Story cannot make again, plus every record. Per channel: project and config files with all presets, ideas and episode numbering, covered-topics map and idea stats, upload plans and publishing settings, Music Pool and song library audio, logos, backgrounds, intro/outro clips and other branding, characters, YouTube upload records. Per episode: research, script, metadata, scene plan and approvals, subtitles, chapter timeline, thumbnail prompts, effects and Living Picture outlines, upload records and overrides, and the thumbnail chosen for upload. App-wide: settings and voice presets, content packs and your style packs, the character library, series formulas, thumbnail templates, topic packs, niches, and which YouTube channel each project uses.
- What stays out: scene images, narration, merged audio and masters, rendered videos, preview caches, `_trash`, and thumbnails other than the chosen one. Finished videos, narration audio and every thumbnail can be added, each with its size shown first (Measure sizes). Passwords, API keys, YouTube sign-ins, automation keys and server-mode credentials never go on the drive; after a restore you sign in again. An encrypted export of them is not offered: they are locked to this Mac's Keychain.
- On the drive it is a plain folder, `Story Studio Backup`, readable without Story, with `manifest.json` (checksums, Story version, date, per-channel counts). Only changed files are copied. Nothing on the drive is ever deleted: a file that changed or went away moves to `_versions/<date>/`. The panel shows how much `_versions` takes and lets you delete chosen dates after a confirm; like emptying Story's Trash, only the owner can, never an automation key. `<Library>/_trash` is never backed up. Unplugging the drive mid-way never leaves a broken file; the next backup carries on. Check Backup re-reads every file and lists anything missing or damaged.
- Restore from a backup: on the first-run screen of a new Mac ("Moving from another Mac?") and in Settings. Pick the drive, see each channel with its episodes, uploads and size, and restore into a new Library. A channel already there is only replaced if you tick it, and the old folder moves to Story's Trash, where it can be restored. Numbering, schedules and upload records carry on, so Story knows which episodes are on YouTube. Queued or running jobs from the old Mac are not brought back.

## v1.4.290 — 2026-10-11

- Moves and effects that understand the picture (the approved phases E2–E4 of the effects plan). Each scene picture is analysed once, on your own Macs, by the two approved free models (Depth Anything V2 Small for depth, Florence-2 Base for the main subject and outlines), and the result is saved with the episode. A render only reads it, never calls the network, and never fails over it: a scene without analysis uses the move's plain version and the job log says why.
- Off until you switch it on, per channel: Effects Library → Scene analysis has two switches, "Depth" and "Subject and outlines", and an "Analyse Scenes" button with progress. With both off nothing is analysed, these moves and effects are hidden, and every video renders exactly as before. Pictures are analysed in the background when you approve them in Scene Review (or a Pipeline approves them), as a 640-pixel copy (about 90 KB both ways, roughly 40 MB for a 450-scene episode), preferring the Mac that made the picture. The models are picked once for all channels in Settings → Connections → Scene analysis models; picking a different one re-analyses recent episodes in the background and keeps using the saved results until then.
- New camera moves: 3D Photo (gentle, normal, strong, and slide left / right) — near and far layers move at different rates; Rack Focus (gentle, normal, strong, and to the background) — the focus slides between the background and the subject; Zoom to Subject (gentle, normal, strong, and Pull Back from Subject) — Ken Burns aimed at the subject found in the picture, else the nearest large thing, else the middle, always keeping a margin round it; Guided Tour (and slow) — one gentle move through two or three interesting places, left to right. None of them ever turns the picture. 3D Photo and Rack Focus need a transition between scenes: a channel with hard cuts gets the plain zoom (or Blur → Focus) and the log says so. The Guided Tour is drawn by the native renderer; a scene that falls back to FFmpeg zooms to the subject instead.
- Effects that follow the picture instead of a fixed band: Clouds in the Real Sky, Twinkling Stars in the Sky, Shooting Star in the Sky, Aurora in the Sky, Moonlight Glow in the Sky, Caustics on the Water, Shimmer on the Water, Water Ripples, Mist along the Ground (the strip where the sky meets the land), Fireflies among the Plants, Flicker on Found Flames and Firelight round Found Flames. Any sky, water, flame or loop effect can also be switched to follow a part of the picture with its new "Follow the picture" setting. A hand-drawn or uploaded outline of the same name always wins. A picture that was analysed and has no sky (a room) gets no clouds at all; a picture not yet analysed keeps the effect's own band.
- Living Picture now finds its own outlines: from Video Assembly's effect list or the whole episode it moves every scene where scene analysis found its part (flames, the glow round them, water, sky) — no drawing needed. Outlines are checked before use: flames are kept to their bright, warm pixels (the model sometimes outlines a whole lit window), water to its own colour and never anything standing in front of it (reeds), the sky to what depth says is far and what joins the top of the picture; anything implausible is dropped, and then nothing moves there.
- Every new move and effect previews in Render Exact Preview over the scene's own analysis and in the Effects Library gallery; the gallery brings its own analysed sample pictures (a river at night and a fire pit), so the clips play even before any episode is analysed.
- Free Up Space has a new category, "Scene analysis of uploaded episodes", which moves those depth maps and outlines to the Trash.

## v1.4.289 — 2026-10-11

- One Trash for all of Story Studio (owner: "it's not using a 'story studio universal' _trash folder each channel's"). Everything Story removes, from every channel, now waits in one place: `<Library>/_trash/<channel>/…`. Free Up Space, Clear Uploaded Videos, leftover files, a reset idea or episode, Start Over on the covered-topics map, full-quality audio, older narration takes, outlines, scripts, research, subtitles, music, preview cache, character pictures and the Open at Login setting all go there. A move is still a rename and never crosses drives: media kept on a drive of its own goes to that drive's `_trash/<channel>`, and the Trash lists it too. Nothing is ever deleted by Story.
- A new **Trash** page (sidebar → Trash, or the home page): how much is in it in total, per channel and per kind (final videos, scene images, narration, music…), and the items themselves with where each came from and when. **Restore** puts an item back where it was (refused if something new is there). **Empty Trash** deletes everything in it for good, only after you type EMPTY TRASH on the page; an automation key can never do it (`POST /api/trash/empty` answers 403 to any request carrying a key).
- On first start, every old per-channel `_trash` (and the app's own `_trash`) is moved into the one Trash, under `<channel>/legacy/` with its folders as they were. Only renames, nothing deleted; an emptied old `_trash` folder is removed only when it is empty; each move is written to `<Library>/_trash/trash-migration.log`. Running it again moves nothing.
- Free Up Space no longer fails while a video renders (owner: "i see some failures"). Any Video Assembly running anywhere on this Mac used to refuse every check and run with "has active video_assembly work", and the Mac mini nearly always has one going; a run also held every new render back. Now only the episode's OWN queued or running work skips that episode, saying what to do ("… Let it finish (or cancel it in Jobs), then check again."), and renders and Free Up Space never wait for each other.
- Free Up Space shows real progress: episodes, files and bytes done of total, and the file being read ("Matching TN0137_final_video.mp4 — 1.2 GB of 4.8 GB read"). Checking no longer reads every image, clip and audio file: it lists names and sizes, then reads only the final videos to match them with their YouTube uploads. Each file is read once instead of three times.
- Clear Uploaded Videos no longer sits on a greyed-out "Verifying…" (owner). It was one long request that read each final video three times and asked YouTube about each in turn, with nothing on screen until the end. It now runs in the background with a progress bar (episodes and GB checked, the file being read), a Stop button, and the same verified rule: only finals YouTube confirms as the exact uploaded video move, into the Trash. A YouTube check that does not answer within 60 seconds, or a drive that stops answering for 60 seconds, becomes a clear reason for that file instead of a hang. Files kept because they could not be verified are now counted in "kept locally".

## v1.4.288 — 2026-10-11

- A Scene Plan that stops before the narration ends is now caught at Scene Plan, never at Video Assembly. Abiding Faith EP0136's plan was made on 31 August from the first 514 seconds of captions; the narration was redone on 11 September to 1505 seconds, and the plan was never rebuilt. Nothing compared the plan with the real narration: the plan's own "length" was its own number (521.5 s), and the "plan older than the captions" check compares file dates, which this plan passed because it had been saved again later. Video Assembly was the first step to measure the narration, and stopped with "984.1s of narration has no planned scene". Now a Scene Plan counts as done only when its scenes reach the end of the current narration (within 2 seconds), so Pipeline runs Scene Plan again instead of skipping it. Scene Plan itself checks this before it asks for any prompt or picture, and if the plan is short it stops at once: "Scene Plan stops …s before the narration ends … Rebuild the timeline in Scene Plan (or use Pipeline Force); no prompts or images were requested." A newly built timeline always reaches the end: it is cut from the captions with no AI, and its last scene is stretched to the end of the narration.
- An episode is "ready for video" only when its Scene Plan is done as well as its Scene Review. Before, approved pictures were enough, so an episode with a short or broken plan was offered for Video Assembly and waited in the assembly line, sometimes for hours, only to fail there. Starting Video Assembly on its own for such an episode is now refused before anything is queued: "Final Video needs a finished Scene Plan first — its scenes must cover the whole narration."
- Video Assembly names a scene with no length instead of calling the whole episode unplanned. Brain Wise EP0040 and EP0041 had July plans that did reach the end (1070 and 1199 seconds), but two and one scenes started and ended at the same moment, where two planning windows met. One such scene makes the coverage check give up, and Video Assembly reported it as "1070.1s of narration has no planned scene". It now says how many scenes have no length and to rebuild the Scene Plan timeline.
- An old image model id now finds the model that replaced it. Brain Wise EP0049's recovery still asked for "flux-2-klein", saved in July, and stopped with "Unknown image model: flux-2-klein". That id now means the free fleet FLUX.2 Klein (`studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit`).

## v1.4.287 — 2026-10-11

- New effects that need no AI model (the approved phase E1 of the effects plan). Every one is off until you choose it for a channel or a scene, so no channel's videos change by themselves, and nothing ever rotates or crops the picture. Each one has a 6-second clip in the Effects Library gallery and works in Render Exact Preview.
- Bedtime Dimming: over a sleep episode the picture slowly gets darker, warmer and a little less colourful — by default 25% darker, warmth 40% (about 6500 K to 4500 K), 10% less colour, starting at 10% of the story and full at 85%, then held through the outro. All five numbers can be changed per channel (Video Assembly's effect list) or per episode. It is drawn after the other effects, so rain and stars dim with the picture, and before the frame, captions and logo, so those stay readable. It skips episodes shorter than 10 minutes and says so. Adds about 3–4 minutes to a 2-hour 1080p render. The gallery clip squeezes the whole dim into 6 seconds.
- Handheld Float camera move (gentle and normal): a tiny, slow, organic sideways and up-and-down drift, as if the camera were held by a very still hand. Never a turn. Each scene drifts its own way. No extra render time; the native renderer draws it.
- Three new transitions in Video Assembly → Transitions: Soft Blur Dissolve (both scenes go soft toward the middle of the crossfade), Dip to Black (fades to black, holds black for 0.3 s, fades up; Fade to Black is unchanged), and Ink Bleed / Watercolour Bleed (the next scene spreads over the last like ink or wet watercolour). They work in random pools like any other. Each chunk keeps exactly the same length as with a crossfade; if FFmpeg cannot draw one, that chunk uses plain crossfades and the job log says so — a render never fails over a transition. The Effects Library has a Transitions tab with every transition as a clip; clicking one renders this scene into the next.
- New overlays: Shooting Star (about one every three minutes, at seeded moments and places in the sky band, never on a fixed loop), Aurora, Moonlight Glow, Clouds in the Sky, Underwater Caustics, Raindrops on Glass, Parchment / Paper, Old Film Dust & Scratches (the faint marks only, without Aged Archive Film's grade), Halation, plus Gentle Bloom and Surface Shimmer as gentler versions of Bloom and Heat Shimmer. The sky, water and glass effects cover a band of the frame you set; following the real sky or water needs the scene-analysis model (a later phase), and each card says so.
- Living Picture: a new Fire pit motion, coarser and slower than the candle flame, so a fire pit no longer gets a fine zig-zag shimmer on the wall inside its outline, and a matching Fire-pit light glow. They follow the owner's fire-pit mock-up.
- Living Picture now works from Video Assembly's own effect list and on the whole episode or a theme: it moves every scene that has an outline with its name (the Outline name setting, or the motion's name — "fire" moves every scene with a fire outline). Scenes without one stay still, and the job log says how many scenes moved. On a single scene it works as before.
- Draw an outline in the Effects Library: on a scene, Outline → Draw… opens the scene picture; draw ellipses, rectangles and polygons, set the feather and a name, and save. It is checked and stored exactly like an uploaded outline.
- Refresh Previews now also redraws the Living Picture tile in the gallery.

## v1.4.286 — 2026-10-11

- Pipeline batch videos now show the Presentation Frame (owner: "if it's on. it show be showing"). The Video Assembly preset never saved the frame into its copy of the effects, so every batch rendered without it even when the channel's Effects preset had it on. It is saved now, and presets saved before this release still get it: when the Effects preset a Video Assembly preset names has the frame on, the batch draws it. Refinanced (5.5% inset, 69 px white border, rounded corners, its paper background) and TerraNash Sleep Stories (4% inset, 18 px white border) will have the frame in their next batch videos. The Pipeline check and the job's effect list name it, with where it came from.
- "Hide captions during the intro" now reaches batch videos. The Video Assembly and Subtitles presets never kept the checkbox, so a batch always burned captions over the branded opening. It is saved now; a preset saved before this release follows the page's own default (captions sit out the opening when the episode has one). Abiding Faith, Boundful and Capi batch videos no longer show captions during their first 6.5, 10 and 8 seconds.
- A batch title card shows the episode's own title, not the title of whichever episode was open when the preset was saved. Scene Plan now reserves time for a title card too (it looked for it in the wrong place).
- The outro video and the timeline clips saved with a Video Assembly preset are its live choices again, and a batch reads the outro where the page saves it.
- Anything switched on that a batch video will not show is said before the batch starts, under "Switched on, but these videos will not show it" in the Run batch window (and as `video_effects.not_drawn` in `/pipeline/preflight` and `/pipeline/run-batch`): Title Image (its picture is picked per episode, so a batch cannot show one), a logo, intro, outro, timeline clip, green-screen or overlay file that is on with no file chosen, and captions that are on for an episode with no subtitles yet. The window also lists what the videos bake in.

## v1.4.285 — 2026-10-11

- Every channel now shows its idea supply at the top of the Ideas page: how many ideas are waiting and about how many days they last at the last 30 days' pace, how many Topic Pack subjects are still unused (per pack, for example "Drinks 3, Food 11, Objects 45"), and which selected packs the Series Formula ignores and why. A channel with no packs says so instead of showing 0. It turns amber when ideas are running low (fewer than 30 unused subjects, or less than 14 days of waiting ideas) and red when they have run out. `GET /api/projects/<channel>/ideas/supply` gives the same for one channel, `GET /api/ideas/supply` for all.
- New per-channel settings under Settings → Channel identity → "Idea supply and repeat checks" (`GET`/`PUT /api/projects/<channel>/ideas/upgrades`). Every switch is off until you turn it on; with all of them off, idea generation is exactly as before. The first time any switch is turned on for a channel, its ideas.json and config.json are copied to `_backups/idea-upgrades-<time>/` first.
- Running-low alert: when switched on for a channel, Story sends one alert (Telegram and/or desktop, as set in Notifications) when that channel's ideas start running low or run out, at most once a day per channel. The two thresholds can be changed per channel.
- Covered-topics map: when switched on, Story keeps a short list of everything the channel's whole history has covered (subjects, people, places, eras, each with a count) and shows it to the idea model, which is told never to make another episode about a covered subject (on Topic Pack channels: to pick a focus inside its assigned subject that is not on the list). The list is made by the helper model you choose for the channel (for example Claude Haiku 5.5, a small paid call: about a cent for the first build of a big channel, then only new ideas are sent). If that model is not available, the map is skipped with a line in the job log and no other model is used. It can be viewed on the Ideas page, brought up to date, or started over (the old one moves to `_trash`).
- Repeat check by meaning, watch-only: when switched on, each Idea Campaign logs which new ideas look like a repeat of an earlier one by meaning ("Watch-only: would reject …"), using a free embeddings model from the Gateway. It rejects nothing; the existing check stays in charge. Every new idea's closest earlier idea and its similarity score are logged, so the "would reject" level (0.78 to start, a per-channel setting) can be tuned after the pilot. Without an embeddings model it uses an improved word check that ignores the channel's title wrapper (such as "| Soothing Bedtime Adventures"), and says so. Paste-import, Add idea and episode-folder import run the same watch-only check and report it in their answer. Each campaign and import adds one line to `idea-campaign-stats.jsonl` in the channel folder.
- Free Up Space has a new category, "Full-quality audio of uploaded episodes": the lossless `.master.flac` that Audio Assembly keeps since 1.4.281, for episodes YouTube has confirmed as uploaded. You see the files and their size first, they move to the channel's `_trash` (never deleted), and the merged MP3 stays.

## v1.4.284 — 2026-10-11

- Living pictures (owner: "the whole animation through story studio must be story studio"). A new Effects Library effect, Living Picture, makes one outlined part of a scene's picture move while everything outside the outline stays exactly as it was: a candle flame flickers and wobbles, firelight glows, steam rises, water ripples and shimmers, a sky drifts, a moon or lamp pulses. Each has a strength and a speed; the defaults match the owner's mock-ups of 2026-10-11. It is drawn by Story's own renderer on that scene's clip, and the outline rides the same camera move as the picture (Metal renderer or FFmpeg), so the flame stays on the candle while the camera pushes in. Off by default: nothing changes for any channel unless a scene's effects use it, and it never rotates anything.
- An outline is an image uploaded for one scene (white for the part that moves, black for the rest) or simple shapes (oval, rectangle, polygon). On the Effects Library page, choose a scene, pick the effect and use Outline → Upload…. Story checks the outline: black and white only, not empty, not the whole picture, between 64 and 8,192 pixels a side, and the same shape as the scene picture; a hard-edged outline is softened so the moving part blends in. `POST /api/projects/<channel>/effects-library/<episode>/outlines` stores one; the Effects Library answer lists them as `outlines`.
- Any effect in a scene's stack can be kept inside an outline too: snow only in the window, embers only above the fire, stars only in the sky. Without an outline an effect covers the whole frame, as before.
- Saving refuses, by name, a Living Picture with no outline, an outline that was never uploaded, and an outlined effect on the whole episode or a theme (an outline belongs to one scene's picture). If an outline goes missing later, the render leaves that effect out and says so in the job log ("… skipped: outline … is missing"); the video is still made.
- Render Exact Preview and the effects gallery show living pictures: the exact preview draws them over the chosen scene exactly as the episode render does, and the gallery shows Living Picture moving inside a sample oval. A scene with living pictures takes about 5–10 s to preview instead of 1–3 s.

## v1.4.283 — 2026-10-11

- The Effects Library is now a gallery you can just look at (owner: "it's just there to see"). Every effect card plays a 6-second clip of that effect on the chosen scene of the episode, with the camera still, without a click. Story renders each clip the first time its card scrolls into view and keeps it, so the next visit shows it at once. A clip is drawn again only when the effect itself changes (so this release's letterbox and Twinkling Stars changes show by themselves), when you pick another scene, or when you press Refresh Previews. Clips are made with the small preview renderer, two at a time, never in the job queue, so they never hold up a Video Assembly; they share the existing preview cache of 200 clips.
- A Camera motions tab shows every camera move the same way: Zoom in, Zoom out and Breathe with their strengths side by side, Dolly In, the eight pans, the Fades, and Blur to Focus. Rotation is never shown.
- Effects and camera moves that this channel's Pipeline batch renders carry an "In use on this channel" badge, read from the channel's active Video Assembly preset with the same rules the render and the Pipeline check use (an old Vignette, Film Grain or Letterbox setting counts as the matching effect).

## v1.4.282 — 2026-10-11

- Letterbox no longer hides any of the picture (owner: "i thought it added black bars but retain the original ratio of the video. it should"). The bars were drawn over the video, which covered its top and bottom. Now the whole picture shrinks to fit between the bars and keeps its shape, with narrow bars at the sides where needed; the video's size stays the same. This is the default for Cinemascope Bars, Widescreen Bars and the old Cinematic Letterbox setting, in renders and in every preview. The old look is still there as an explicit choice, "Cinematic crop (covers edges)", under the effect's Picture setting.
- Twinkling Stars now visibly twinkle (owner: "i don't see much twinkle"). The default was 900 tiny specks whose brightness changed by about half. It is now about 90 larger stars that slowly pulse from full brightness to a tenth and back, every 6 to 12 seconds. Only the defaults changed: a value someone saved renders as before. The Amount setting is a share of 3,000 stars (30 means 900), and the picker now shows the number of stars it gives.
- Vignette, film grain and letterbox have one home: the Effect Library on Video Assembly's Effects step. The separate Vignette, Film Grain and Cinematic Letterbox checkboxes are gone. When a preset that still uses them is opened, each becomes the matching Effect Library effect (Soft Vignette, Fine Film Grain, Cinemascope or Widescreen Bars) with the same strength, marked "Was the classic … checkbox". Those marked effects are drawn exactly where the checkboxes were drawn, so a channel's videos look exactly the same. Saved presets are not rewritten until you save them again.
- Effects are no longer dropped without a word. A built-in effect put in the overlay-file list (which only takes image and video files), a pasted effect description instead of an effect name, and an effect without an on/off setting were all left out of the video before. Now each is moved to where it renders, or named in the job log and in the Pipeline check as "not rendered" with the reason. Story Sprout's and Dozing Knight's Effects presets hold such entries (film grain, and dust motes on Story Sprout); they now show as Effect Library effects when those presets are opened.
- Every Video Assembly says what it bakes in. The job log starts with "Effects this render bakes in: …", the job carries the same list as `effect_stack`, and the Pipeline check and run answers (`/pipeline/preflight`, `/pipeline/run-batch`) include `video_effects`: where the effects come from, the list, and notes. The Effects step shows the same list as "Effective look".
- A Pipeline batch renders the Effects copy saved inside the Video Assembly preset, not the Effects preset list, and it still does. The answer now says so, and flags when that copy has drifted from the Effects preset the Video Assembly preset names (for example a different colour grade), with how to bring them together. An empty Effects choice (`effects_last_preset` "") never meant "no effects": that is now stated in the answer and on the page. Story Sprout's job e1873ed0 took its logo, forest-canopy grade and vignette from its Video Assembly preset's saved copy.
- Effects presets that look like copies are flagged on the Effects step and in the Pipeline check: identical settings, or the same name give or take a plural ("Effects & Overlay" and "Effects & Overlays"). Nothing is deleted automatically.
- Camera moves are easier to pick (owner-approved). Zoom in, Zoom out and Breathe are now one card each with a strength: Zoom in gentle (100→106%, was Slow Push), normal (100→108%, was Ken Burns) and strong (100→112%, was Zoom In); Zoom out the same in reverse (was Slow Pull, Ken Burns Reverse, Zoom Out); Breathe gentle (was Breathe) and strong (was Pulse). Dolly In and the eight pans are unchanged. Parallax Drift is no longer offered: it drew exactly what Pan Right draws. Fade In and Fade Out sit in their own Fades tab. Nothing was removed underneath: every saved preset, pool and episode that names an old move renders exactly that move, Parallax Drift included.
- In a random mix, a family now counts as one pick, and then one of its ticked strengths is used. A pool that held Ken Burns, Zoom In and Slow Push used to zoom in three times as often as it panned; each family now gets the same share as any other move. Pools with no two strengths of one family draw exactly the same moves as before, and an episode's own seed still gives the same mix every time. Because the mix changes for pools that tick several strengths, re-rendering such an episode gives different moves on some scenes.
- Each effect in the Effect Library picker now shows what it adds to a 65-minute 1080p render, and the moving loops (rain, snow, fog, fireflies, stars and the like), which cost the most, are marked.

## v1.4.281 — 2026-10-11

- Night Atlas Nature EP0005 can be assembled. Its 2-hour mix measured -14.7 LUFS with a peak of -1.1 dBTP, already within the allowance, but each try came out over the ceiling once encoded (+2.5, +2.5, +1.2, +1.0 dBTP) and the job failed after an hour of scene clips. The cause was the final video's AAC sound at 192 kbit/s: on dense, noise-like sound such as nature ambience, the encoder itself raised the peak 2 to 4 dB above the mix, which no limiter can hold. The final video's sound is now encoded at 384 kbit/s, YouTube's recommended rate for stereo; on a test sound of that kind the encode now adds about 0.3 dB instead of 4. The video file grows by about 170 MB for 2 hours.
- The loudest peak now comes first. When a try is still over the allowance once encoded and the limiter is not what holds it, Story turns the whole level down after the limiter instead of pushing the limiter lower and the volume back up: enough to land under the ceiling while the loudness stays within its allowance, and never less than the peak allowance needs. Story gives up a little loudness (for example -14.6 LUFS) rather than let a peak through. The try that is kept is always one whose peak is within the allowance if any try was. There are up to 6 tries while no try has its peak within the allowance, 4 otherwise.
- A mix that is already within the allowance is no longer turned up or limited. It is only checked once encoded. EP0005's mix was turned up by 0.7 dB with a limiter before.
- The sound is checked before the pictures. Video Assembly now levels the mix and checks its encoded peak first, before any scene clip is made, so a mix that cannot reach its level stops the job in minutes, not after the scene clips. The final pre-mix starts from the level settled there, and is that same file when nothing about the opening or the length changed. The check of the finished video stays as the last guard.
- Audio Assembly now levels the merged audio to the channel's target (-14 LUFS, -1 dBTP, 20% by default, or what the channel's Video Assembly preset says) and checks its peak the way the final video's sound will be encoded, so a level problem shows up at Audio Assembly. It keeps the levelled mix without loss next to the MP3 (`EP0005_merged_audio.master.flac`), and Video Assembly mixes from that file, so the final video's sound is no longer encoded from an MP3. Episodes merged before this release still work: Video Assembly levels their MP3 at its start.
- `GET /api/app-settings/paid-replacements` returns the four paid-replacement switches (image, subtitle, audio, writing) in one object. Each one is off unless it was switched on on this Mac. When any is on, Pipeline preflight and run-batch answers include `paid_fallbacks_enabled`, for example `["audio"]`.
- Saving channel settings (`PUT /api/projects/<channel>/settings/config`) now says what was saved and what was not: `{ ok: true, applied: [...], ignored: [{ key, reason }] }`. Retired keys such as `audio_models`, `models` and the old concurrency fields are still not saved, and the reason names where they went, for example "use PUT /app-settings/concurrency". Keys sent together with an art style or thumbnail recipe choice are saved too, and are listed under `applied`.

## v1.4.280 — 2026-10-11

- Old upload plans can be removed again. Dozing Knight and Story Sprout each still held a plan from before 2026-10-10 next to the one in use, and removing it failed with "Cannot DELETE": the remove route was taken out in 1.4.249 together with the old upload routes, because the Upload Center no longer had a button that used it. `DELETE /api/projects/<channel>/upload/plans/<plan id>` is back. It also forgets every place the plan was marked active, so a removed plan can never be picked up again. The plan in use for the channel's YouTube account cannot be removed ("This is the active plan for the project YouTube channel. Make another plan active first."), and an unknown plan says "Plan not found". The plans list no longer shows active marks that point at a plan that is gone.
- Subtitles accept a spoken language such as English on Whisper again. A Brain Wise run with subtitles, Scene Plan and Scene Review was refused with "whisper-large-v3-turbo does not publish en as a supported language". The Gateway describes Whisper as "multilingual" without listing each language, and Story read that as no languages at all, so only Auto-detect worked. A language code such as "en" is now sent to a model that says it is multilingual. A model that lists its languages still accepts only those, and a model that publishes nothing about languages is still refused.
- Episodes made before the channel had an Introduction can run their later steps again. Brain Wise EP0040 and EP0041 were narrated in 8 chapters and merged with no Introduction; a later Introduction script made Subtitles stop because "Introduction.mp3" was missing and Audio Assembly's chapter timeline had no Introduction. The Introduction is optional, and what Audio Assembly put together is the episode: when its saved chapter list has no Introduction, Subtitles, Scene Plan and Video Assembly work from the existing merged narration and its chapters. No Introduction is added, and an Introduction file that was made but never put into the episode (EP0040 and EP0041 have one in a different voice) is not used. An episode whose Audio Assembly does include an Introduction still needs it.
- Scene pictures never rotate (owner rule 2026-10-11: "we don't want no rotation at all. it's bad."). Rotate CW and Rotate CCW are no longer offered in Video Assembly's camera moves, and the Rotate tab is gone. A random pick never chooses a rotation, even when a saved pool still lists one; a saved preset whose camera move is a rotation now gets the slow zoom instead. No built-in or new-channel default ever used rotation. Old presets that name a rotation still load. B-Roll's "Rotate — cycle through a pool" is a way of choosing clips, not a camera turn, and is unchanged.

## v1.4.279 — 2026-10-11

- The final loudness check now allows 20% by default, the owner's standard. Every channel's Video Assembly preset already said 20%, and Pipeline runs passed it on, but an assembly started any other way (Retry of an older job, a resumed or paused one, one asked for by the conductor, a recovery job) carried no setting and was checked at 10%. Night Atlas Science EP0002 failed that way: "its peak of 0.4 dBTP is more than the allowed 10%", which passes at 20%. An assembly without its own setting now takes the one in the channel's current Video Assembly preset, so a Retry follows what the channel says today, and 20% when there is none. The Video Assembly page still offers 5%, 10% and 20%, with 20% selected by default.
- Subtitles made on your own Macs (Whisper on Studio Hub) keep going when the Gateway is slow to answer. KH Boundless EP0100 stopped with 17 of its 21 chapters missing and the same sentence for each, "Subtitle recovery interrupted; its saved task/key is retained. No fresh replacement was authorized": the Gateway was taking one transcription at a time, the other chapters' requests went unanswered for longer than the time limit, and each chapter gave up at once. A free chapter now asks again under the same request, which picks up the transcription if the Gateway did start it, and a free chapter whose earlier transcription failed, can no longer be found, or whose file has expired is sent again as a new request, as free thumbnails and voices already were. Paid transcription keeps its careful rules, and when it stops it now says why: the request was interrupted, the next Retry reconnects to it, and a paid transcription is never sent again by itself so it cannot be charged twice.
- Episode recovery names each distinct message once, followed by the chapters it applies to, rather than repeating the same sentence for every chapter.

## v1.4.278 — 2026-10-11

- Audio Assembly now opens the same episode folder as the audio check. KH Boundless Season 005 held two folders starting with "EP0100 - ": the episode's own, "The Bizarre Logistics of the Voynich Manuscript's Move from Prague to Rome", with all 21 chapter files, and "How Aztec Star Watchers Predicted the 1496 Eclipse", left over from before that episode became EP0116, with none. The audio check counted 21 of 21 in the first, but Audio Assembly took the first folder by name and failed every time with "no chapter audio files were found". Audio Assembly, and the episode list's merged-audio check, now prefer the folder named after the episode's own title, and Audio and Audio Assembly now read chapter names with one shared rule.
- Thumbnails made on your own Macs (Z-Image, Qwen and the other Studio Hub models) are sent again after an earlier attempt failed. On EP0092 and EP0100 each thumbnail had an earlier fleet task that had failed, and the check meant for paid images refused to send it again, so the job said only "This image was not made" and no Gateway task was created. Free fleet work now just asks again under a new request, as scene images already did. A paid image that is still refused now says why, for example "because its earlier Gateway task failed in a way that is not safe to resubmit automatically".
- A thumbnail prompt file with fewer prompts than Thumbnail Prompts was asked for (EP0092: 2 of 3) makes the thumbnails it has and says so in the job: "making the 2 it has. Run Thumbnail Prompts again to add the rest."
- Small scene-timing overlaps no longer stop Video Assembly. Brain Wise EP0039 stopped on "11 timing overlap(s) totalling 4.0s", and EP0040 and EP0041 on half a second. When no overlap is longer than 2 seconds and all of them add up to 5 seconds or less, Video Assembly now runs the Scene Plan's own Reconcile timings first, which lines every scene up with the subtitles again and keeps every scene and image, writes what it changed in the job, and carries on. Larger overlaps still stop, and the message now says to use Reconcile timings in Scene Plan.
- A Video Assembly saved before a channel was made self-contained finds the channel's own copy of its intro and logo. EP0095's retry still named the shared "_Project Assets/boundless-assets" files, which are gone; the same files are in the channel's own assets folder, and Video Assembly now uses those.

## v1.4.277 — 2026-10-10

- Your own art styles can now be shared by every channel. A "user style pack" is a list of your custom styles with a name and a one-line description each. Once it is imported, its styles show in every project's Style Library after the store styles, so any channel can pick them. Until now a custom art style lived only in the channel where it was saved.
- Picking a user pack style copies its text into that channel's custom styles, the same as saving a custom style by hand. The channel keeps rendering with it even if the pack changes later. Nothing changes for a channel until you pick a style.
- User pack styles have no preview picture. The Style Library shows "Preview unavailable" with the usual button to make one.
- Import a pack with `POST /api/user-style-packs` (or list packs with `GET /api/user-style-packs`). Importing a pack with the same pack id replaces it. A pack with a mistake is refused with the reason, for example a style id that does not start with the pack id, and nothing is saved. Store style ids (`com.storystudio.…`) cannot be used.

## v1.4.276 — 2026-10-10

- A Scene Plan now goes out of date when the narration under it changes length. On Dreamlands DL0004, Chapter 01 was re-narrated and the audio merged again (6321 s became 6377 s) after the Scene Plan was made. The subtitles were not re-stitched, so Story still called the plan current, and every later picture came about 56 seconds before its words. The Scene Plan now remembers how long the merged narration was. When the merged audio is more than half a second longer or shorter, the plan shows as out of date, the Pipeline does not count it as done, Scene Plan will not continue it, and Video Assembly stops with "the Scene Plan is out of date — the merged narration was 6321.0s when this plan was built and is now 6377.0s (+56.0s)". Nothing is rendered. Re-stitch the subtitles and make the Scene Plan timeline again. A music intro that Video Assembly already shifts for does not count as a change. Plans made before this release have no length saved and are not flagged.
- A re-narration no longer drops the later Pipeline steps. When a chapter was re-narrated while the Pipeline was still on Scene Review, the repair took over that job and its Thumbnails and Metadata were never queued (DL0004; they had to be queued by hand). A Pipeline job that is still waiting or running now keeps its later steps.
- Episode Builder's "New Episode" now continues after the channel's highest episode code. On Coffee Jazz, a channel already at CJ0027, it made CJ0001 to CJ0005 by filling free numbers below. The next new episode there is now CJ0028. Story Studio channels still reuse free numbers on Accept as before.

## v1.4.275 — 2026-10-10

- Video Assembly no longer fails a mix that it had already brought within the allowed difference. Night Atlas Nature EP0002's second try came out at -14.3 LUFS with a peak of -0.8 dBTP, which passes the 10% allowance. Story kept correcting anyway, the peaks jumped to +2.8 dBTP, the limiter went down to -8.1 dBTP, and the mix ended at -16.0 LUFS and failed. History EP0002 also failed: its third try (-14.6 LUFS, -2.3 dBTP) passed, but Story ran a fourth try that could not be measured and errored the job. Story now stops at the first try that is within the allowance. A later try that cannot be measured no longer fails the job: Story judges the closest earlier try instead. If no try is within it, Story keeps the try that came closest and never ends on a worse one. It still has at most 4 tries.
- The peak limiter now goes no more than 3 dB under the ceiling (-4 dBTP for a -1 dBTP ceiling). On busy, bright sound such as nature ambience, the YouTube audio encode moves the peaks around no matter where the limiter sits. Pushing the limiter lower only made the sound quieter.
- The job log shows every try, for example "Loudness: attempt 2 (corrected to +9.6 dB with a -3.9 dBTP limiter) came out at -14.3 LUFS, peak -0.8 dBTP once encoded." When the kept try is not the last one, the log says "Loudness: kept attempt 2". If no try is within the allowance, the error lists every try's numbers.

## v1.4.274 — 2026-10-10

- A finished video may now be up to 10% off its sound level and still pass (owner rule 2026-10-10: "Slight difference in loudness is accepted. We allow 10% difference."). At -14 LUFS that is 1.4 LU either way, and the loudest peak may go up to 0.8 dB over the ceiling (-0.2 dBTP for a -1 dBTP ceiling). Before, a final more than 1 LU off, or more than 0.1 dB over the ceiling, failed Video Assembly and blocked the upload. A final at -14.9 LUFS with a peak of -0.4 dBTP now passes; one at -16 LUFS, or with a peak of +0.2 dBTP, still fails with the reason.
- Video Assembly → Export has a new "Allowed difference" setting under Sound Level and Loudest Peak: 5%, 10% (default) or 20%. It is saved with your presets, and presets saved before this release use 10%. Changing it never makes a render start again.
- Story still levels the sound to the exact target and ceiling, with the 1.4.273 correction for the YouTube audio encode. Only the pass/fail check changed.
- The job log still says "Final loudness: ...". When the video passes but is not exactly on the level, the line says so, for example "Final loudness: -14.9 LUFS, peak -0.4 dBTP (within the allowed 10%)".

## v1.4.273 — 2026-10-10

- Free up space (Archive episode, Convert PNG Scenes to JPEG) now runs while other channels have Video Assembly jobs waiting. It used to refuse whenever any render anywhere was queued or paused, which on a busy Mac mini meant it could never run. Now only a render that is actually running stops it. Any work queued or paused for the episode being cleaned still stops it, as before.
- Cleanup and a render still never run at the same time. While a cleanup runs, a Video Assembly that would start waits in the queue and says "Waiting for cleanup to finish". It starts on its own as soon as the cleanup ends or is stopped. Nothing is lost or needs restarting.
- Music episode thumbnails print the episode's headline once, large and spelled exactly. With "Song title on each picture" on, the thumbnail prompt used to keep the first song's title instruction and add the headline on top, so Coffee Jazz CJ0027 read "Morrting Doffee Jamz" with the first song's title printed twice. The thumbnail now starts from the picture's place, mood and style only, with no song title, and asks for the one headline. This applies both to "Write Thumbnail Prompt From Scene" and to prompts the Thumbnail Generator writes by itself. An existing thumbnail prompt is kept; press "Rewrite Thumbnail Prompt From Scene" to get the new one.
- Song titles on music pictures come out cleaner. Each picture now shows one large sign in the foreground with the exact title in big clean letters: a black chalkboard sign, a menu board or a big window, picked by the song title so a picture's prompt stays the same. About half of CJ0027's pictures had misspelled or garbled titles with the old wording, and the chalkboard wording went 2 for 2. Pictures still have no people. Polish Scene Prompts follows the same rule. Titled pictures made before this release that use Story's own prompt show as out of date, so you can make them again.
- The loudest peak of a finished video now stays at or under the ceiling (-1 dBTP). The YouTube audio encode raised peaks that were under the ceiling in the mix, so CJ0027 came out at -14.0 LUFS but -0.6 dBTP. Video Assembly now measures the mix as the final encode will make it and corrects the limiter until it holds, at most 3 times. The check after the render now allows only 0.1 dB over the ceiling instead of 0.5. A mix that still cannot be brought to the level stops before the long video encode, with the reason.

## v1.4.272 — 2026-10-10

- Video Assembly now handles a music intro. When the merged audio starts with music on its own before the narration (Night Atlas: 8 seconds), the first picture shows during the intro and every other picture moves later by the same amount, so each one still lands on its words. This fixes "8.0s of narration has no planned scene" on episodes whose Scene Plan was made before the intro was added (Night Atlas Science EP0001). No scenes are re-made and nothing is paid for. Effects, reveals, contextual cues and sound design move with their scenes; captions and YouTube chapters already followed the intro and are not moved twice. A real gap between scenes still stops the render, and the job log says when the intro shift was applied.
- A final render of one of these episodes that was interrupted on an older version renders again from the start instead of resuming with the old timing.

## v1.4.271 — 2026-10-09

- Music channels can write each song's title into its own picture. Turn on "Song title on each picture" under Scenes on the Music Formula page (or for one episode in Episode Builder). The picture then shows the song's exact title as natural lettering, such as a chalkboard sign, window lettering or a menu card, still with no people. It works with one picture per song. Use Qwen Image for it: Episode Builder warns when the picked image model draws text poorly (FLUX Klein, Z-Image).
- The Music Formula page has a new "Scene settings" box: the places your pictures are set in, one per line (for example 30 different cosy cafés). Every picture in an episode gets a different one, two pictures side by side never share one, and every place is used once before any repeats. A picture keeps its place when you reorder songs. Song titles and song themes are not affected, and an empty box keeps pictures on each song's own scene idea.
- YouTube status refresh no longer fails with "invalid remote_snapshot.description" for videos whose description has line breaks. TerraNash uploads could not refresh or sync their status because of this.

## v1.4.270 — 2026-10-09

- Finished videos are now as loud as YouTube plays them: -14 LUFS with the loudest peak at -1 dBTP. YouTube plays everything at -14 LUFS and never turns a quieter video up, and Night Atlas Mythology EP0001 measured -24.2 LUFS. Video Assembly measures the whole soundtrack once and brings it to the level with one volume change; only when that would push the peaks over -1 dBTP does a peak limiter step in. Episodes whose audio is already merged get it too. The narration stays on top and the music stays underneath.
- After the render Story measures the finished video and writes one line in the job log, for example "Final loudness: -14.0 LUFS, peak -1.2 dBTP". A video more than 1 LU off the level, or with a peak more than 0.5 dB over the ceiling, fails with that reason, and the file is kept.
- Video Assembly → Export has a new Sound Level setting (default -14 LUFS, loudest peak -1 dBTP), saved with your presets. Presets saved before this release use the default.
- Volume settings now mean what they say. Mixing music and ambient noise under the narration used to divide every layer by the number of layers, so a 150% voice came out at 75% under music and 50% under music and noise. A peak limiter makes sure the louder mix cannot clip.
- Background music is one steady level. Every music track is evened out (no sudden swells) and brought to the same loudness before mixing; the result is kept, so a pool is only processed once. Tracks join with a few seconds of crossfade, a loop never cuts, and the music always fades in and out. The music volume is now the music's level next to the voice: 100% is as loud as the narration, and the new default of 11% is about 19 dB under it, which keeps a sleep or documentary bed clearly beneath the voice.
- Pipeline runs now add background music from the Music Pool. When an Audio Assembly preset's music was set to Music Pool, a Pipeline merge used no music at all (Night Atlas Mythology EP0001). It now picks the same track the Audio Assembly page shows for that episode, with that track's own levels, and logs which one. Pipeline merges also keep the preset's voice volume and pause between parts, which they used to drop.
- The Music Pool's random order now picks the same track for an episode every time, so the page's preview and the merge agree.
- Music is made on the whole fleet. A music top-up used to ask for one track at a time, and only one project's music ran at once. With Gateway 0.2.165 or later, songs and library tracks are sent as background work, which the Gateway runs only on Macs nothing else is waiting for, so narration and scenes always go first. Story keeps as many requests at the Gateway as there are idle Macs for that music model, plus 2, and reads the fleet again as each one finishes, so a 500-song pool fills the fleet without piling up in the Gateway's queue. The Song Pool's "at once" number now only applies to an older Gateway, which gets 6 at a time otherwise. Up to 3 projects' music runs at once. Saved tracks keep their order, one failed track does not stop the others, and Cancel stops them all.
- A song made for the Song Pool no longer appears twice. A pool read while a new song was still being trimmed listed its file as a separate song, so a draw could put the same song into an episode twice. New songs now appear in the pool only once they are finished, and pools are repaired when they are opened: each duplicate is folded into the real song with its plays and rating, and episode plans that named the duplicate still find the song. No audio file is removed.

## v1.4.269 — 2026-10-09

- Once the final video has been checked, its 3-minute render pieces are deleted right away instead of going to the Trash Folder. They are working files, and the finished video is the real output. The video job says how much space this freed. If the render or the check fails, the pieces are kept so the render can carry on from where it stopped.
- A Scene Plan with bad settings (for example "pacing must be an object") now fails at once with the fix in its message, instead of being tried 3 more times. The same goes for a bad subtitle style, a bad scene effect, or a continuity.json that cannot be read as settings.
- Audio Repair no longer tries to collect a result that can never come. If an earlier request was closed at the Gateway (HOLD_CLOSED or discarded), or its audio is gone or unreadable, Repair drops that request. Narration on your own Macs then asks for those parts again straight away, and the chapter is joined when they arrive. Paid voices are never asked again by themselves: Generate missing sends the new request when you are ready.

## v1.4.268 — 2026-10-09

- An upload plan can now change its rhythm on a date. In Settings → Publishing or Upload Center → Plans, press "Change the Schedule From a Later Date…" and set "then from <date>: <days> at <time>", for example Mon and Thu until 31 Dec, then Mon, Wed and Fri from 1 Jan. The plan uses each rhythm on its own dates, in the same time zone. The plan's summary shows both rhythms.
- The plan ends on the last rhythm's end date, if it has one. A plan with one rhythm works exactly as before.
- Planning dates, Edit Planned Dates, and dates that follow episode order all work across the change: each date lands on the days and time of the rhythm it falls in.

## v1.4.267 — 2026-10-09

- Video Assembly keeps its place when Story Studio stops in the middle of a render. The final render, the longest step (about 93% of a TerraNash episode), is now made in 3-minute pieces, and each piece is saved as soon as it is finished. After an update, a crash, Quit or a power cut, Video Assembly carries on from the first unfinished piece, so at most about 3 minutes of rendering is done again instead of the whole video. The pieces are joined without re-encoding into one video with the same picture and sound: on a test with TerraNash's effects, every frame matched the video made in one piece.
- A render that was interrupted is finished with exactly the settings it started with, even after an update, as long as the episode's files and settings have not changed. If they have, the video is made again from the start, as before.
- Two effects are random, and their random pattern starts again at the point where a render resumed: film grain and the vignette's very fine dither (less than one shade of brightness). It looks the same.
- A long still image at the end of a video (TerraNash's 60-minute background after the story) is now rendered once for 30 seconds and repeated, instead of being drawn frame by frame for the whole hour. This only happens when nothing moves on it: no captions, cues or effects reach it. On the Mac mini (measured on 1.4.262) the still rendered at about 1.2 times real time, so a 60-minute still took about 50 minutes of the final render and a 120-minute one about 1 hour 45 minutes; now it takes under a minute.
- Finished pieces go to Story's self-emptying Trash Folder once the final video is checked (deleted after 15 days).
- Updates now install as soon as they are ready. Story pauses new work, waits for requests already sent to the Gateway to be answered (at most 2 minutes), lets any job that cannot pick up where it stopped finish first, then installs and restarts, and everything else resumes after the restart. Settings → About → Updates now says "Installs as soon as it's ready (work resumes after the restart)". Install Now still works, and if you paused the queue yourself, the update waits for you.

## v1.4.266 — 2026-10-09

- Pipeline Scene Plan no longer fails with "pacing must be an object" after Story restarts. A saved Pipeline step lost its pacing and motion settings whenever Story restarted while that Pipeline was still running, so the Scene Plan later in the chain failed 3 times in a row. Settings are now saved whole. Jobs saved by older versions are repaired when Story starts and when you press Retry: each setting is taken from the same episode's earlier Pipeline step, or failing that from another episode in the same Pipeline run. A plain Retry of the failed Scene Plan now works.
- Video Assembly with reveal effects and crossfades now makes the whole video. With Scene Plan timing, a reveal scene ended exactly where the next crossfade had to start, so each group of 48 scenes kept only its first scene or two. EP0001's 140-minute render came out 4 minutes long and failed every encoder and every automatic retry. Reveal scenes now run on under the crossfade like every other scene.
- If the joined scene video is ever much shorter than the audio, Video Assembly stops right away with a clear message, before the long encode. It no longer tries 4 encoders 3 times over (about an hour) for a result that cannot work.

## v1.4.265 — 2026-10-09

- Narration no longer keeps collecting a Gateway result that can never come. When an earlier request was closed at the Gateway (for example by "Resolve All Needing Recovery" after a Gateway restart), Story used to collect that same request on every retry and fail each time with HOLD_CLOSED. Now narration on your own Macs drops it and asks again straight away. Paid voices are never asked again by themselves: the part fails, and pressing Retry sends a new request.
- Every narration download is checked before it is used: it must not be empty, and it must hold readable audio. A bad one is downloaded once more. If it is still bad, narration on your own Macs makes that part again, and paid voices leave it for your Retry. Before, an empty file stored at the Gateway failed every retry with "FFmpeg exited with code 183 … moov atom not found".
- Retry after a narration download failed now sends a new request. It used to send the original request again and get the same broken result back.
- Automation keys can no longer revoke keys. Only your password session can create or revoke them.

## v1.4.264 — 2026-10-09

- Narration starts the next episode early. When a running episode has 20 or fewer parts left, the next queued episode starts beside it, so your Macs don't sit idle while the last parts finish. At most one extra episode starts this way (with 2 at a time set, never more than 3). Queue order, your pauses and the paid-work rules are unchanged.
- Subtitles now fix skipped sentences themselves. When the subtitle check finds that the narration skipped script sentences, Story narrates only the part that holds them again on your own Macs, then makes that chapter's subtitles again. Each chapter gets at most 2 automatic tries; after that the job says the chapter is left for you. Paid voices are never redone automatically. The job output says what was redone.
- Video Assembly uses your Mac's hardware video encoder (Apple Media Engine) when no encoding effort is saved, and changing the quality no longer switches a hardware render back to a CPU preset. If the hardware encoder can't start, the CPU encoder takes over by itself. Saved settings are kept: a channel that saved "Ultrafast" still renders on the CPU until you choose "Fast (hardware)".
- The video job now says which encoder made the video: "Encoder: hardware (VideoToolbox h264)" or "Encoder: software (libx264)", with the reason when the hardware encoder could not be used. The encoding progress line shows it too.
- The Presentation Frame's rounded corners are about 3 times faster to render and look exactly the same. On a test with TerraNash's effects, 8 minutes of video took 117 s instead of 331 s. Turning the frame off is faster still (50 s).
- A custom logo position now lands where the preview shows it at every size. The X/Y numbers are set on a 1920 × 1080 preview; a 720p video used them unscaled, so a logo at X 1650 was drawn off the right edge. Logos are also kept inside the picture.
- New logo Shape setting (Video Assembly → Effects & Overlays → Logo Overlay): None (as before), Rounded corners (with a corner size), or Circle. The shape is cut once per video, so it adds no render time, and the preview shows it.

## v1.4.263 — 2026-10-09

- The Script Generator now uses the full page width, like the other generator pages. On wide screens it was narrower, with empty space on both sides.
- Script text in Script Preview and in a chapter's preview keeps a comfortable line length, so long lines stay easy to read on wide screens.

## v1.4.262 — 2026-10-08

- Publish dates follow episode order. When a finished episode is scheduled automatically, or you apply the upload plan, the planned dates of videos not yet on YouTube are shared out lowest episode first. If 173 finishes after 245 and 390, it now takes the earliest of those dates and 245 and 390 move later. The Upload Center says "Dates follow episode order; N episodes shifted" when that happens.
- Videos already on YouTube (uploaded, scheduled or public) and videos being uploaded keep their dates. Nothing is sent to YouTube. No date moves earlier than now or past the end of your plan.
- Old update downloads now go to Story's self-emptying Trash Folder and are deleted after 15 days, instead of piling up (about 240 MB each) in `_trash`. What is already in `_trash` stays yours.
- After a restart, an update no longer installs before Story has finished loading the job queue. Until then the queue can look empty while saved jobs are still on disk.

## v1.4.261 — 2026-10-08

- Updates wait for your work: a downloaded update no longer pauses the queue. It waits until nothing is running, queued or paused, then installs and restarts. Settings → About → Updates shows "Update … ready — installs when the queue is empty (N jobs left)", and says so when a paused queue still holds jobs. Install Now still pauses the queue, lets running jobs finish and installs; it asks first when jobs are in the queue. The "When to install" choice is gone.
- Old app copies left behind by updates now clean themselves up, like Studio Hub: the previous version waits in Story's Trash Folder for 15 days (so an update can still be rolled back), then is deleted. Your own `_trash` folder is never touched, including the old copies already in it.
- Free up space shows how much the old app copies take, and that they empty themselves after 15 days.

## v1.4.260 — 2026-10-07

- API key is now called Gateway API Key; the release signing key is now the App Update Key
- Video Assembly skips already-portable path requests, resolves independent paths together, and keeps newer episode choices when an older request finishes.
- Cold audio scans use bounded parallel probes; simultaneous reads of the same file share one probe.
- Content Pack listings recheck installed and recovery trees after nested files change.
- Startup health checks and stalled update downloads release their shared waits within a deadline, so controls and later checks can proceed.
- A fresh Gateway Update Now request is acknowledged only after a verified update attempt starts; old rollback reports cannot consume it.

## v1.4.259 — 2026-10-07

**Updates from the Gateway**
- Story Studio can now update itself from the Gateway (Settings → About → Updates): it checks every 30 minutes, waits for running jobs, installs, restarts and resumes; it rolls back automatically if the new version doesn't start. Every Gateway request now names its Mac.
- A release that isn't fully on the Gateway yet is simply tried again at the next check; a failed install is retried after about an hour, and a re-published release right away.

**Speed**
- Big channels are lighter on the app: job lookups no longer copy the whole job history, render progress is saved in batches, and Scene Review, Free up space and the topic-pack list read much less from disk.
- Audio lengths, narration documents, the ideas list and the FFmpeg check are remembered until their files change.
- Episode recovery stops re-saving and re-checking episodes that haven't changed.

**Reliability**
- Failed work retries itself: free fleet work always; chat steps (paid ones too, without paying twice); free images and Whisper. Errors that would fail again are not retried, and the message says what to fix.
- After a restart or an update, writing steps and uploads pick up where they stopped; an upload resumes and is never uploaded twice.
- Installing waits for running jobs, and Quit asks first when jobs are running (never during an update).
- Stuck episodes are repaired: subtitles made before a chapter was re-narrated count as missing, a repair reuses your last normal mix, and a check that can't be verified says so on its job.
- A failed save of the job list no longer stops that channel's job list from saving again.
- One-click Rebuild Timeline.

**Done means done**
- Video Assembly follows what is switched on and checks the final video's length.
- YouTube descriptions stay under 4,900 bytes and are trimmed instead of failing; chapter marks are required.
- The thumbnail is required for upload; playlist failures are reported.
- Chapter and intro checks, chapters tied to the outline, and real cue counts.
- The Production Board and Overview show one episode state; Scene Review waiting for your approval is shown.

**YouTube**
- Upload status is checked automatically until YouTube says the video is ready; "not found" is told apart from "couldn't check".
- Check All Uploads on the Upload Center.
- Reconnect on every channel, and when its sign-in expires.

**Storage**
- Free up space shows free disk and what is in _trash, and says why nothing is offered.
- Motion clips are counted; leftovers are offered for _trash.
- Convert PNG Scenes to JPEG.
- Final videos can be freed once YouTube confirms the upload.

**Self-contained channels**
- A channel can carry its own assets and finished videos: preview the move, then apply. Final videos live inside the channel.

**Screens**
- Usage page no longer goes blank; Back sits on its own row.
- Dark mode uses Story's orange accent instead of pale gold.
- Retry All asks first. Jobs has episode search, links to one episode, pages, and the same words everywhere; its actions stay visible.
- Production Board and Pipeline: select episodes and retry, open in Pipeline, keep your place, Run Batch stays in view.
- Previous / next episode buttons; the sidebar logo goes home, with Jobs, All Jobs and All Channels pinned.
- Scene Review leads with Check Again; attention chips stop at 12 with "more".
- Publish shows 50 rows at a time, with the bulk panel on demand.
- Dialogs share one style; Content Store has Back and Esc; breadcrumbs say Production Board and Upload Center; buttons use Title Case.

---

## v1.4.258 — 2026-10-07

- Re-narrated chapters can be transcribed directly before Audio Assembly. Full-episode transcription still requires a verified episode mix.
- Multiple chapter repairs keep every transcription handoff. Audio Assembly waits for the known chapter checks, then refreshes the episode once with its saved mix settings and stitches current subtitles locally.
- Clear Finished preserves verified repair progress. Changed audio, missing parts, malformed files and unknown chapters cannot be treated as checked.
- Chapter Retry and Retry All keep their requested scope and saved provider identities; completed chapters are preserved.

---

## v1.4.257 — 2026-10-07

- Much faster Overview, Production Board and channel opening on big channels (episode list re-checks gradually; last list shows instantly on reopen; Refresh no longer rebuilds everything — Shift-click for a full rebuild).
- The app no longer freezes while scene images are being made (no needless job-file rewrites; much smaller live updates).
- Video encoding runs at lower priority and leaves 2 cores free, so the app stays responsive.
- Scene prompts and scene images on your own fleet no longer stop part-way: they retry automatically a few minutes apart, a stuck image is requested again, and edited prompts or styles no longer block old requests.
- Scene prompt runs on paid AI models also retry automatically (the earlier answer is collected first, so nothing is paid twice).
- Narration part files are kept until you choose to remove them in Free up space (new 'Narration parts' line and choice); nothing is moved automatically.
- The Usage (credits) page has a Back button at the top left; Esc and ⌘[ go back.
- The Free up space card fits the window.

---

## v1.4.256 — 2026-10-06

- **The Production Board remains scrollable in both directions.** Its episode table keeps the episode column visible while scrolling through production stages.
- **Upload status appears beside production readiness.** The Board shows queued, uploading, processing, uploaded, recorded, and failed states from saved upload evidence, and opens the selected episode in Upload Center.

---

## v1.4.255 — 2026-10-06

- **Large Pipeline batches start with fewer repeated checks.** Episode checks run in bounded parallel work, and Start still verifies current files before queuing.
- **Scene prompts repair themselves while making progress.** Complete rows from a truncated response are kept, invalid duplicate rows remain repairable, and only missing or invalid scene IDs are requested again. Repair stops after repeated no progress or an unresolved request.
- **Free fleet scene images recover without repeated manual Retry.** Stale prepared requests are refreshed only after the Gateway proves they were never submitted, completed images stay saved, and settled failures receive bounded missing-only retries. Slow free fleet work no longer becomes an automatic ten-minute pause; manual Pause and Cancel still apply.

---

## v1.4.254 — 2026-10-05

- **Narration pieces that fail on the fleet are retried automatically (twice), so episodes finish on their own.**
- **Subtitles can be made straight from your script, timed exactly to the narration — Khmer uses this automatically;
  any channel can choose 'Script-timed' on the Subtitles page (fast, exact words, no transcription needed). Exact
  timing needs Studio Hub 0.6.146+; older narration is timed per piece.**

---

## v1.4.253 — 2026-10-05

- **Server mode: automation keys — an AI helper on another Mac can work with this Story Studio over Tailscale using a
  key you create in Settings → Server Mode, without ever knowing your password; keys can be revoked any time and can't
  change your sign-in settings.**

---

## v1.4.252 — 2026-10-04

- **Narration pauses are longer and more natural: 1 second after each sentence and 1.5 seconds between paragraphs.**
- **Fair turns: each request tells the Gateway which project and episode it belongs to, so a small redo or a second
  project doesn't wait behind a big batch.**

---

## v1.4.251 — 2026-10-04

- **Khmer narration: sentences end at ។.** The 220-character rule, request splitting, pauses and timing now work for
  Khmer; text is never cut inside a Khmer syllable.
- **A re-run never gets back an old failed result.** If the Gateway answers a fresh narration request with an earlier
  free failure, Story asks again.

---

## v1.4.250 — 2026-10-04

- **New: the Music format.** A music channel now has its own flow in the sidebar. **Song Pool** writes song briefs
  from the channel's **Music Formula**, makes the songs on your own Macs and keeps them in pools (the Music Library's
  songs can be added in one click). **Episode Builder** draws an episode's songs from one or more pools without
  repeating recent ones, lets you lock, swap and reorder them on a timeline, joins them with crossfades at matched
  loudness, writes the tracklist and plans scenes per song. The thumbnail can come straight from a scene, the YouTube
  Finalizer turns the tracklist into chapters, and the Pipeline can run the whole music chain.
- **New: Effects Library.** Rain, snow, fireflies, dust, embers, stars, petals, fog, light rays and more, with a live
  preview, per-scene ranges with fades, stacking order and presets. Video Assembly says what an episode's effects add.
- **One narration file per chapter.** A long chapter that is made in parts is joined into one file with natural pauses
  and matched loudness, and the parts stay hidden so a single part can still be redone. Every voice now pauses the same
  way: 0.6 s after a sentence and 1.0 s at a paragraph break, and 3 s between chapters. A channel can still set its own
  pauses in the Series Formula or on the Audio page. Narration sentences are kept under 220 characters so a voice never
  cuts one in the middle; saving a chapter splits any longer sentence at a natural break without dropping a word.
- **Redoing a failed part now finishes the chapter.** When one part of a split chapter failed and was made again, the
  chapter was never joined and Repair said "Nothing to repair". Now the parts are joined, and Repair joins a chapter whose
  parts are all there without making any narration again.
- **Waiting is not failing.** A busy, slow or restarting Mac now reads "waiting for a free Mac" and Story asks again by
  itself, instead of dropping chapters or showing them as failed. The Jobs page uses one count everywhere, music has its
  own lane, and Audio Assembly picks up again after a restart instead of saying "Interrupted by app restart".
- **Pause, Resume and Cancel you can trust.** Resume works while a pause is still taking effect, episode recovery waits
  for narration before Audio Assembly, and Cancel on a video render stops every encoder. Encoders left behind by a crash
  are stopped when Story starts.
- **Subtitles find skipped sentences.** After subtitles are made, each chapter's script is compared with what was
  actually said; any sentence the voice skipped is listed with **Re-narrate Chapter N**. Gaps in subtitles lead with
  Re-narrate too, and the Audio page shows the Mac's own check of each section.
- **Video Assembly remembers.** Each episode keeps the settings of its last render, and a new episode starts from the
  channel's last one. A title image at the start no longer pushes the scenes out of step with the narration, and the page
  warns before Generate if they would drift. Size and time estimates now match a measured render. Sleep captions are
  larger and easier to read at 1080p.
- **New channels start with their Formula's look.** A new Sleep Story or Sleep History channel starts with 20-30 second
  scenes (and Sleep Story with its soft, dreamlike look), both editable. Stories avoid reusing recent main character
  names.
- **No surprise charges.** Pickers never pre-select a paid image, voice or music model; free models on your own Macs
  read "free", and a writing pool that is only paid as a last resort says so.
- **Fixes from the Dreamlands test.** Audio Assembly refuses to merge when music is on but no track is chosen, and lists
  only a chapter's active versions; "Use This Version" really makes that take the chapter's narration; re-merging keeps
  the episode's music track; Audio Assembly remembers the music bed on this Mac; Scene Plan stops offering a repair the
  server already refused; What's New closes on the first click; several wording fixes say "Gateway" instead of
  "GenStudio".

---

## v1.4.249 — 2026-10-03

- **Settings, redesigned.** A list of sections on the left and a **Find a setting** box that jumps straight to any
  control. Each section shows what you change most; rarer options sit under one **Advanced**. Performance & recovery is
  now short steppers with one-line hints, the four "buy one replacement" cards are one table, and the section has one
  **Save**. Appearance & notifications no longer lets you scroll past the end of the page. The triangles on Writing &
  style's cards sit inside the card.
- **Folders are chosen, not typed.** Library folder, finished videos folder and "move to another drive" all use a
  **Choose…** button with the Mac's own folder picker and **Show in Finder**. You can now pick where finished videos go;
  videos you already made stay where they are and are still found.
- **One upload schedule.** Settings → Publishing shows the channel's active upload plan by name and edits the same plan
  as the Upload Center, so you save it once.
- **One Free Up Space.** The four overlapping ways to free disk space are one card in Files & maintenance: the
  recommended "shrink and tidy uploaded episodes", plus clearly labelled options to clear verified uploaded videos, move
  uploaded videos to another drive, or choose exact files. A read-only list shows what is using space. Nothing is ever
  deleted — files go to `_trash` or are verified at the new place first.
- **Writing models, simpler.** The LLM lineup is retired: each writing step uses the one model (or Gateway pool) chosen
  on its page or preset, and falling back across models is the pool's job. Your old lineups were turned into the
  matching pool once, and the Pipeline tells you so. A writing job that hits a confirmed "quota used up" waits and tries
  again later instead of failing.
- **New: live thumbnail template preview.** The template editor redraws your unsaved edits instantly, with a sample
  title box and text and font controls. It now says plainly that these text settings only shape the gallery preview
  card — real thumbnails get their headline from the image model.
- **New: regenerate prompts for selected scenes.** On Scene Plan, tick scenes (or shift-click a range), press
  **Regenerate Prompts**, and only those scenes' image prompts are rewritten. Images, approvals and timings are untouched;
  a scene that fails keeps its old prompt and stays ticked for a one-click retry.
- **New: episode counts on Home.** Each channel card shows how many episodes it has, how many are on YouTube, how many
  are being made now and how many need attention.
- **New: bulk actions in the Upload Center.** On Publish, tick rows (shift-click for a range, or select all that match)
  to queue uploads, edit planned dates, schedule on YouTube spread over days, set visibility (Public, Unlisted or
  Private — Public warns that subscribers may be notified), re-finalize metadata, or remove waiting uploads. Every
  action says whether it changes YouTube, confirms with the exact count and reports each row.
- **New: Analytics table.** A sortable, searchable table with a period picker, totals and CSV export, plus subscribers
  gained, impressions and click-through rate. Missing analytics access reads "Not available — reconnect YouTube", never
  zero.
- **A cleaner look everywhere.** One style for every dropdown, one turning chevron for every collapsible section,
  primary buttons that no longer jump on hover, and **Title Case** button labels across the app.
- **Leftovers from the last round, fixed.** Edits made while a save is running are saved right after instead of lost;
  the Jobs page pauses its live updates while the window is hidden and catches up when you come back; Outline and Script
  share one **Regenerate** for a chapter; Content Store purchases keep going if you leave the page; a free voice on your
  own Macs shows "free" instead of a quote; Settings' advanced panels are in plain English with the technical wording
  one click away under **Details**.
- **Image references follow what a model can do.** Reference images and paid image replacement now depend on what the
  image model supports, not on whether it is paid, so free models on your own Macs keep their reference-image features.
- **Clean-out.** About 20,000 lines of old code are gone: retired iCloud and cloud-folder leftovers, the 1.4.3 upgrade
  card, the old upload queue, unused server routes and components, the switched-off Expression/auto-pause narration
  feature, the old "script only" lane, the unreachable Pipeline B-roll step, hidden blocks on the Image Prompts page,
  Scene Review's old clip code, confirmation switches that did nothing, and the unused channel URL field. Duplicate
  buttons on Audio ("Get quote"), Sound Design ("Add Spot Effect") and the Thumbnail Generator ("generate missing") are
  now one each. Stale text and links that pointed at pages that no longer exist are fixed. Files on disk are never
  touched.
- **Heavy media on another drive is retired.** A channel that never used it no longer shows the option; a channel that
  uses it keeps working and keeps the option. Nothing is moved.
- **Fixes.** Video Assembly now asks for merged narration up front (chapter audio alone could not render) and links
  to Audio Assembly; the one-off narrator style typed on Scripts now reaches chapter writing; the Research guide no
  longer suggests research can block an episode — it never does.

---

## v1.4.248 — 2026-10-03

- **"Gateway" means your Gateway.** Everywhere Story Studio talked about your own Gateway connection it said "GenStudio" —
  pickers, job messages, errors and settings now say **Gateway**. "GenStudio" is kept only for the paid cloud service:
  your GenStudio credits, buying credits, the GenStudio paid image service and the Content Store.
- **Jobs page you can actually use.** Every pop-up message has a ✕, action messages disappear after 8 seconds, and at most
  three show at once (the rest wait in the bell). Two main buttons: **Check on running jobs** (free — collects anything
  that finished and never starts new work) and **Redo failed jobs**. Every other button stays visible with one plain line
  saying what it does. The dashboard's "Repair N failed jobs" now opens Jobs already showing the failed ones, and the
  filters use the page names (YouTube Finalizer, Audio Assembly).
- **Retry really redoes a failed writing job.** Retry used to replay the same failed answer forever. A failure that cost
  nothing is now redone with a fresh request, and on a free writing model (like your Gemini free pool) even a failure
  the Gateway is still unsure about is redone fresh. Paid models keep the old safety lock, so nothing is paid twice.
- **Thumbnails no longer fail in a second with "Automatic image replacement is unavailable".** The message is now plain
  ("This image was not made, and nothing new was sent or charged…") and **Redo failed jobs** makes it again.
- **An overnight Pipeline run keeps going when one step fails.** Only the steps that need the failed one wait; Retry on
  the failed job continues exactly those, without repeating or paying for the others. The Production Board shows failed
  steps as ✕ with a **Failed only** filter, and now shows **25 episodes per page**.
- **Story Studio never picks a writing model for you.** If a page or preset has no writing model chosen it stops and says
  where to choose one. Paid writing models show a **Paid** badge. Your LLM lineup no longer switches to a newer model on
  its own: a retired choice shows "*model* was retired — choose a replacement".
- **Writing pages keep your work.** Research, scripts, outlines, introductions, ideas and cue edits are no longer lost when
  you switch episode or a job finishes; idea titles with "/" can be accepted; Un-accept moves files to `_trash`. Saving a
  cue edit keeps a half-finished cue proposal, so the next "Propose cues" pays only for what is missing. Retry after
  "your Topic Packs ran out of subjects" uses the packs the project has now. Ideas presets no longer change your
  channel-wide title prefix/suffix.
- **Images, scenes and B-roll.** Thumbnail board Generate/Regenerate works again; thumbnail settings are remembered; Scene
  Plan and Scene Review never throw away unsaved edits or a render that just finished; Scene Review's **Pause** and
  **Cancel** say in plain words what they do; B-Roll "avoid repeats" really counts episodes.
- **Audio and subtitles.** Sound Design fits a 1280-px window; removing music or a subtitle file moves it to `_trash`
  instead of deleting it; Music Library has its sidebar back; Subtitles has one less duplicate "Transcribe" button (use
  the top bar or a chapter's own button).
- **Finishing.** The YouTube Finalizer never writes one episode's title into another; "Update YouTube" asks before
  changing a live video; a render with subtitles switched on but no subtitle file asks first instead of shipping without
  captions.
- **When the Gateway is off you are told.** The sidebar and header say "Gateway not reachable — open the Gateway app",
  errors read "Could not reach the Gateway — is the Gateway app running?" and every error now shows its next step.

---

## v1.4.247 — 2026-10-02

- **Cancel reaches a narration or music job that is already running.** Cancelling a narration or music job while it is running on a Mac now
  tells the Gateway, which stops the work, and the job shows as cancelled instead of failing. Cancelling a music top-up job is no longer refused.
- **Faster scene clips.** Scene clips for the final video are now made by a small built-in helper that uses the Mac's video hardware, with
  the old method kept as a fallback, so rendering a video takes noticeably less time.
- **Gemma 3 12B is gone.** Story Studio never asks for the retired Gemma 3 12B model, just like the retired LTX video model.

---

## v1.4.246 — 2026-10-02

- **Smaller files, your choice.** New switches in Settings let you shrink each kind of asset: narration arrives as compact AAC (m4a),
  music as m4a, and scene images and thumbnails as JPEG or PNG. Turn a switch off to get the original, uncompressed file.
- **Cancel really cancels.** Cancelling a narration or music job now stops the work on the Mac, not only in Story Studio, and the job
  shows as cancelled.
- **Music length and time limits follow the Gateway.** The Gateway decides how long a job may take and Story Studio is told, so
  a long music job is no longer cut short by a limit Story Studio guessed.
- **Plain error text.** When something fails you now see a sentence in ordinary words, not an internal code.
- **LTX video is gone.** Story Studio never asks for the retired local LTX video model any more.
- **Faster, lighter review screens.** Review grids load small cached thumbnails, Motion Review loads scene stills only as you scroll, and
  the Jobs page pauses its clock and polling while the window is hidden.
- **Safer saves and a faster start.** Files are written through a temporary file so a crash cannot leave half a file, jobs.json is
  smaller, and finding an episode no longer walks through every episode before it.
- **Free up space: Clear preview cache** now moves the small preview images to the project's own `_trash` instead of deleting them.
- **Audio is not re-encoded unnecessarily.** A music list that is all MP3 is left alone, and narration chunks already delivered as MP3 are
  stored unchanged. A list that mixes MP3 and AAC no longer silently loses tracks.

---

## v1.4.245 — 2026-10-01

- **"Free up space" is now easy to find and asks you for no folder.** It is the first thing on Settings →
  Files & maintenance, has its own **Free up space** link in the project sidebar, and appears on every
  uploaded episode in the Upload Center (Publish). The list of uploaded episodes loads by itself, with the
  episodes not yet freed already ticked, and one button, "Free up space for N selected", shows how much it will
  free and which `_trash` folder the files go to before you confirm. Nothing is deleted; you empty `_trash`
  yourself, and episodes without a verified YouTube upload are never touched.
- **The two folder pickers are out of the way.** The old "Archive uploaded videos" box (a "Look for videos in"
  folder and a "Move them to" folder) is now a collapsed "Advanced: move uploaded videos to another drive"
  section, and the "copy to another folder" choice in the media review is an advanced option. The default is
  always the project's own `_trash`.

---

## v1.4.244 — 2026-09-30

- **"Free up space" now has a one-click "Archive episode", and nothing it removes is ever deleted.** For an
  uploaded episode it shrinks the scene images (re-saved as JPEG under their same names, about 12% of the
  size) and moves the motion clips, the chapter narration and the uploaded final video to a `_trash` folder
  beside your media (same drive: in the project folder, or under your media folder when heavy media lives on
  another drive). The preview shows the before and after ("412 images 490 MB → ~57 MB; 3.1 GB moved to
  _trash — space is freed when you empty _trash"). Thumbnails, merged narration, subtitles, scripts, prompts
  and metadata are never touched. It runs one episode at a time, one image at a time, and refuses while any
  video is being assembled on this Mac. "Select all uploaded and not yet archived" picks the episodes still to do.
- **Removal is a move, not a delete.** The old "Remove local files" and the Storage page's "Verify & clear
  local video" now move the files into `_trash` (kept under episode / category folders, a timestamp added if a
  name is already there, existing `_trash` contents never touched). If a file cannot be moved it is left where
  it was. You empty `_trash` yourself; space is freed then.
- **Generated music is stored as AAC.** A WAV track from the music model (about 43 MB) is saved as a .m4a at
  256 kbps; an MP3 is kept as delivered, and if encoding ever fails the original WAV is kept (the track is
  already paid for). New narration is encoded at 96 kbps instead of 192 kbps (24 kHz speech, no audible change).

---

## v1.4.243 — 2026-09-30

- **Model pickers now show what a model really costs, and say so when nobody has published a price.** The
  gateway (0.2.82) states, per model, who gave the price: the provider, your own Macs, or nobody. A provider
  price shows in real dollars with its unit and date (for example "$0.075 / 1M input tokens · $0.30 / 1M
  output tokens · as of 2026-09-30"), your own Macs read "Free — your fleet", and a model nobody has priced
  reads "Price not published" (not $0, not free). This covers the chat, image, video, voice, transcription
  and music pickers. The zero credit figures the gateway still sends only to keep old readers working are
  never shown as a price. A gateway that does not send the new fields behaves exactly as before.
  A price the owner researched from the provider's own pricing page reads "from pricing page, <date>" with a
  link to that page; when the page lists several prices for one thing (by size, quality or tier) they are all
  listed as "varies" and none is picked.
- **A finished job shows the cost its provider stated.** When the provider's own response states what it
  charged, the Jobs ledger shows it ("$0.0027754454 provider cost"). When it did not, nothing is shown, never
  "$0".
- **Run Batch shows an estimated provider cost before anything starts.** It multiplies each paid step's known
  per-unit price by what that step will use where Story Studio genuinely knows the amount (one image per scene
  still to render, one clip per scene; a pricing-page price counts too), calls your own Macs' steps free, and lists every step it could not
  price as "not included" with the reason (price not published, priced per token so the length is unknown,
  scene count not known until Scene Plan has run, the page lists several prices for it, the model comes from a model policy, ...). It is labelled an
  estimate and adds no new gateway calls.

---

## v1.4.242 — 2026-09-30

- **`npm run typecheck` is green again, and now runs as part of `npm test`.** The frontend type-check
  reported 269 errors, all in `electron/server/**`, because one type reference dragged the whole server
  into the frontend's (deliberately lax) compiler: a request type in `models/types.ts` named its reveal
  settings through the reveal engine, which pulls in every service. The settings type now lives next to the
  reveal selection code it describes, so the frontend no longer type-checks the server under the wrong
  rules. Nothing at run time changed.

---

## v1.4.241 — 2026-09-30

- **A job waiting for a Mac now says so.** When the gateway is running a job but no Mac has started it,
  the Jobs card reads *Waiting for a free Mac — next try 09:30 (reason)* instead of "GenStudio is
  generating", and its "last progress" line is no longer coloured as if the job had hung. There is still
  no timeout: waiting is waiting.
- **Cancelling a gateway job now works end to end.** A job the gateway ends by cancel arrives as failed
  with `cancelled: true` (older gateways sent a `cancelled` state; that is read the same way). It is
  terminal in every wait loop (chat included, which used to poll it for hours) and in the reconciler, and
  a job that is still waiting for a Mac offers *Request cancellation* when the gateway says a cancel will
  be honoured.
- **A result the gateway lost and then found is no longer thrown away.** A failed job the gateway is
  still holding as an unknown outcome (a gateway restart, an ambiguous read) is not final for about five
  minutes: Story keeps polling, shows it as still working, and takes the finished result if the gateway
  adopts it. After the window the failure stands as before.
- **The gateway's own failure codes are understood.** `PROVIDER_SUBMISSION_UNCERTAIN` and
  `PROVIDER_QUOTA_EXHAUSTED` are recognised alongside the GenStudio-cloud spellings from one shared list
  instead of by a regex that happened to match, and `LOCATION_NOT_READY` / `LOCATION_UNREACHABLE` can be
  retried by hand (they add no automatic wait on top of the gateway's own). A capacity failure the
  gateway holds as an unknown outcome is never auto-resubmitted, because it may have started real work.
- **Image artifacts may be JPEG or WebP.** The gateway relays each provider's own format; Story used to
  refuse anything that was not a PNG with "invalid PNG artifact".
- **Settings → Test connection reads the voice catalogue properly.** `/v1/tts/models` answers
  `{models, freshness}`, which the probe did not read, so the voice-catalogue check was silently skipped.

## v1.4.240 — 2026-09-30

- **Error toasts no longer misdiagnose unrelated numbers.** The friendly-message rewrite matched bare
  digits, so "Scene 12 image missing in EP0401" read as *API key is invalid*, "Could not save file
  (4096 bytes)" as *already running*, and an image size like `1536x1024` as *Server error*. A status
  number now only counts after `HTTP` / `status` / `error`. When a message is rewritten, hovering the
  toast shows the original text.
- **"Cannot reach the GenStudio gateway" replaces "check your internet connection".** Story Studio only
  talks to the gateway, so a refused or timed-out connection means the gateway app is not running or
  its address is wrong, not that the internet is down. Both the toast and the job-error hints say so.
- **Unsaved Scene Plan, Introduction and Sound Design edits are protected.** Leaving the page, switching
  project, switching Scene Plan episode, or closing/reloading the window now asks *Discard unsaved
  changes?* instead of throwing the edits away (the window prompt is Stay / Discard and leave). Declining
  keeps the previous episode selected.
- **Jobs no longer promises an "Estimated provider wait".** The number is when the gateway will check
  again, not a prediction of the provider finishing, so it now reads *Checking again in about 2 minutes*.
- **More destructive clicks ask first.** Music library *Remove* (the file cost credits), *Clear failed*
  jobs (it removes the only place Retry and the error detail live), and removing a reference thumbnail,
  scene reference, master image, composition template or episode visual anchor. Re-rendering *all*
  thumbnails now says it replaces and re-charges, and always asks even if "skip confirmation" was ticked
  for thumbnails.
- **A failed job now has an *Open job* button, and failures in other channels reach you.** The toast opens
  that project's Jobs page; a job that fails in a channel you are not looking at raises the same toast.
- **Live job updates come back on their own.** After the live stream dropped, progress refreshed every
  10 s until you changed channel; it now retries the stream about once a minute. A second confirmation
  opened while one is showing no longer leaves the first one hanging, and the Pipeline remembers the
  episodes you ticked when you leave for Jobs and come back.
- **Removed dead code:** eleven `loading-label` attributes that never rendered, the Thumbnail Generator's
  call to a `/imagestudio/models` route that no longer exists (it 404ed on every open), the local
  voice branch of the voice picker, and the unreachable Scene half of the Thumbnail Generator page (its
  Scenes tab, prompt preview card, scene integrity checks and Browse grid).

## v1.4.239 — 2026-09-29

- **A thumbnail whose submit never landed now retries instead of failing forever.** When the gateway
  answered `No such job` for a prepared image's idempotency key, that was the *gateway* saying no
  provider work existed — the one reading under which submitting again cannot duplicate paid work.
  Nothing acted on it: the recovery fell through to `uncertain`, which the image generator throws on,
  so every attempt failed with *"Could not confirm the prepared image by its idempotency key:
  GenStudio KH request failed: No such job."* The message named the cause exactly, once per attempt,
  and the job could never progress. The thumbnail path now passes `allowPreparedReplayOnAbsent` for a
  `prepared` entry that has an idempotency key and no task — the same allowance
  `continuity-render` has always made, and gated the same way: only a **recovery** may replay, never
  an explicit fresh render, and only when the gateway *authoritatively* reports the key absent (a
  404, never a timeout or an uncertain answer).

## v1.4.238 — 2026-09-28

- **Installing Story Studio no longer throws away the version it replaces.** Installing is one
  command now — `bash scripts/release/install-local.sh` — and it keeps the app it is replacing in
  `_trash/app/`, named with the version it was, so going back is one copy away. The old instructions
  were four commands typed by hand, and the step that moved the old app assumed a folder that only
  exists if a previous install made it. Twice it was not there and the install carried on anyway,
  writing the new app over the old one: that is how **1.4.236 was lost** when 1.4.237 went in. The
  folder is the owner's to empty, so it is now created every time, and if the old app cannot be moved
  aside the install **stops** rather than quietly replacing it.

## v1.4.237 — 2026-09-28

- **The window's traffic lights no longer land on the logo when you scroll.** On the channels page
  the bar that reserves the strip along the top — the one carrying the Page guide and the version —
  **scrolled away with the page**, so the page header slid up underneath the close, minimise and
  zoom buttons, which are part of the window and cannot move. The cause was one line: that bar's
  style said `position: sticky` and then, further down the same rule, `position: relative`, added
  when the version chip was layered on top of it. When a rule sets the same property twice the last
  one wins, so the bar was never sticky. `sticky` already does everything `relative` was there for,
  so the duplicate is gone and the strip stays put.
- **And a check so the next one cannot hide the same way.** A property written twice in one rule
  leaves the first copy sitting in the file looking like it works, which is why this needed a
  screenshot to find rather than a reading. The test suite now rejects any rule that sets a property
  twice, and pins that the titlebar strip is sticky and that the version chip keeps a positioned
  ancestor.

## v1.4.236 — 2026-09-28

- **A retired model can no longer be quietly swapped for a different one.** Music top-ups resolved
  their model with `models.find(m => m.id === params.model) || models[0]` — directly under a comment
  reading *"a retired product must fail here, before anything is charged."* It did not fail. A job
  naming a model that is no longer sold was silently moved to whichever music model the account
  lists first: a different product, at a different price, charged as though it had been chosen. The
  comment described the intent and the next line broke it. A named model the catalogue no longer
  offers is now **refused by name, before anything is charged**.
- **Image jobs that name no model are refused instead of being given a retired one.** `generateImages`
  resolved `req.model || 'grok-imagine'` — a hardcoded product id, retired from the live catalogue
  since. A job without a model was routed at that product, and the error it eventually produced
  named a model nobody had picked, which reads as a catalogue fault rather than a missing field. The
  Images form starts with no model selected, so this was reachable by generating before touching the
  picker.
- **Unchanged on purpose:** when a music top-up names *no* model at all, the first published model is
  still used — that is what the Music page prices on screen beside that model's own name, so the
  figure shown is the model used. The defect was only ever the silent substitution of a *named*
  model. Both halves are pinned by tests that call the rule rather than read the source, and the old
  expression was put back to confirm those tests go red on it.

---

## v1.4.235 — 2026-09-28

- **A model that is unavailable now says why, in the words of whatever told us.** When the
  GenStudio endpoint reported a model as locked, the reason was replaced with a fixed sentence
  about your account — so a studio whose Macs were all switched off read as *"Locked for this
  GenStudio account."*, which sends you to billing for an outage. The reason the endpoint gives is
  now shown exactly as it was sent (for example *"No Mac offering this model is reachable — every
  Studio Hub location that offers it is offline or not taking customer work."*). The paid-account
  sentence is unchanged when that is genuinely what the endpoint says, and a locked model with no
  stated reason says only that it is temporarily unavailable — never anything about an account.

## v1.4.234 — 2026-09-27

- **Holds now land on your narration lines and your music beats.** A reveal's hold could only be as
  long as its scene's window; it can now end where the line it is covering ends, or where a sound
  cue lands, when that is within a third of a second of where the pace already put it. It is a
  tolerance rather than a magnet on purpose: a line a second and a half away would stretch or crush
  the scene to hit it, which is the padding the pace setting exists to avoid. The job log says how
  many holds snapped and to what.
- **The Image Pool reveals too, and its pace changes how many images an episode needs.** The pool
  recycles stills at a fixed seconds-per-image; with reveals on, the pace decides how long one
  still stays, and the play order is built from that number — so a slower pace needs **fewer
  images** to cover the same narration. That is the saving the whole feature is for, and it now
  reaches both visual sources.
- **A snapped hold is exempt from the "never shorter than the window" rule**, deliberately: the
  rule stops the pace from cutting a long narration line short, while a snap moves the hold a
  fraction of a second to land on the line. Applying both would have undone every snap in silence,
  which the tests now pin in both directions.

## v1.4.233 — 2026-09-27

- **The reveal library has nineteen presets, not twenty, and now says so.** Fifteen wipes, three
  palette looks and one draw-on. The count was wrong in the 1.4.229 notes and in the design
  document, and the receipts from that release had already contradicted it: *76 clips across four
  paces* is 19 × 4, not 20 × 4. A test now pins the library's own composition — fifteen, three and
  one — so the number cannot drift again.
- **The three reveal routes have tests.** The catalogue, the plan and the per-scene choice are
  driven over HTTP against a real episode plan: the same settings plan the same episode twice, a
  stored choice is what the next plan resolves, clearing it goes back to the derived pick, and the
  choice is written into that episode's own `scene_plan.json` rather than a page cache.
- **The handoff's header repeated a sentence** since 1.4.232 (the audio switch was announced
  twice), and the 1.4.229 summary carried the same wrong preset count. Both corrected.

## v1.4.232 — 2026-09-27

- **Reveal effects ship end to end.** The engine landed in 1.4.229 and nothing could choose one; now
  Video Assembly has a **Reveal effects** panel: on/off, pace, how often the look changes
  (every scene / once per act / once per episode), an episode seed, a cap per effect, and the pool
  of arrivals to draw from. The panel lists the **planned arrivals** — each scene's look with its
  reveal and hold — from the same resolver the render calls, so what you read is what renders.
- **A per-scene reroll.** Scene 7's arrival can be redrawn on its own; the choice is saved with that
  scene in the episode's own scene plan, and it is a *new* choice rather than the old one written
  twice. Everything else stays deterministic: the same seed and pool reproduce the same episode.
- **The payout is the pacing.** A scene at Slow is a 1.6 s arrival and a 10.4 s hold — one image
  carrying a whole narration line. Measured on a six-scene sequence: **72 s from 6 images where the
  5 s/image baseline needs 15 — 9 fewer, 2.5×**, and three frames sampled inside one hold differ,
  so the hold drifts rather than freezing. Receipt:
  `docs/receipts/reveal-episode-slow-20260927/`.
- **Presets ship as Content Packs.** A new `reveal` pack kind carries a reveal document and its
  family; installed packs append to the library, and a pack may never claim one of the engine's own
  built-in preset id or disagree with its own document's family.
- **The pace never trims your script.** The pace band sets how long a scene *wants* to be; a long
  narration line wins, and the hold absorbs the difference rather than the scene being cut short.
- **Two honest limitations, both named in `docs/reveal-effects.md`:** holds do not yet snap to
  narration lines or music beats (the plan is resolved before those are read, and the render
  fingerprint depends on that order), and the Image Pool path recycles stills on its own timing, so
  reveals do not apply there.

## v1.4.231 — 2026-09-27

- **You can ask a video model for a clip with no sound — where the model offers the choice.** Motion
  Review now renders a switch for every boolean parameter the *selected* model publishes: the local
  LTX lane publishes `audio` (on by default), and a cloud lane that publishes nothing shows no
  control at all. The control is built from the model's own published list, never from a family name
  and never from `generates_audio`, which answers a different question — whether the product makes a
  soundtrack, not whether you may ask it not to write one.
- **The lane's own sentence is what the switch says about itself.** `note` travels from the lane and
  is shown verbatim: for `audio` it says the model makes picture and sound in one pass, so a silent
  clip is **not** cheaper or faster — it skips the audio decode and writes an MP4 with no track.
  Unticking the box changes what the file contains and nothing else, and the page says so rather
  than letting the switch imply a saving it does not make.
- **The choice is part of what you asked for.** It travels on the request, in the recovery hash, and
  in the idempotency key, so a retry can never re-attach to the other half of the switch — the same
  rule that makes `instrumental` a component of the music key. It is restored by Motion Review
  presets (a reusable setting, not episode state), and an unattended Pipeline run honours the saved
  choice when the model it resolves publishes it.
- **A value the model cannot honour is refused, not dropped.** The three clip routes validate the
  switch against the row they priced and refuse a value for a model that publishes none, or a
  non-boolean value, before anything is queued; a queued job that outlives a catalogue change drops
  it and records the line in the job log.
- **Not wired, deliberately:** the retired `/generate/video` lane has no caller in the app and was
  left alone rather than half-wired; its clips use the model's own default. Needs gateway-kh
  **0.2.60**, which publishes and forwards the switch; against an older gateway no model publishes
  one, so the page shows no control and nothing is sent.

## v1.4.230 — 2026-09-27

- **The thumbnail-reference vision feature could not run at all (WIRE-3).** Its model gate required
  `max_input_images >= 1` and a non-empty `supported_detail_levels`, and **no gateway publishes
  either** — the parse turns their absence into `0` and `[]`, so every model failed and the vision
  model list was always empty. The one fact that decides it, `supports_vision: true` (published from
  the provider's own `architecture.input_modalities`), sat unread beside them. Eligibility now rests
  on what is published: available, not locked, states image input, and is not stated to refuse
  structured output. The per-image limits are enforced when a model states them, and where it states
  none the file goes and the gateway's own upload rules answer for it.
- **The menu now says whose numbers it is showing.** A detail level or limit a model did not state
  is labelled `story` (`detail_source`, `reference_limits_source`), so a choice Story made is never
  presented as the model's own.
- **Two dead fields are gone: `availability_reason` and `available_again_at`.** They described a
  temporary model absence the old GenStudio published; no catalogue has carried either since, so the
  cooldown they fed was code that read as a working feature. What replaced that fact is a *job's*
  retry window — already on every job and already rendered in the Jobs window — and Story's own
  quota measurement (`noteLlmLineupQuotaExhaustion`) still drives the shared-availability path.
- **A catalogue refusal now names the gateway's own reason.** `activation_blockers` (gateway 0.2.59)
  reaches `GenStudioChatProductUnavailableError` and its message, so an operator is told why a model
  is unusable instead of reading the generic sentence. The three other readers of that field
  (`/api/models`, the pickers) were already joined to it.
- **Retirement warnings can fire now, once a model he uses retires.** Gateway 0.2.59 publishes the
  retirement family from the provider's own `expiration_date`; Story's parse and surfaces for it
  already existed and were reading `null` forever. Measured on live data: 28 provider models state an
  expiry today, none of them among the 75 enabled rows — so the mechanism is proven and quiet.

## v1.4.229 — 2026-09-27

- **Reveal effects — the engine.** A scene still can now *arrive*: a geometric wipe, a stack of
  palette layers, or a drawn-on line — and then hold while it drifts. Nineteen presets ship in three
  families (`geometric`, `palette`, `draw-on`), the six wipes the design names as reading well on
  photoreal frames are the default pool, and everything renders locally through the FFmpeg this app
  already bundles — no model, no memory tier, so it also runs on the 8 GB Macs that cannot touch
  FLUX or video.
- **A reveal plus a hold is what pays for it.** One image can carry 10–15 s instead of 5, which is
  where an episode's images — the expensive fleet step — come down. Holds drift 3–8% continuously
  (a frozen frame reads as a slideshow) and stage one to three micro-events at the narration lines
  and music beats the pipeline already knows. Pace is a per-episode setting — Fast / Standard /
  Slow / Documentary — because overdone, slow pacing reads as padding.
- **Randomisation that does not look amateur.** One seed per episode, derived per scene, so a
  re-render is identical and a per-scene reroll moves *one* scene instead of resequencing the
  episode; a pool, never the whole library; no immediate repeats; a cap per effect that starts a new
  pass rather than running one look into the ground; **the duration is never randomised**, only the
  look; coherence modes per scene / per act / fixed. Verified: the same preset, pace and window
  rendered twice gives the identical MP4 (sha256 `8fa79ca5…`).
- **The draw-on is honest about what it is.** It is a directional wipe across the line art, not a
  stroke-ordered trace — that needs a vector trace this version does not do — and the preset says so
  in its `approximation`, which the picker shows rather than quietly rendering something else.
- **Engine only in this release: no surface chooses a reveal yet, and the assembly does not use one
  yet.** `docs/reveal-effects.md` records exactly what shipped and the next slice in order (the
  settings surface, the Content Pack kind, then the assembly integration that turns the longer
  clips into fewer generated images).
- Three private copies of `mulberry32` — in `transition-filters.ts`, `broll-selector.ts` and
  `generators/video.ts` — are now one (`lib/seeded-random.ts`), because reveal selection would have
  been the fourth. The algorithm is unchanged, so every existing seeded sequence is unchanged.
- New: `scripts/reveal-preview.mts` renders one clip per preset per pace with a receipt; 24 engine
  tests in `electron/server/__tests__/reveal-engine.test.ts`. Verified on real images — 76 clips
  across every preset and pace, plus draw-on against line art.

## v1.4.228 — 2026-09-27

- **A motion clip carries the shape it was priced at.** The video catalogue now publishes each
  duration/resolution row with its own `aspect_ratio`, and this app carries it through the transport
  (`GenStudioVideoVariant.aspect_ratio`) instead of guessing. The guess was `16:9`, or `9:16` for a
  portrait request — and on a Studio Hub video lane that is not a shape the lane has. Its canvases are
  pairs on the model's 64-pixel grid: `11:7` (704x448) and `1:1` (448x448) at `448p`, `7:4` and `4:7` at
  `256p`. Measured 2026-09-27: `16:9` at `448p` was refused by the lane outright (*"448p is not published
  for 16:9"*), and the one canvas the lane did accept for `16:9` was the canvas its pack rounds down to
  2:1 — so the clip that came back was a different shape than the label on it. The ratio now travels
  with the row: where a product publishes one per row this app sends exactly that, where it publishes
  only a ratio list (every cloud lane) it reads the one matching the requested orientation, and where it
  publishes none at all the field is omitted and the lane's own default decides.
- **A duration and a resolution can name two different pictures, and the row is what tells them apart.**
  `GenStudioVideoVariant` now includes the ratio, the scene-clip selector picks the row whose ratio
  matches the request rather than the first duration/resolution match, and a ratio the catalogue does not
  publish for that duration and resolution is refused by name — naming the ratios it does publish —
  instead of being submitted and refused downstream.
- **Motion Review only offers shapes that exist.** The ratio picker and the size picker were two
  independent lists — every published ratio beside every published size — which offered `11:7` at `256p`
  and other combinations no row carries. Where the catalogue states a ratio per row, both lists come from
  the rows, the duration list follows the chosen row, and changing the ratio re-snaps the size and length
  onto rows that ratio actually has. A product that publishes only a ratio list behaves exactly as
  before.
- Two hand-built catalogue fixtures in the chat-limit suites now state `max_output_tokens_source: null`
  explicitly; they had omitted a required field, which `npm run typecheck:electron` reported.

## v1.4.227 — 2026-09-26

- **A published limit now names its author (HUB-20, our half).** Studio Hub 0.6.72 began publishing
  `model_limits.*.source_kind` and GatewayKH 0.2.48 relays it as `max_output_tokens_source`, but this app
  read none of it — so a limit the *worker defaulted* was printed as if the model had stated it. The
  measured case is the local chat lane: the checkpoint ships no `generation_config.json`, the Hub's
  fallback is 16,384, and the live row says `worker_default` while every surface here showed the number
  bare. `GenStudioChatModel` now carries the label (both producers' vocabularies: `provider | model |
  curated | gateway | worker_default | unknown`), `/api/models` forwards it, and Scene Plan renders
  *"That limit is the worker's fallback, not the model's own figure"* beside the allowance. An absent or
  unrecognised label stays `null` — "we were not told" is not "the model said so", and folding null into
  `provider` is the defect this ends.
- The `up to N output tokens` chip in the batch summary carries the same sentence, so the picker and the
  line beneath it cannot describe the same number two ways.
- No other behaviour changes: the allowance, the option ladder and the request are exactly what they were.

## v1.4.226 — 2026-09-26

- Documentation and comments only; no behaviour changes. A cross-repo audit found stale claims in the
  handoffs and trackers, and each was checked against the code before it was corrected. Three comments in
  `electron/server/lib/chunked-narration.ts` still described the reservation ratio against a
  `OUTPUT_TOKENS_PER_WORD` of 1.3; the constant has been **1.6** since the measurement was re-taken, so
  they now say 1.6 and the thresholds they imply are **372 / 2,932 / 8,052** for 4,096 / 8,192 / 16,384
  output tokens. (The audit's own list said 8,051; the function returns 8,052, and the code wins.)
- `_handoffs/2026-09-26_story-reply-tokens-per-word.md` carried the same off-by-one in a table; corrected
  with its arithmetic shown.
- `_handoffs/2026-09-26_plain-english-open-items.md` said the model's own `max_output_tokens` provenance
  "is not built yet". The producer half **is** built — Studio Hub 0.6.72 publishes it and GatewayKH 0.2.48
  relays it — and what is missing is our side: the app does not read `max_output_tokens_source` yet. The
  item now says so instead of blaming the other end of the wire.
- `_handoffs/2026-09-26_next-session-prompt.md` told the next session "no subagents, no spawned workers",
  which contradicts `AGENTS.md` §10 (the owner's 2026-09-20 ruling: act as the orchestrator and delegate
  bounded work). The prompt now matches AGENTS.md and keeps the one-writer-per-file rule that made it safe.
- `docs/tasks/HANDOFF.md` pointed at `_trash/app/` for replaced bundles. That folder is gone — the owner
  deleted it by hand — so the file now says where they would be instead of implying they are there.

---

## v1.4.225 — 2026-09-26

- Scene Plan no longer refuses a scene pack because a model publishes no item limit. **This is the other
  half of v1.4.224's fix, and the half the 30-scene pack runs through** — Contextual Cues was corrected
  there, and Scene Plan kept treating an unpublished `max_structured_items_per_request` as a limit of zero,
  so the pack stopped before making a single request and the message read "above its published unpublished
  item limit". **This is why raising Studio Hub's output ceiling to 16,384 did not open the 30-scene pack:**
  the refusal was on the item count, not the token count. The pack now goes out bounded by the model's
  published output tokens — a bound that was already enforced in the same function, and is unchanged — and
  a model that **does** publish an item limit is still held to it exactly, with the refusal naming the number.

## v1.4.224 — 2026-09-26

- Contextual Cues no longer refuses to run because a model publishes no item limit. An unpublished
  structured-item limit was treated as a limit of zero, so the feature stopped before making a single
  request on models it could well have handled — and the message read "above its published unpublished
  item limit". It now sends the batch (bounded by the model's token budget, as every other structured
  step is) and lets the provider answer; a model that **does** publish an item limit is still held to
  it exactly as before, and the refusal names the number.

## v1.4.223 — 2026-09-26

- Scene Plan's motion-prompt step no longer asks for less than the model publishes. It clamped its
  output allowance to 4,096 tokens whatever the selected model allowed, so a model publishing 16,384
  was asked for 4,096, split into batches as if it were a 4,096-token model, and described that way in
  the job log — a limit attributed to a model that never published it. The step now uses the published
  allowance, and its batch is sized from that figure as every other step already was. Motion prompts
  are short, so on a large model this means fewer, fuller batches rather than longer answers.

## v1.4.222 — 2026-09-26

- Chapter batches are now split on a measured estimate of how long a model's answer runs, rather than
  an optimistic one. At an 8,192-token output ceiling, three 1,200-word chapters used to pass the size
  check by **twelve tokens** — a fit that survives only if the model is exactly as brief as the
  estimate, and comes back cut off when it is not. The estimate now sits at the typical measured rate
  (1.6 tokens per word, from a 17-sample measurement on the local lane and our own two samples), so
  those chapters go out two per call instead of three, and three per call return at a 16,384-token
  ceiling. Nothing else changes: the figure is still only used to decide how to split work, never as a
  limit on what a model may return, and it still only ever shrinks a batch.

## v1.4.221 — 2026-09-26

- Scene Plan no longer asks a model for more than its output allowance can return in one answer.
  A window of scenes comes back as a single JSON response, but the automatic window size was chosen
  from the model's *input* budget alone — so a model with a huge context window and a small output
  limit (your local Studio Hub model publishes 262,144 tokens in and 4,096 out) was asked for thirty
  scenes it could never finish, and the plan came back cut off. The window size now also respects the
  published output ceiling, which for that model means about ten scenes per request. Models whose
  output allowance is not the binding constraint are unchanged, an unpublished ceiling caps nothing,
  and an explicit window size still overrides both.

## v1.4.220 — 2026-09-26

- Chapters and other narrative writing now work on your local Studio Hub models. Every prose request
  sent an explicit `response_format: {"type": "text"}`, a shim for a rule the old service had; your
  gateway does not need it, and a Studio Hub lane refuses it outright — so chapter expansion failed with
  “response_format.type: must be json_object or json_schema; received str 'text'” before a word was
  written. Prose now asks for no response format at all, which is what "plain text" means to every
  provider behind the gateway. Structured steps (outlines, thumbnail prompts, metadata) are unchanged.
- An answer that uses its entire output allowance is no longer accepted as finished. A local model given a
  4,096-token ceiling wrote a chapter that stopped mid-sentence, and reported `finish_reason: "stop"` — so
  nothing upstream objected and the half-written chapter was saved as complete. A language answer whose
  reported token usage equals the ceiling the request asked for is now treated as cut off: the run fails
  loudly, keeps the parts that did finish, and tells you to choose a larger model or a smaller batch
  rather than presenting a truncated draft as done.

## v1.4.219 — 2026-09-22

- The Production Board now notices a finished video that appears, is replaced or is moved away in your Library's **Exports** folder. Final videos are written outside the project folder, so the board could stay stuck on an old answer — an episode whose video had been archived away still read as assembled, and a newly finished one could read as unfinished — until some unrelated file inside the project changed. That folder is now watched, and every episode's saved status is recomputed once when you install this update.

## v1.4.218 — 2026-09-22

- Scene Plan's **Build timeline** no longer ends in an error after doing its job. Building the timeline is
  deliberately model-free: it writes each scene's timing and leaves the visual prompt for the next step.
  The completion check then insisted on those visual prompts and failed the run — “reported success, but
  re-reading its output found required items missing” — after retrying three times, even though the
  timeline was correct. A timeline-only run is now judged by the timeline it produced (real, forward-running
  scene timings plus the record that a timeline was built); planning visuals and Pipeline runs are checked
  for prompts exactly as before.
- A failed **YouTube Finalizer** run now really can be repaired by **Retry**. When a provider answered with
  fewer items than asked for (say one tag instead of fifteen), the run correctly refused the incomplete
  package — but the retry re-sent the identical request, so the provider returned the same answer and the
  job failed the same way, while the message told you to retry. Retrying a finalizer run now asks the
  provider for a fresh answer, so the missing fields are really regenerated; a run that kept your own saved
  choices is untouched.

## v1.4.217 — 2026-09-22

- Scene Plan's creative controls — Creative intensity, Recurring motifs and Avoided imagery — no longer sit off the edge of their card. At an ordinary window size the card was narrower than the three columns those controls asked for, so the third control was laid out past the card and past the window and could not be seen or clicked. They now wrap inside the card, and all four intensity choices show their full names.
- Scene Review's primary action no longer runs off the right edge. On a 1440-wide window the “Finish …” button and its status line were laid out 13px past the window and were cut off; the command bar now shrinks to fit instead.
- Settings' notification **Save** bar now stays in view while you work in the Notification center. The panel clipped it into a scroll container of its own, which quietly cancelled its sticky behaviour: the bar only appeared once you had scrolled to the very end of the page. It now sticks to the bottom of the window for as long as that panel is on screen.

## v1.4.216 — 2026-09-22

- A failed Introduction check no longer reads as “this channel has no Introduction”. Pipeline and Audio say they could not check the channel setting, keep the pre-spend warning visible, and offer Retry and a link to Introduction — instead of quietly writing episodes without the opening.
- Deleting a Scene Plan now leaves an actionable “No plan yet” card with a Build action, instead of a heading with nothing under it.
- A failed media read no longer reads as a confident empty answer. Video Assembly states that the asset check failed and can retry it rather than leaving the first step blank; the transition list and the subtitle-file check show when they are loading and offer Retry when the read fails, instead of sitting on “Loading transitions…” or claiming the episode has no subtitle file; and Subtitles and the chapter selector say they could not read the chapter audio or sections rather than telling you to generate audio or a script you already have.
- Settings reads FFmpeg’s real status when you open its tab instead of offering a repair download it has not justified, and a failed check now says the status could not be read rather than reporting FFmpeg as not installed. A project’s saved YouTube category is no longer cleared when the project record reloads, so an unsaved choice and the saved value both survive; switching projects still blanks it and re-hydrates it from that project’s own settings.
- Scene Plan has a second guidance box, **Reusable guidance**, for a rule you want on more than one episode. It is saved into Scene Plan presets and applied only when you apply that preset — it is never written to the project settings and never applies on its own. The **Custom instructions** box stays per-episode: its text is now cleared when you change episode (and says so), instead of silently steering the next episode’s prompts. When both boxes have text, the planner receives them labelled so the job log shows which is which.
- A lettering style bought as a Content Pack now reaches the image prompt. The picker showed the swatch you paid for, but prompt writing looked the style up in the app’s built-in list only, so a pack font silently became the plain serif. Pack styles are now resolved from the installed catalogue; if that catalogue cannot be read, the job says so instead of quietly downgrading a style you own. Choosing **Custom…** and describing your own font or treatment now sends that description to the writer too — it used to fall back to the built-in serif or gold finish and ignore what you typed.
- A job waiting on a GenStudio cancellation now says why when the key is missing — the control names the missing key and where to add it, instead of only "Checking cancellation". Add the key and the same button works again.
- A restart after paid work settled no longer reports an error over finished output for **metadata**, **thumbnail prompts** or **research**: each now verifies its own files before calling the work done, and still says repair-required when the output is genuinely incomplete.
- Regenerating a single thumbnail row keeps the font and text finish you chose; the row no longer describes an unchosen font.
- The audio quality check no longer says the script changed when it did not. A run with expression markup or automatic pacing recorded a fingerprint of the text it submitted, while the check recomputed the fingerprint from the script file — so those chapters were reported stale even though nothing had been edited. Both sides now fingerprint the script on disk, and a real script change is still caught.
- **Metadata Formula** packs can now be delivered and installed. They are the shapes an episode’s YouTube write-up can take — its sections, lengths, title shaping and tone — and five still ship free with the app. This also fixes the catalogue saved on your Mac being thrown away whenever it contained a font pack: the reader that validates a saved catalogue had never learned that kind, and one unrecognised product discarded the whole cache.

## v1.4.215 — 2026-09-21

- Job rows now name the provider that served each model (for example “DeepSeek V4.1 Flash · Token Harbour”) wherever the catalogue publishes one. Provider is display only: it never selects, ranks, or routes a request, and a model with no published provider shows nothing rather than a guess. The name is remembered for old rows after a model retires.
- A gateway with no Content Store connected is no longer reported as a bad API URL or key. The key test says the Store is not connected instead of telling you to check a working key; generation is unaffected.
- The built-in GenStudio endpoint is now `http://127.0.0.1:8787`, matching the gateway, so a fresh install reaches it without setting the URL by hand. A saved per-Mac URL is unchanged.

## v1.4.214 — 2026-09-21

- A missing GenStudio API key no longer repeats the same waiting message and rewrites the job record every five seconds. The job still keeps its duplicate lock and resumes reconciling the same provider cancellation as soon as the key is configured.
- A restart that leaves already-paid GenStudio work no longer strands the job. When a settled provider task has no completion audit for its job type, the job now fails with a repair/Retry message instead of running forever with no Retry path, and its provider evidence is retained.
- Audio status no longer predicts another episode's chunk split. When an episode has no recorded voice model and no audio job of its own, the split is borrowed from project history only when every retained audio job names the same model; conflicting models are treated as unknown rather than guessed.
- Character Sheet clears the previous episode's anchors, pacing and references the moment the episode changes, instead of leaving them live until the new configuration finishes loading.
- A render that falls back from the styled subtitle document now records the captions it lost. Word-by-word captions, animation, precise placement, blur, rounded boxes and line wrapping that the fallback cannot draw are listed on the job result and marked degraded, instead of reporting a clean success.
- The All Jobs stream now tells the page when its first snapshot could not be read and buffers live updates behind that snapshot, instead of only writing to the server log. An unreadable queue status is shown as unknown rather than as a running queue, and the pause/resume control stays disabled until the state is known.
- Job types now read with one human label everywhere — Jobs rows, completion toasts and the episode dropdown — covering thumbnail, motion, expression, image-pool and music work that previously showed raw internal ids. The permanently empty retired Scene Images tabs are gone, a filter that hides every job says “no matching jobs” instead of “no jobs yet”, the subtitle Retry tooltip no longer names a Repair control that is not shown, and Retry no longer offers legacy prompt/image jobs the backend refuses.
- A workspace read that fails no longer renders as a confident empty answer. Scene Review shows a retry instead of “No scene plan yet”, Research says it could not check GenStudio access instead of claiming the API is unconfigured, and Pipeline says it could not load accepted ideas instead of “No accepted ideas yet”. Nothing on disk is changed by a failed read.

## v1.4.213 — 2026-09-21

- Audio replacements become active only after every selected section is ready. Refused or incomplete replacements keep the prior model selection; Resume preserves the completed provider task identity, and multipart replacements stay selected even before Audio Assembly creates its selector.
- Moving media to external storage now verifies exact file identity and durable destination writes before removing the source. Unsafe links, changed files and failed durability checks retain the source for a safe retry.
- Image ratios follow the selected model's live catalogue, including refreshed options and published defaults. Unsupported choices cannot slip through a delayed generation confirmation. Scene Plan shows its busy action label while building the timeline.
- B-Roll completion now checks the actual final video's visual and narration streams against the recorded narration source before promotion. Missing, short or stale output fails with a retry path; ambiguous raw narration requires Audio Assembly instead of guessing a track.
- Scene Plan keeps an explicit output allowance visible when the selected model publishes no ceiling. Saved-key retries preserve the original omitted allowance and batch size without submitting replacement paid work. Malformed catalogue output ceilings are rejected before submission.
- Subtitle fingerprint checks refuse dangling paths that could escape approved media roots. An unavailable B-Roll pool no longer prevents previews from another healthy pool.
- Content Pack index recovery keeps its quarantined evidence and records a durable local notice. Acknowledging the notice does not activate packs or delete retained files.
- Health and server diagnostics report the actual application version. Updated affected image, document, request-parser and build dependencies within their existing supported ranges.
- Transcription uses Audio Assembly's current, decodable output and rejects stale or superseded inputs before submission. A changed whole-track source is transcribed again; valid paid results remain reusable on retry.
- Missing explicit scene or thumbnail requests now fail clearly instead of reporting an empty success. A deliberately all-Still motion plan remains a valid no-op. Cached outlines retain their supported extra-chapter headroom.
- Upload scheduling preserves timezone-local days across clock changes and compensates earlier local writes when a later episode fails. If YouTube accepted a schedule but its local receipt could not be saved, the error says so and instructs a same-time retry.
- Upload metadata reads the newest usable saved version. Reinstalling an owned, damaged Content Pack retains its corrupt evidence and signed ownership record; exact-version details no longer show a different active version.
- An unreadable asset audit now reports what could not be checked, preserves healthy measurements, and offers Re-scan instead of claiming the episode is intact.
- Motion Review takes aspect ratios from the selected live model and clears incompatible choices on model changes. Clip generation preserves the exact published choice and refuses an omitted or unsupported ratio. Image prompt badges follow live catalogue limits, and absent image defaults are no longer invented.
- Ordinary Scene Plan continuation preserves approved prompts and retries only missing work when timing, rhythm and source evidence still match. Incompatible or unreadable saved plans stop with repair guidance; explicit rebuilds remain deliberate.
- Upload relayout previews expire when their start date changes. Publishing's Use app default choice now clears an earlier override correctly. Research safely loads older records with missing arrays, and Script Generator shows its published format context again.

## v1.4.212 — 2026-09-20

- Scene Plan now accepts GenStudio models that publish no output-token ceiling. It leaves `max_output_tokens` out of those requests, keeps the configured batch size available, and explains the choice instead of refusing the model or inventing a limit.

## v1.4.211 — 2026-09-20

- Subtitle freshness checks now refuse files outside the Library or a configured media folder before reading their size or timestamp. Missing files inside an approved location still return a truthful invalidation result, including on macOS where filesystem paths have a canonical `/private` prefix.

## v1.4.210 — 2026-09-20

- Cancelled-job history now releases its cancellation record once both the row and its worker are gone. Deleting, clearing, or retrying a cancelled job while its worker is stopping keeps the stop signal active, and the old worker cannot restore the removed history row. Generated files and provider-evidence safeguards are preserved.

## v1.4.209 — 2026-09-20

- Writing models that do not publish a maximum answer length now work. Four of the models GenStudio offers — the Free Models Router and three xAI Grok models — state no output limit, and Story Studio used to refuse them outright because it could not work out how long a reply they would accept. It now sends the request without a length limit and lets the provider decide, instead of inventing a number or turning the model away.

## v1.4.208 — 2026-09-20

- Uploading an episode whose number is already on this YouTube channel now warns you first and lets you continue. If a channel has moved between projects, or two series share one, a second "Episode 1" is sometimes exactly what you meant — so the app tells you which project already used that number on that channel and uploads anyway when you confirm. It never blocks the upload.

## v1.4.207 — 2026-09-20

- Scene Plan's "Custom instructions" no longer travel inside a preset. That box is written for one episode, so a preset applied to a different episode could carry one episode's notes onto another without a word. The rest of the plan preset — the prompt model, output budget, creative direction and your visual timing — is unchanged.
- The channel default style box now shows how long your style description is against the limit the image model you selected publishes, and it says so when a save had to trim the end. It used to cut the text at 2,000 characters and simply report "Saved", so a long style could come back shorter than you wrote it with nothing to explain why. A model that publishes no prompt limit now saves your text in full, instead of being cut to a number Story Studio made up.
- Audio recovery now uses the voice model the episode was actually generated with. It used to reconstruct that from the most recent audio job in the project when the episode's own record had been cleared, so after you switched voice models one episode could be checked against another episode's model and report missing audio parts that were never supposed to exist. Episodes generated from now on record their voice model alongside the audio, and older episodes fall back to the previous behaviour.

## v1.4.206 — 2026-09-20

- Removed the "View all caps" reference table from Images. It listed every model's prompt limit and credits-per-image as fixed numbers, so once a provider changed either one the table quietly reported the old figure as current — and the cap and price for the model you actually have selected are already shown beside the selector.

## v1.4.205 — 2026-09-20

- Saving a Script preset no longer stores the per-run "re-run even if it exists" switch. Restoring it would have silently overwritten existing work on the next apply. It also no longer stores that episode's written guidance — text meant to carry across a channel belongs in the channel-specific box instead. Your cast selection is still saved, since the cast is the same for every episode of a series and restoring it is the point of the preset.

## v1.4.204 — 2026-09-20

- Removed an unused caching module left over from an earlier design. It had no callers anywhere in the app — only its own test — so nothing changes for you; the code is simply smaller.

## v1.4.203 — 2026-09-20

- An opening clip the app cannot measure now stops the render and says so, instead of quietly reserving five seconds for it. The reserved number was never measured, and because the plan and the render disagree about it, every caption in the episode could sit too early or too late — the whole episode, from one unreadable file. Re-run Audio Assembly so the merge records its opening, then retry.

## v1.4.202 — 2026-09-20

- A missing GenStudio API key no longer looks like an empty model catalogue. The app asked GenStudio for the model list without a key and reported back "no models" — so the pickers showed a confident empty state instead of telling you the key was missing. That request now answers with the same clear "Add a GenStudio API key in Settings → This Mac" message the rest of the app already uses.

## v1.4.201 — 2026-09-20

- Versioned final videos are no longer invisible. Story Studio saves a second render as `_final_video_v2` and so on when the first name is already taken — a perfectly normal file — but three separate checks only recognised the unversioned name. Those videos counted as zero bytes in Settings, a versioned-only episode could look like it had no finished video at all, and storage cleanup could not reclaim the space. All three checks now recognise both names.

## v1.4.200 — 2026-09-20

- Deleted projects no longer claim to be zero bytes when the app cannot read them. The size shown for a project waiting to be forgotten was measured best-effort, and a folder it could not read came out as 0 bytes rather than "unknown" — so a project of any size could be listed as empty. It now reports the size as unknown in that case, and if any part of the folder cannot be read the whole figure is treated as unknown rather than quietly under-counted.

## v1.4.199 — 2026-09-20

- The Music Library no longer reports a total it cannot stand behind. It adds up the playable length of your enabled tracks, and a track whose length it could not measure simply added nothing — so the figure was quietly too low while being shown as the whole answer. When any enabled track has no measured length the header now reads "at least" and says how many tracks are unaccounted for, so the number is understood as a floor rather than a total.

## v1.4.198 — 2026-09-20

- Sound Design no longer blames your cues for a missing Scene Plan. It worked out the episode's length from the Scene Plan's scene timings, and when there were none it treated the episode as zero seconds long — so every cue failed the "start is outside the episode timeline" check and the message pointed at the cue. It now says plainly that the Scene Plan has no measured timings, and only checks cues against the length when there is a length to check against.

## v1.4.197 — 2026-09-20

- B-Roll clips that ffprobe can measure are no longer indexed as zero seconds long. ffprobe reports a field it cannot read as the text "N/A" rather than leaving it blank, and the app treated that text as a real value — so it never looked at the container's own duration, which usually does have the number. The clip's length came out as 0, which reads downstream as "no usable footage". Clip length, width and height are now taken only from values that are genuinely numbers.

## v1.4.196 — 2026-09-20

- Two more screens stopped showing one episode's results while another was open. On Images, the integrity card (how many pictures are missing) and the Browse grid were cleared only when you switched to *no* episode, so moving from one episode to the next left the previous episode's numbers and file list on screen — and there for good if the new read failed. On Research, a failed read left the previous episode's finished research on screen as though it belonged to the new episode, and saving would have written it into that episode. Both now clear the moment the episode changes.

## v1.4.195 — 2026-09-20

- Two more screens no longer carry one episode's work into another. B-Roll kept the manual clip pick — a list of clips with per-clip durations chosen for one episode — so opening a new episode showed the previous episode's footage still queued and ready to assemble. Scene Review kept an open image lightbox and the ticked batch of scenes; the lightbox rebuilt its image address from the *new* episode with the *old* scene id, so it either failed to load or showed a different episode's picture, and a batch action would have named scenes that did not belong to the episode on screen.

## v1.4.194 — 2026-09-20

- Motion Review and the YouTube Finalizer now clear the episode they were showing before they load the next one. Both replaced their contents only when a new load *succeeded*, so switching episodes left the previous episode's scenes and readiness on screen while the new one loaded — and left them there for good if that load failed, with an error message as the only hint. In Motion Review the scene thumbnails were stale as well, still pointing at the previous episode's cached images. Both now blank the old episode's state the moment the episode changes.

## v1.4.193 — 2026-09-20

- Subtitles are no longer kept on the strength of narration the app cannot find. Deciding whether an existing transcript was still current compared the audio to the transcript, but when a narration file was missing or unreadable that came out as "unchanged" rather than "unknown" — so an episode whose audio had been deleted kept its old captions and reported the transcript up to date. Not being able to read the audio is now treated as the audio having changed.

## v1.4.192 — 2026-09-20

- Story Studio is now strict about which episode folder belongs to which episode. Five separate searches matched a folder by asking only whether its name *started with* the episode code, so `EP0001` would have accepted a folder named for `EP00012` — silently, and whichever it hit first. Every project currently uses the same code width, so this could not actually go wrong yet, but that safety came from your data rather than from the code. The rule is now an exact match on the code, or the code followed by " - ", which every one of the 4,971 episode folders in your library already uses. The same strict rule now also guards the media-cleanup check that decides which files may be deleted.

## v1.4.191 — 2026-09-20

- Retrying subtitles can now actually perform the repair it asks for. When a subtitle run left the stitched timeline missing, the app told you to "retry the local subtitle stitch before Scene Plan" — and the retry took a shortcut that returned *before* the stitch, so pressing it changed nothing and the same message came back. A retry now stitches, confirms the timeline was written, and only then reports the job finished. It still reuses the transcript already on disk, so repairing the local file costs nothing.

## v1.4.190 — 2026-09-19

- Updating a video's thumbnail is no longer reported as done just because the upload call returned. The check asserted a fixed "1 of 1" without looking at anything, so an update the provider accepted but Story Studio failed to record could still read as finished. It now reads the stored record back and only counts the update as done when that record says it succeeded.

## v1.4.189 — 2026-09-19

- Retrying a transcription no longer keeps a transcript whose audio has changed. The existing transcript was kept whenever it had at least one cue, without checking whether the audio underneath it was still the audio it was made from — so re-running Audio and then Retry left the old captions in place and reported the job finished. It now checks the audio first, and says which chapters changed when it regenerates.

## v1.4.188 — 2026-09-19

- A B-Roll render that cuts off before the narration ends is no longer reported as finished. When the clip pool is too small to cover the episode, the video simply stops at the last clip while the narration keeps going — and the step used to report Done, with the finished-video indicator green. The app now checks the pick against the narration length before signing the render off, and says so instead. This is the first of the job types that had no independent check at all.

## v1.4.187 — 2026-09-19

- A generation step can no longer be marked finished on the strength of nothing. The app asked each generator "are you complete?", and unless it answered "no" the job was marked done — so a generator that checked nothing at all passed by default, and the Production Board could go green over missing output. For the job types that already have an independent checker, the app now re-reads the produced files itself before marking a job finished. Steps whose work was done by the AI service were already checked once, at settlement; this closes the gap for the ones it never reached.

## v1.4.186 — 2026-09-19

- "We don't know" no longer gets reported as "no". The service now publishes a blank where a provider never stated something, and one field — whether a model returns citations for what it searched — was being read as an explicit "does not cite" for every model. No behaviour changes today, because nothing enables a feature on an unstated value; the point is that the app can now tell the two apart instead of putting words in a provider's mouth.
- The Audio page no longer assumes a model always publishes a language list. Every voice model publishes one today, but the service has just started blanking fields it cannot vouch for, and a blank would have crashed the page rather than showing "no languages stated".

## v1.4.185 — 2026-09-19

- File previews can no longer read anything on your Mac. Four preview routes and the thumbnail reference analyser took a file path from the request and checked only the file type — so any file with a matching extension could be streamed back, and the analyser would send it to the AI provider. Previews now read from your Library and any media folder you have configured, and nothing else. If you had been previewing a file from somewhere unrelated, such as your Desktop, that will now be refused.

## v1.4.184 — 2026-09-19

- Title alternatives no longer carry from one episode to the next. Opening an episode that had none kept the previous episode's generated titles and saved them as its own, so the metadata for the wrong episode could be written. They are now cleared when you switch episodes.
- Six more shared styles that were defined inside a single component now work everywhere: small inputs, icon-only buttons, link-style buttons, checkbox labels, section labels and card action rows. Between them they are used in 69 files; like the ghost buttons fixed in v1.4.178, they were rendering as if the class were absent.

## v1.4.183 — 2026-09-19

- Corrected the archive-scan limit above. The first attempt refused any folder outside your Library, which also refused an external drive you had deliberately pointed it at — it would have broken a working feature to close a hole. It now refuses only a root that means "everything": the whole disk, your home folder, or a path too shallow to be a specific folder.

## v1.4.182 — 2026-09-19

- "Force re-run" is no longer still ticked on your next batch. It is a per-run choice, but it was never cleared — not when the dialog closed, not when the run finished, and not when you switched channels — so one forced run left every later Run Batch opening with Force already on and the button reading "Start batch (force)". Pressing Start then regenerated every selected stage and repeated the charges.
- Deleting one subtitle file no longer wipes the quality warnings from the others. The delete response carries less about each file than the status listing does, and the page was replacing its list with it — so every remaining transcript lost its "garbled text" tag and quality panel until a reload, which is a false all-clear on the one signal that flags a bad transcript. It reloads the full listing now.

## v1.4.181 — 2026-09-19

- The Library archive scan can no longer be pointed at your whole disk. It reads and hashes every file it is given, and the folder it was asked to scan came from the request unchecked — so asking it to scan `/`, or your home folder, walked and hashed everything on the Mac. Scanning a folder you chose still works, including one on an external drive; what is refused is a root that means "everything".

## v1.4.180 — 2026-09-19

- Imported audio can no longer be written outside the project. The chapter name that becomes the saved filename was taken from the request without checking it, so a name containing a path (`../../../../tmp/x`) wrote the file wherever it pointed. A chapter name is a name; it may not contain a path separator.

## v1.4.179 — 2026-09-19

- "Add Overlay" and "Pick media" open a dialog again. Both were written as dialogs but the classes they used — `modal-overlay` and `modal-content` — were never defined anywhere in the app, so instead of a dialog the contents appeared as a plain list inside the narrow controls column, with no backdrop, no positioning and no close button. They now use the same dialog styling as the rest of the app.

## v1.4.178 — 2026-09-19

- The buttons that stop running work are reachable again. Jobs shows each job in a card, and the card clipped its own "More actions" menu, so with more than one secondary control (Cancel, Stop local work, Pause new submissions, Clear history) the trailing ones were cut off with no scrollbar and could not be clicked at all.
- A sentence that explains why a render is blocked no longer prints `[object Object]`. It read each group of scenes as if it were a number, so instead of "3 missing image(s)" it printed the raw objects — and this is the only sentence telling you which scenes to fix. It now counts them and names the scene numbers.
- The quiet "ghost" button style now works everywhere. It was defined inside one dialog's private styles, so the other 52 buttons using it across the app rendered with no border and no hover feedback.
- The "More actions" menu is bounded and scrolls, so a job with many controls cannot run off the bottom of the window.

## v1.4.177 — 2026-09-19

- Closed five ways a single request could have destroyed your library, found by an audit of every one of the app's 53 route files. The worst was one HTTP request that deleted the entire Library — every project, and all 107 GB of media. It is fixed, and so are the four others of the same shape: one that deleted a whole project, one that deleted a whole season of episodes, one that deleted any `.json` file on the machine, and one that deleted any file from the music pool by naming a path instead of a track.
- "Reveal in Finder" could be turned into running a program. It forwarded whatever path it was given to the system handler that LAUNCHES a file, so pointing it at an application or a script ran it. It now reveals the file in Finder, which is what the button says it does.
- A file folder name could be made to point outside the project. Episode codes, episode titles and the per-project subfolder names were all pasted into a folder path with nothing checking where the result landed — and several of the things that used those paths then delete what they find there. All three are now checked where the path is built, so a name that would escape is refused instead of followed.
- Deleting an episode folder by name could be aimed at the folder that CONTAINS episodes. Naming a season deleted every episode inside it. It now only accepts a whole episode code.
- Also fixed: a Pipeline repair run silently dropped every remaining step for an episode while still reporting the batch as started, so a run that should have rendered a video did nothing and said nothing.
- 15 new tests cover these, each one asserting that a file outside the folder is still there afterwards rather than only that the bad input was refused — a test that checks the error message passes even when the damage happened first, which is how the original defects stayed invisible.

## v1.4.176 — 2026-09-19

- The old multi-Mac endpoint pool is gone. It let Story Studio name and switch off individual local Image Studio, Voice Studio and Chat Studio machines, and hand work to whichever was least busy. Nothing had used it for some time — every one of its functions had no caller left, and the only thing still touching it was a line at startup that filled a registry nothing read. Removing it changes no behaviour: Story Studio talks to exactly one service, and the models from your other machines arrive through it.
- Your settings file is untouched. The list of machines you had switched off is still there, along with the names you gave them; nothing reads or writes them any more. Story Studio does not rewrite your settings to tidy up its own dead code.
- Corrected a comment that pointed at the wrong port. It claimed the live service had moved to 8010 while nothing has listened there for some time — the service is on 8000. Only the note changed; the address Story Studio uses was already right.

## v1.4.175 — 2026-09-18

- Episode lists load roughly 40% faster. On the 302-episode project, opening an episode list was doing about 211,000 separate file checks and taking 10–11 seconds; it now does about 125,000 and takes 6 seconds. The work was not the work — the same handful of project-level files were being re-read once per episode, so a list of 302 rows read the project's own YouTube records 10,180 times, its publishing state 604 times and its main project file 4,428 times to answer a question whose answer is identical for every row. Each of those is now read once per request, and any change on disk is still picked up by the very next request.
- Two smaller repeated checks were folded into the same pass: asking whether a file exists and then asking its size (now one check), and re-reading the app's own settings for every episode. Neither changes what a list reports — only how often it asks.
- Nothing about the numbers a list shows has changed. Episode titles, folder paths, done/pending marks and the search for a renamed episode folder all resolve exactly as before; the difference is that the request no longer goes back to disk to re-learn what it already knows.

## v1.4.174 — 2026-09-18

- Library pages open much faster. Every listing was re-reading and re-checking all 115 installed content packs from disk on each request, measured at roughly 10–13 seconds per page even while the app sat idle. An unchanged pack is now checked once and reused, and any change to a pack's files still invalidates it immediately.

## v1.4.173 — 2026-09-18

- The music picker lists the published music model again. It was being discarded because the service does not state several of its capability fields, and an unstated field was being treated as a broken row. An unstated field now reads as "not reported" rather than being guessed at, and only a genuinely malformed value discards a row.

## v1.4.172 — 2026-09-18

- The model catalogues load live again. Every picker — language, image, video, voice, music, transcription — had been quietly falling back to a cached copy hours out of date, because the current endpoint answers with a wrapped list rather than the plain list Story Studio reads. Both forms are now accepted, so the pickers show what the service actually publishes; a payload that is neither form is still refused loudly.
- Models the previous endpoint offered but the current one does not have are gone from the pickers, as they should be.

## v1.4.171 — 2026-09-18

- Scene Plan no longer stands in an invented 8,192-token output allowance when the selected model publishes none. That number could reach the panel as though it were the model's own limit; the request is now refused with the reason instead.
- A timeline-only Scene Plan run, which has no model by design, keeps working and uses Story Studio's own local budget. "The model published nothing" and "this run has no model" are now told apart rather than sharing one value.

## v1.4.170 — 2026-09-18

- Transcription and video models now show the provider GenStudio publishes for them. The field was arriving and being discarded, so those rows could not say who serves them; an unpublished provider still shows as unknown rather than being guessed.
- The Audio page states plainly when a model publishes no per-request character ceiling, instead of failing to display the quote. An unpublished limit is now reported as missing rather than filled in with a figure the model never published.
- A GenStudio key refused for insufficient credits no longer stays refused indefinitely. The refusal now expires and is retried, so an endpoint that reports a constant balance cannot leave a key permanently unusable.

## v1.4.169 — 2026-09-15

- Publish can now re-date videos that already have a planned date. Select the episodes, choose a starting date, and their dates are laid out again on the active plan's cadence — the case the existing Plan button skips by design, because it only ever fills missing and missed dates.
- Every proposed date is shown beside the date it replaces before anything is saved, and the exact previewed dates are re-checked at save time. Days another episode already holds are stepped over rather than double-booked, and the dialog names them.
- Editing planned dates changes Story Studio only. YouTube is not touched, so a video that already exists on the channel is listed as left unchanged instead of being re-dated behind YouTube's back.

## v1.4.168 — 2026-09-15

- Select several subtitle chapters and generate or regenerate only those sections in one queued action. Select needs attention finds missing, outdated, or flagged sections; selections clear when changing episodes.
- Scoped subtitle jobs verify the requested chapters without marking unfinished chapters or the full timeline complete.
- Audio speed controls, quotes, and generation follow the selected model’s published speed range, including Qwen. Remembered and preset speeds are clamped to the live bounds.

## v1.4.167 — 2026-09-15

- Upload Center can move missed local publishing dates to future slots in the active channel plan. Missed dates have a filter and a direct action, with old and proposed dates shown before saving.
- Replanning keeps existing future bookings, protects uploads already in progress and known YouTube videos, and checks the reviewed slots again before saving. Moving a local date does not upload or reschedule a video on YouTube.

## v1.4.166 — 2026-09-15

- With automatic image replacement enabled, eligible fully refunded image failures keep retrying with a delay until complete, paused, cancelled, or disabled. Each retry verifies the previous task and preserves finished images; charged replacements retain their existing limits.
- Scene Review jobs held automatically after a stall rejoin the queue once their accepted work has safely settled. Explicit pauses remain paused, and paused cards no longer promise automatic continuation.

## v1.4.165

- Fixed Pipeline batches with a shared LLM lineup incorrectly applying writing-model policies to Scene Review and other non-writing stages. Image, audio, subtitle, motion, and assembly stages keep their own settings; eligible writing stages still use the lineup or their explicit overrides.

## v1.4.164 — 2026-09-14

- Catalogue diagnostics preserve GenStudio's Promotional and Value language categories alongside Economy and Premium. Published Promotional models keep their category even when their customer credit price is positive; other media keep their own category rules.

## v1.4.163 — 2026-09-14

- Pipeline has a reusable LLM lineup for new queued writing jobs. Choose models once, prefer selected free and discounted choices, then continue to selected paid models. Existing content presets and explicit per-stage model choices remain in control of their settings.
- Confirmed quota exhaustion moves to the next eligible model. If every eligible choice is temporarily unavailable, jobs keep completed work, release the local worker, and recheck automatically; Jobs shows the waiting status and recheck time.
- Live model aliases and published retirement successors are resolved for new lineup work. Accepted or uncertain requests keep their original recovery identity to avoid duplicate submissions.

## v1.4.162 — 2026-09-14

- Character Sheet no longer shows the retired Visual timing & motion card or draft timing summary. Manage episode timing and motion in Scene Plan.
- Applying a Character Sheet preset explains its saved rhythm beside the preset controls without presenting it as the saved Scene Plan timing.

## v1.4.161

- LLM pickers show Promotional first, followed by Value, Economy and Premium. Categories follow GenStudio's combined input/output price bands, with existing Relaxed models classified as Promotional.
- Search, selected-model focus and keyboard navigation follow the four LLM categories; other model pickers retain their current categories.

## v1.4.160 — 2026-09-13

- Episode lists reuse project information within each request, avoiding hundreds of repeated file reads when opening a large channel across workflow tabs.
- Historical completed jobs no longer trigger an unnecessary second episode-list load. New completions, including those arriving during a load, still refresh readiness.
- Episode selectors now follow project switches correctly, including loading and error states; late responses from the previous project stay isolated.
- Jobs checks advisory account capacity less often and suspends those checks while the window is hidden, while retaining live job updates and submission safeguards.
- Old submission-block and local-waiting indicators expire when account-status refreshes stop succeeding.
- Series Formula browsing and format loading reuse project metadata already read for the request.

## v1.4.159

- YouTube uploads now retry temporary connection failures while opening an upload session, instead of immediately failing the job. Startup retries are bounded and shown in the job log; accepted videos and existing resumable sessions retain their recovery safeguards.
- Upload startup errors now identify connection or certificate problems without exposing credentials, and explain when no video bytes were sent.

## v1.4.158 — 2026-09-13

- Scene Review validates PNG, JPEG and WebP images with a cheaper full decode, avoiding unused pixel statistics on cold loads. Corrupt-download detection, image freshness, and verification before completion remain in place; original images are unchanged.
- Scene Plan opens an episode link immediately without waiting for the full episode list. Loading and failed readiness checks now have clear status and Retry controls instead of temporary missing-audio or subtitle warnings.
- Scene Plan discards late responses after project or episode switches so the previous selection cannot replace the current plan.

## v1.4.157 — 2026-09-13

- All Jobs now shows the same amber sidebar badge as Project Jobs, counting running and queued jobs across every project. The count updates through the shared live job feed and disappears when no jobs are active.

## v1.4.156 — 2026-09-13

- Audio, merge, recovery and status reads now look for narration in the selected episode first, avoiding a full-project folder walk for ordinary requests. Renamed folders and legacy Word narration remain supported.
- Subtitle audio freshness checks stream source bytes in bounded chunks instead of loading whole chapter parts into memory. They retain the exact same byte-based identity and replacement detection.
- Audio Generator no longer requests the chapter list again merely because its audio totals loaded. Repairs still refresh the list, and duplicate repair clicks are suppressed.
- Slow audio and episode-status responses can no longer overwrite another project or episode after navigation. New selections clear the old status immediately while the current check completes.

## v1.4.155 — 2026-09-13

- Scene Plan presets now capture the selected episode’s visual timing and portable motion scope from the timing panel. Explicit Apply fills that episode’s draft; Save timing & motion keeps it for the next build. Existing plans and generated media are unchanged.
- Older presets without timing leave the episode’s current rhythm intact and explain what was not saved. Specific scene IDs stay with their episode. Loading or invalid timing blocks an incomplete preset save or apply.
- Returning to Scene Plan restores remembered prompt settings without overwriting episode timing or motion. Legacy motion flags no longer contradict the saved episode state, and switching projects remounts the preset controller for the correct project.

## v1.4.154 — 2026-09-13

- All Jobs includes durable jobs from every existing project, even while the Library list is incomplete. Loading and read failures no longer appear as an empty queue, and updates arriving during the first snapshot are retained.
- Jobs adds individual selection, Select needs attention, Select all matching, and Abandon and clear selected. One confirmation names the scope; progress and per-job failures remain visible. Files and billing records stay intact, and accepted provider work can still finish.
- Automatic image replacement can retry one confirmed fully refunded generic image failure when the saved policy and current switch allow it. Submission uncertainty, refusals, cancelled work, charged generic failures and repeat replacements remain excluded; switching automatic replacement off prevents the next submission.
- Settings → Free up space lists episodes with verified ready YouTube uploads, previews selected media and exact files, then archives verified copies or explicitly removes local files. Progress, Stop and file outcomes survive page navigation. Active work, shared storage, changed files and unverified exports are excluded. Upload Center links directly to this workflow.
- Episode lists, Pipeline and Production Board distinguish local media cleanup from real asset readiness. Cleanup retains upload records, scripts, prompts, subtitles and billing evidence; ordinary Pipeline runs do not regenerate deliberately cleaned media. Force re-run remains explicit and still checks normal prerequisites and costs.

## v1.4.153 — 2026-09-12

- Jobs: historical subtitle gap links now read timeline metadata without repeatedly hashing chapter audio. Account polling shares pending requests and respects the existing refresh window; the credit header requests only the account overview it displays.
- Shared settings reuse parsed data while the file is unchanged, detect external updates, and keep callers’ editable values independent. Channel identity appears as soon as it loads; loading or unavailable identity no longer shows a false missing Series Formula warning.
- Content Store: purchases acknowledge their completed receipt before refreshing the catalog. Installs show downloaded bytes and verification/install phases in the shared background queue. Product details reflect queued, installed and failed states immediately, and repeated clicks reuse an active install.
- Pipeline: confirmation opens immediately while selected episodes are checked. Cancel and project changes discard stale checks. Batch preflight reuses project facts within the request while preserving readiness and spending checks.
- Archive uploaded videos: folder browsing shows busy/error feedback, and upload-proof scans run in the background with progress and Stop. Unreadable sources fail clearly. Moves remain limited to the reviewed folder and uploaded files, with verified copies before removing originals; same-disk moves are described as organization rather than reclaimed space.

## v1.4.152 — 2026-09-12

- Scene Review: thumbnails, clips and audio now carry their own version, so a background refresh only reloads media that actually changed. The render poll waits for the previous read before asking again. A 288-scene episode’s review read runs its file checks in parallel instead of one after another.
- Upload Center: the review dialog opens immediately and can be closed while the exact payload is still being built. The rendered video’s identity is remembered while the file is unchanged, so Review then Upload no longer reads the whole file twice, and hashing reads in larger chunks (a busy Mac took 25 s per review; measured under equal load: 61 s → 2.5 s first time, 0.5 s after). Upload acknowledges the queued job at once and reloads the list in the background; a second Upload is withheld until the list confirms the job.
- Upload Center: Close and the primary action stay pinned in both review dialogs. Bulk review can be closed while it queues; queueing continues, a strip on the page shows progress with Stop and Show, and queued uploads remain in Jobs. The publishable list resolves the export folder once per request instead of once per episode.
- Content Store: installs run in one app-wide queue that survives leaving the page, with a strip on every page and each card naming its state (Queued to install, Installing…, Installed, Install failed). Each queued install skips the server’s overview rebuild and the queue re-reads the overview once at the end. Discover has Select all purchasable. A batch purchase can be hidden while it buys and reports its result on the page. The overview asks GenStudio for account, catalog and receipts together, stats installed pack files per directory instead of one at a time, and uses the native CRC-32.

## v1.4.151 — 2026-09-12

- Audio Assembly keeps merge, preview, and output choices in a persistent action bar. Replace the active merge by default; creating another version remains an explicit choice.
- Detect replaced chapter audio in Subtitles, mark only affected transcripts outdated, and update those chapters while retaining unchanged subtitles. Show the last stitch date and local time, including seconds, separately from freshness warnings.
- Ordinary Audio Retry reconnects to the saved request when provider submission is uncertain instead of starting another paid request.
- Replace confirmed failed audio sections or writing requests directly from Jobs. Preserve successful output and reconnect to accepted replacement requests after interruption.
- Add separate, off-by-default automatic Audio and Writing replacement settings with additional-credit limits and one automatic replacement per failed item. Automatic replacement requires GenStudio's advertised spending-limit support and confirmed settled failure; uncertain submissions remain recoverable without duplicate generation.

## v1.4.150

- Jobs: Retry all shows live progress and separates queued retries, already-complete episodes, and blocked checks, with episode-specific reasons.
- Episode recovery checks run independently without holding the whole project behind a slow episode. Queued and running recovery jobs reuse their saved identity without repeating the full prerequisite scan.
- Existing outputs, provider receipts, and safeguards against duplicate generation remain intact.

## v1.4.149 — 2026-09-11

- Explain subtitle gaps with separate chapter-audio positions, full-episode positions, and the number of seconds without subtitles. Clarify the audio player’s clock and that a subtitle gap alone does not prove the audio is wrong.

## v1.4.148 — 2026-09-11

- Start Video Assembly on the first Generate click when the caption check requires no review. Show “Checking captions…” and disable repeat clicks while checking; real caption previews still require confirmation.

## v1.4.147 — 2026-09-11

- Choose Scene Plan or Image Pool per episode from Pipeline and Scene Plan. Mixed batches skip inapplicable visual steps, and the Board and completion filters follow each episode’s source.
- Set Visual timing & motion in Scene Plan: keep uniform scene timing or use successive pacing periods, with motion off, opening only, selected scenes, or all scenes. Existing plans and approved clips stay unchanged until deliberately edited or rebuilt.
- Keep queued visual requests attached to their accepted source and scene selection. Missing-only prompt work uses the saved plan, and out-of-scope scenes do not trigger new motion generations.
- Treat provider-confirmed no-record requests as terminal, uncharged missing work even when an older queue hint said they were running.
- Preserve saved Image Pool picks from old B-Roll selection actions. Prevent old recycling exclusions from dropping Scene Plan scenes, and retain the narration-tail duration correction during encoding.
- Keep writing pages, visual reviews, publishing profiles, thumbnail templates, settings and shared episode indicators attached to the current project. Show failed loads and saves, and prevent overlapping saves from losing choices.
- Clarify missing audio/subtitle prerequisites, hide unpublished model batch limits, and retain an episode’s motion intensity when an older preset has no saved intensity.

## v1.4.146 — 2026-09-11

- Pipeline now stays open after Run Batch or Repair. A result dialog shows the accepted job count, existing work and skipped or blocked episodes, with Stay on Pipeline and View Jobs choices instead of an automatic redirect.

## v1.4.145 — 2026-09-10

- Failed and cancelled jobs now offer a small, named link to their work tab, opening the job’s own project and episode directly from Project Jobs or All Jobs. Repair and Retry continue to work in place.

## v1.4.144

- Choose Image Pool slideshow as an episode's visual source in Video Assembly. Reuse the saved still-image selection in order at its chosen interval through the full narration; Scene Plan keeps its existing timing mode.
- Keep Assets Library files, scans, tags, edits and unregister confirmations attached to the selected pool when requests overlap. Loading failures show a retry action.
- Offer video normalization only for video pools; image and sound pools retain their original media.
- Keep Subtitles usable while transcription model language capabilities are unavailable, with disabled actions and an explanation instead of a rendering error.

## v1.4.143

- Subtitle gap warnings now offer chapter audio playback and a direct Audio Generator link with that episode and chapter selected. Playback seeks near the gap and follows the active audio parts without generating or replacing anything.
- Chapter rows separate Listen, Audio Generator and Generate/Regenerate subtitles actions, and retain the server's audio-quality findings.
- Audio previews preserve active version selection and numeric multipart order. Playback errors offer Retry, and switching episodes stops the old player.

## v1.4.142

- Hide completed or recovered Jobs without deleting their files, receipts, or unfinished settlement tracking. Restore hidden cards, undo a hide, and surface new failures automatically.
- Keep subtitle previews, stitching, Audio Assembly scans and music choices, and Video Assembly scenes, title images and caption checks attached to the selected episode when requests finish out of order.
- Reuse accepted submissions when retrying an uncertain Ideas campaign, outline, chapter expansion or YouTube Finalizer request. A new intentional action still starts a new generation.
- Keep writing previews, thumbnail generation, Character Sheet, Image Pool and Scene Review uploads scoped to their original episode. Direct old scene-prompt links to Scene Plan.
- Prevent overlapping preset and visual-style saves from losing edits, and keep Remote Control data attached to the selected project.
- Keep Contextual Cues and Sound Design edits attached to their original project and episode during navigation and saving. Show Music Library loading failures with a retry action.

## v1.4.141

- Retry failed Jobs through the queue using their saved settings and generation intent. Keep the original history when retry is refused; metadata and thumbnail retries no longer depend on incomplete generator forms.
- Order overlapping queue Pause and Resume actions, and keep a paused job out of execution if saving its Resume fails.
- Keep Jobs updates attached to the current subscription when switching projects or reconnecting. Show a refresh notice when repeated requests fail, and preserve other jobs’ completion notifications.
- Match All Jobs counts to the selected project, count paused work in type tabs, expose missing job types, and keep history on a valid page after clearing rows.

## v1.4.140

- Keep subtitle transcription attached to the audio files selected by Audio Assembly, including alternate versions and multipart chapters. Honor replacement audio selections during assembly; repair old mixed base-and-part mappings when saved generation fingerprints prove the replacement.
- Resume a fresh transcription attempt without accepting older subtitle files as its result. Keep its original request identity, report unresolved chapters accurately, and advance recovery after the replacement artifacts are verified.
- Label the audio selection action Generate, Regenerate, or Generate / regenerate according to the selected chapters’ existing audio. Mixed selections keep the full bulk action.

## v1.4.139

- Recover an episode’s saved audio and images directly from Jobs, with exact episode scope and progress on its job card. Recovery stays separate from paid Retry and never opens Production Board.
- Keep Recover all, Repair all, Retry all, queue controls, Clear finished and Clear failed in a permanent Jobs toolbar. Ineligible actions remain visible and disabled; bulk scope follows the selected project.
- Separate finished and recovered history from failed history while preserving files, billing records and unfinished provider-work protections. Keep bulk retries moving when one episode cannot continue.

## v1.4.138

- Keep Jobs cards compact when many prompts or images need attention. Show the verified count and a concise cause; expand affected items or the full error only when needed.
- Explain uncertain Scene Plan requests accurately instead of claiming automatic repair was exhausted. Preserve completed prompts and the exact request and scene scope for recovery before replacement work.

## v1.4.137

- Resume all paused work consistently with individual Resume, including jobs paused during an app restart. Cancellation and duplicate-click protections remain in place.
- Reconcile completed subtitle requests without retaining duplicate pending receipts, so recovered history can be cleared once GenStudio confirms the work has finished.
- Run eligible Pipeline episodes even when other selected episodes lack prerequisites. Keep blocked episodes selected with their reasons and a link to the queued work.
- Choose 10, 25, 50 or 100 episodes per Pipeline page. The default remains 10, and selection is preserved across pages.

## v1.4.136

- Disable Introduction generation until the selected episode has a usable script, with a clear explanation and a link to Script Generator. Readiness updates when chapters finish, and remains disabled while checking or when the check fails.
- Check the same chapter prerequisite before queuing a new Introduction, so missing scripts do not create predictably failed jobs. Existing accepted requests retain their replay behavior.

## v1.4.135

- Keep Jobs recovery summaries compact. Per-chapter subtitle recovery messages now appear inside Technical details instead of filling completed and active job cards. Readiness and recovery actions remain visible.

## v1.4.134

- Resume chapter expansion requests confirmed as never created when you choose Retry, using the verified original request identity instead of repeatedly looking for a missing result.
- Preserve completed chapters and continue remaining chapter batches after recovery. Accepted or uncertain requests retain their existing recovery protections.

## v1.4.133

- Finish missing images directly from Jobs. The same failed or cancelled run returns to the queue, keeps completed images and its provider/credit history, and shows its updated status immediately.
- Include missing Scene Review images in Retry all, with duplicate-click and same-episode protections. Scene Review remains available for inspection without being a required detour.
- Resume image requests that were prepared locally but never accepted by GenStudio using their original verified request key. Accepted or uncertain work remains recoverable, while deliberate fresh regeneration keeps its separate identity.

## v1.4.132

- Replenish scene-image admission requests independently of occupied standard execution lanes, with account pacing, bounded queues and cancellation preserved.
- Show GenStudio’s published provider queue position and estimated wait in Jobs, and clear them as work advances.
- Choose language products for each Pipeline run without changing presets. Use one product, distribute episodes across selected products, or set an ordered primary and backups for the seven writing stages.
- Save the chosen backup and request identity for each logical writing request. Retry reconnects to accepted work; another product is used only after a proven safe refusal or fully released failure.
- Check the selected product’s published workflow capabilities before submission and keep model controls usable on narrow screens.

## v1.4.131

- Restore Upload Center’s Upload plans editor: create, edit and activate channel-specific weekly or monthly schedules, with timezone and date bounds.
- Link Settings and upload review directly to the plan editor. Saving a plan stays separate from assigning episode dates and scheduling on YouTube.
- Validate plan inputs before saving and preserve existing plan defaults and channel identity.
- Keep a manual provider-status recheck effective when a startup check is still finishing.

## v1.4.130 — 2026-09-08

- **Recovered subtitles stop looking unfinished.** Jobs distinguishes the original failed attempt from verified later recovery, keeps its credit history, and removes obsolete missing-section retry prompts.
- **Subtitle history checks the accepted request.** Read-only reconciliation uses the transcription confirmation key and rechecks old absence records affected by the earlier key mismatch. It does not submit another paid request.

- **Review several uploads together.** Ready-to-upload now requires a connected channel. Select eligible episodes, review their files, thumbnails and publication times, then queue the reviewed uploads with separate results for each episode.
- **The reviewed video is the one uploaded.** Upload confirmation and recovery compare the file’s actual bytes. A changed render asks for another review instead of silently uploading it.
- **Cleanup verifies before deleting.** Clearing local finals requires a matching file receipt and a fresh YouTube check confirming processing completed on the current channel. Unverified and older receipts keep their local files.
- **Re-upload after a deliberate YouTube deletion.** Explicitly remove the old upload association after deleting the video on YouTube. Story preserves its history and lets you review a new upload; it never deletes the remote video itself.
- **Uploads use the date you review.** Upload Center defaults to an episode’s future planned date, offers a custom date or private upload, and carries that exact choice into the queued request.
- **Schedule private videos without uploading them again.** Choose a future publication time inside Upload Center. Story Studio checks the current channel and YouTube visibility before applying it.
- **Give unscheduled videos a local plan.** Preview available dates from the channel’s upload plan and save missing assignments without changing existing dates or publishing videos.
- **Upload progress stays visible.** Follow transferred bytes, percentage, speed and estimated time remaining beside each active upload, with a direct link to Jobs. The page also shows its assigned YouTube channel and fixes scrolling into empty space below the list.

## v1.4.129 — 2026-09-08

- **Large requests to non-Store features are no longer refused with a Content Store error.** The Content Store's 16 KiB request limit was applied to every feature registered after it — B-roll and Image Pool, research, scene plan, scene review, continuity, music pool, library and changelog — so a legitimate large request could fail with a message about a limit that did not apply to it. The limit now applies to Content Store requests only.

## v1.4.128 — 2026-09-08

- **Motion duration follows the selected model.** Choose resolution separately and adjust duration with a snapping slider or number field using the model’s published image-to-video options.
- **Follow narration is an explicit choice.** Each missing scene rounds up to a supported clip duration. Review the requested duration, listed cost and any trim or final-frame hold before generating. Saved manual settings and accepted requests keep their behavior.
- **Generated clips are checked before completion.** Story Studio validates playable video and the requested duration, preserving invalid output for review without silently buying another generation. New Follow narration clips hold their last frame when shorter than the narration; existing clips keep their previous playback behavior.

## v1.4.127 — 2026-09-08

- **Choose the upload thumbnail inside the review dialog.** Preview the available episode thumbnails, see the selected filename, and choose another image without leaving Upload Center. Missing or unreadable thumbnails are shown explicitly.
- **The upload carries your thumbnail choice.** Manual upload passes the selected episode thumbnail through to the queued job instead of silently falling back to automatic selection.

## v1.4.126 — 2026-09-08

- **Upload Center now separates local video, upload progress, and YouTube publication.** Find episodes by status, search titles or codes, and sort by episode, status, or schedule. Locally planned dates are distinguished from confirmed YouTube schedules, with timezones shown.
- **Preview actions open where you can see them.** Play the local video in a player, or review the exact upload details in a focused dialog. Missing videos link directly to the episode in Video Assembly.
- **Local inventory remains useful when YouTube records cannot be read.** Unknown status is shown explicitly, while upload safeguards remain in place. Refresh the local list without querying YouTube, and keep responses and confirmations scoped to the selected project.

## v1.4.125 — 2026-09-08

- **Narration quality checks are now an explicit project choice.** Keep them Off, flag current evidence for review, or opt into Check and repair. Uncertain, legacy, stale, or script-changed evidence stays reviewable; it never starts a replacement or blocks ordinary chapter generation.
- **A confirmed repair keeps the current narration safe while it verifies a candidate.** Story Studio retains the original audio, uses the selected candidate only after raw alternate-ASR verification, and refreshes Audio Assembly and subtitles through the existing workflow. Candidate bytes, source map, script, quote ceiling, and action identity remain fenced across restart; a later ordinary Regenerate intentionally takes back its selected chapter.
- **You can independently double-check active narration with an alternate ASR model.** The action quotes the exact staged active audio, preserves its quote and credit ceiling through replay or restart, and leaves active audio and subtitles unchanged whether it finds no issue, needs review, is cancelled, or needs a higher approval ceiling.
- **Settings can display the last verified GenStudio catalogue during a short outage.** The cached display is account- and base-URL-scoped, marked stale with Retry, and is never used to authorize a paid request.

## v1.4.124 — 2026-09-07

- **Explicit Regenerate actions now create fresh work once and recover reliably.** A deliberate click carries one durable action identity through a lost response, Jobs Retry, and restart; a later click receives a new identity. Normal Generate and missing-output recovery keep their existing behavior.
- **Regeneration keeps its exact scope.** Audio, subtitles, scripts, openings, prompts, research, images, music, and Pipeline force runs preserve the selected model and item scope; a replay with changed details is refused instead of silently changing the active request.
- **Pipeline Force reaches each selected stage.** Forced batch work no longer drops its regenerate intent between chained stages, while Repair Missing remains its separate bounded recovery action.

## v1.4.123

- Audio Generator now uses direct chapter actions and a persistent selection bar: generate missing audio, regenerate selected chapters, or create a separate version without conflicting mode switches.
- Model, voice, chapter scope and quotes stay visible; detailed delivery controls are expandable. Episode changes discard outdated selections and quotes.
- Regenerated chapter audio now marks its older subtitles as needing an update. New transcripts record source audio fingerprints, and downstream timing checks reject known stale captions.
- Alternate audio versions stay separate from the active chapter during transcription and Audio Assembly.

## v1.4.122 — 2026-09-07

- **Pipeline Repair can restore selected subtitle gaps without redoing completed chapters.** The optional action keeps good outputs, reconnects to saved transcription tasks first, and allows one scoped fresh request per affected chapter at the live price when a recovered source remains unusable or known terminal/expired evidence cannot recover. Its action identity remains stable across restart; active or unconfirmed ownership stays protected from replacement.
- **Internal subtitle gaps now target their affected chapters and rebuild the stitched timeline.** Repair checks actual chapter sources, maps internal gaps to their affected chapters, and verifies the refreshed timeline before selected downstream work continues.
- **The same repair action can finish missing Scene Review images without replacing valid or imported images.** It recovers saved work first, keeps review approval explicit, and permits at most one fresh image request per missing item and action.

## v1.4.121 — 2026-09-07

- **With automatic image replacement enabled, a fully released image can recover after GenStudio exhausts its site failover.** Story Studio verifies the authoritative failed task and zero settlement, then makes one bounded fresh attempt in the same run for Continuity, Image Pool, or thumbnails. Active, uncertain, cancelled, incomplete, and charged outcomes remain protected from automatic resubmission.

## v1.4.120 — 2026-09-07

- **Image permit requests refill in parallel as GenStudio capacity becomes available.** A request waiting to retry no longer holds up other eligible requests; cancellation and existing billing checks stay intact.
- **Settings, account recovery, and the Content Store now make the next action clear.** Searchable, scoped settings keep unrelated changes separate; recovery and setup routes return you to the account, store, or configuration that needs attention. Project utilities and empty workspaces are also easier to find from the dashboard.
- **Workflow navigation keeps the episode you selected.** Previous and Next preserve the selected episode, including completed imported work; changing or clearing the picker updates the route without carrying an episode into another project. A saved handwritten Introduction remains visible and editable even when this channel is set not to generate new openings.

## v1.4.119 — 2026-09-07

- **Formula and Topic Pack choices now open in one searchable library.** Channel Identity and Ideas keep the current selection compact, then let you review and explicitly apply exact Formula and Topic Pack IDs in the shared picker.
- **Same-name built-in and installed choices now explain their source.** The library labels entries as Installed, Included, Built in, or Custom and shows the listed Library version for signed packs; an existing legacy choice remains visible until you choose and apply a different one.

## v1.4.118 — 2026-09-06

- **Formula-only Idea Campaigns now choose fresh subjects instead of cycling through the Formula's examples.** When no Topic Pack is active or explicitly selected, campaigns use the existing freeform Ideas generator with Formula guidance and saved Formula-wide history; Topic Pack campaigns retain their structured assignment flow.
- **Campaign retries keep the same freshness checks and requested output.** Resume fills only the remaining count, and when duplicate checks are enabled it carries the newest saved ideas into the bounded prompt and checks every saved Formula idea locally for repetition; it also preserves the selected model, emoji option, and durable campaign identity.
- **Finished image jobs no longer return to “Checking provider status” because of a duplicate pre-submit receipt.** Story Studio removes that receipt only when the current recovery checkpoint proves its exact image task and idempotency key; unmatched or contradictory provider evidence remains protected.
- **Missing-image status now explains both the failed item and its queued owner.** Jobs shows failed items separately from the number left in the current run, while Scene Review identifies the exact scenes queued for repair, distinguishes other blocked scenes, and links back to Jobs without starting another request.

## v1.4.117 — 2026-09-06

- **A Scene image batch no longer stays Paused after every image is verified.** A late automatic stall hold yields to the completed output audit, while manual and queue pauses still remain paused.
- **Existing affected rows repair themselves without generating again.** On project load, Story Studio finalizes a stall-paused batch only when its saved task ownership, current Scene Plan, and exact image files all pass a fresh audit.

## v1.4.116 — 2026-09-06

- **Character Sheet now offers four slower scene rhythms through 45–60 seconds.** Each choice applies to the selected episode through the existing pacing control, while new episodes keep the 1–3 second default.
- **Subtitle coverage stays strict when visuals move slowly.** Scene Plan, episode readiness, and Video preflight use the same fixed 30-second cue-gap guard, so a long missing stretch of narration cannot be hidden by a longer image hold.
- **Image Pool is reachable from every project sidebar.** The new link opens the existing Image Pool workflow beside Assets Library.

## v1.4.115 — 2026-09-06

- **Scene Review can now finish only the images still missing.** One explicit action checks saved GenStudio results first, preserves every complete image, and uses the current validated model settings for genuinely fresh work when no result exists or the earlier job is known to have failed.
- **Uncertain earlier requests stay fail-closed.** Story Studio identifies accepted work that is still generating and makes no duplicate request; when the outcome cannot be confirmed, a separate **Replace anyway** confirmation explains that another image and charge are possible, retains the old request evidence, and prevents a late old result from replacing the chosen output.
- **Failed Scene image batches return to the same safe workflow.** Jobs links the episode back to Scene Review instead of retrying with a historical selector, and repeated Finish or Replace requests reuse their durable action identity.

## v1.4.114 — 2026-09-06

- **Generated introductions now begin with the words the narrator should speak.** Story Studio asks the model for narration without a heading, preface, or divider and removes a recognized introduction preface only when it is immediately followed by the model's divider; similar spoken prose without that divider stays unchanged.
- **The Introduction preview can now be edited in place.** Edit, Save, and Cancel preserve the episode's chapters, keep manual narration exactly as written, retain unsaved text after a failed save, and block saving while Introduction generation is already active.

## v1.4.113 — 2026-09-06

- **Image Pool generation now keeps the selected output resolution.** The published resolution chosen beside the aspect ratio reaches the queued generation job, while omitted or non-string resolution values remain absent.

## v1.4.112 — 2026-09-06

- **Interrupted Video Assembly jobs now resume from validated scene clips.** Story Studio reuses only clips owned by the same durable job whose complete render inputs still match, rebuilds missing or damaged clips and every later composition stage, and never promotes an interrupted partial final.
- **Restart cleanup now preserves only trustworthy active assembly work.** Exact project, episode, job, status, and canonical temporary-folder ownership must validate before a checkpoint can rejoin its original job or protect files from expiry; pause and cancellation intent still take precedence.

## v1.4.111 — 2026-09-06

- **Subtitle readiness now distinguishes complete chapter files from a usable planning timeline.** Subtitles and Scene Plan identify pacing-blocking cue gaps with their exact chapter and times, keep the chapter count as a separate fact, and explain that re-stitching alone cannot create missing cues.
- **Jobs now names the exact missing or invalid scene images and prompts.** Each issue links back to its owning Scene Review or Scene Plan workspace, while a blocked automatic image replacement states why no replacement was submitted without exposing provider details.
- **Recovery links now reopen the exact work that needs attention.** Subtitle links focus the affected chapter, Scene Review links focus the stable scene row, and a selected deep-linked episode remains available while the picker shows Pending only.

## v1.4.110 — 2026-09-06

- **The YouTube Upload Center now opens for projects created before newer media folders were added.** Existing folder names remain unchanged, missing optional folder names use their established defaults, and unknown or unsafe folder paths remain blocked.

## v1.4.109 — 2026-09-06

- **The YouTube Upload Center now loads after YouTube setup.** Overview, Publish, Library, Reconcile, Comments, and Analytics open for the channel assigned to the project.
- **Project navigation remains visible throughout the Upload Center.** You can move between publishing and the rest of the channel workspace without leaving the project view.

## v1.4.108 — 2026-09-06

- **Failed visual Scene Plan jobs can now repair only their missing or duplicated prompts from Jobs.** The explicit **Auto repair prompts · credits** action preserves every verified prompt and timeline boundary, derives the exact episode and model from the saved job, and sends each remaining scene as its own GenStudio request.
- **Paid prompt repair keeps going while the saved plan improves and stops at safe boundaries.** It can continue beyond two repair passes, but stops before another request when a provider submission is unresolved, authorization or local saving fails, or a full pass adds no verified prompt. **Pause** lets the accepted request settle and then starts no new one; ordinary **Retry** remains available for timeline, setup, and other failures.

## v1.4.107 — 2026-09-05

- **YouTube publishing now has one Upload Center with separate Overview, Publish, Library, Reconcile, Comments, and Analytics pages.** Preview names the exact assigned channel and payload before confirmation. Settings manages YouTube application credentials, channel connections, reconnects, and project assignment in one place, with secrets kept in encrypted storage.
- **Interrupted uploads now resume without creating a duplicate video.** Story Studio ties the accepted channel, metadata, upload mode, source identity, resumable session, and provider result to one durable operation; a later project edit cannot change or relabel work that was already approved.
- **Library actions preserve live YouTube fields and concurrent edits.** Metadata corrections fresh-read the exact video and use its ETag, while operation-bound thumbnail and playlist actions keep uncertain provider success visible instead of retrying blindly. Reconcile, processing status, comments, and analytics stay scoped to the assigned channel.
- **Upload cleanup and quota reporting now follow the evidence they actually have.** Ordinary archive or storage cleanup requires a usable remote copy of the exact local render, and every YouTube Data API page or retry is counted against the application and channel credential that made it.

## v1.4.106 — 2026-09-05

- **You can now generate or regenerate exactly one chapter's subtitles from the Subtitles page.** Every chapter has its own action, missing chapters stand out, and the page says that the selected chapter starts a new GenStudio request under the current quote. The other chapter files stay untouched.
- **An expired transcription quote can recover without turning into a generic interruption.** Story Studio recognises GenStudio's exact expiry reply at confirmation, checks the saved request before renewing it, and keeps every other 422 reply fail-closed. When a saved task cannot be found with the current connection or account, its evidence is retained and the app offers a clearly separate fresh chapter request instead of silently resubmitting it.

## v1.4.105 — 2026-09-05

- **Once verified, Content Store trust now survives ordinary API-key changes in its own OS-protected file.** Provider saves refuse malformed or unreadable secret state, preserve an undecryptable file before a deliberate replacement, and serialize updates across processes. A missing trust anchor performs one authenticated Restore-purchases verification before any generation job exists; signature, account, origin, key-history, and tamper failures remain blocked without generating or spending credits.
- **A GenStudio operator pause now stops Story submissions using the stable `GENERATION_PAUSED` response code.** Story Studio preserves accepted jobs and completed checkpoints, directs the operator to enable generation in GenStudio Admin, and no longer depends on obsolete exact-release charging text.

## v1.4.104 — 2026-09-05

- **Backend tests now refuse to write API keys or Content Store signing-key anchors outside their claimed temporary data directory.** Both secret-store mutation paths use Story Studio's shared test isolation guard, preventing an incorrectly invoked test from changing this Mac's saved credentials or trust anchors.

## v1.4.103 — 2026-09-05

- **Targeted Scene Plan and Scene Review runs now stop before creating a job when their saved prerequisites are incomplete.** Pipeline names the missing Subtitles or Scene Plan artifact immediately, while valid targeted regeneration and every other single-step workflow keep their existing behavior.

## v1.4.102 — 2026-09-05

- **Retry All now recovers each episode in prerequisite order.** Audio Assembly, exact missing subtitle sections, a verified fresh stitch, Scene Plan, required Contextual Cues, and Scene Review share one saved recovery plan. Failed downstream rows wait their turn; restart and repeated clicks retain each queued job's identity. Jobs shows free recovery/settlement progress and a bounded **Buy missing subtitles now** action when eligible.
- **Subtitle recovery now fails honestly when stitching cannot complete.** Complete chapter files alone no longer let a subtitle job report success: Story Studio requires a fresh, verified stitched timeline before Scene Plan or Scene Review can proceed, while keeping successful section files for a targeted retry.
- **Optional paid subtitle replacement has its own separate machine setting.** It starts Off and needs its own per-Story-job credit ceiling; enabling image replacement never authorizes subtitle spending. Jobs retry now keeps a subtitle job's exact missing-section allow-list.
- **Subtitle recovery reconnects before it buys.** Both whole-track and chapter transcription recover accepted tasks for free, distinguish fully refunded retries from paid replacements, and checkpoint one replacement per eligible missing section against a shared subtitle ceiling before confirmation. Restart and repeated requests reuse the saved provider identity; a dedicated manual purchase action accepts only the failed job's exact missing sections.

## v1.4.101 — 2026-09-05

- **Generation fan-out now follows each GenStudio API key's live capacity publication.** Image, Scene Review, and thumbnail Auto staging use the keyed burst advisory while exact image permits remain mandatory. TTS combines its model's provider hint with the keyed account burst, and subtitle/video staging uses their own keyed capacity instead of inheriting the image dial. Unknown capacity stays conservative and explicit, with the local CPU/IO and LLM lane limits unchanged.

## v1.4.100 — 2026-09-04

- **Unavailable LLM models now explain why they are paused.** Story Studio carries GenStudio's allowlisted daily-capacity or temporary-backpressure reason and published return time into the disabled picker row, formatted in the device's local date and time. Older catalogues keep the existing generic wording, and unavailable rows remain grey and unselectable.
- **Long narrative batches now recover cleanly from output truncation.** When GenStudio reports `finish_reason: length` or its durable `LANGUAGE_PROVIDER_INCOMPLETE` code, complete chapters remain untouched and only unfinished chapters receive one bounded, single-chapter repair request. The 8,192-token allowance applies to each repair batch, not the whole story; generic provider failures and ambiguous submissions still require explicit Retry. A malformed empty response remains a visible manual-retry outcome because its settlement is not safe to infer.

## v1.4.99 — 2026-09-03

- **Image work now enters GenStudio through its live admission permits.** Story Studio keeps the chosen episode-lane setting as local staging, waits locally when GenStudio has no confirmed capacity, and submits work only after GenStudio authorizes the exact account, model, and image operation.
- **A delayed image request stays safely recoverable.** Waiting, paused, and resumed work reuses the same request identity and permit evidence instead of treating elapsed time as permission to buy a second request. Capacity waits and tail overlap remain in local staging; every paid image still requires its exact GenStudio admission permit before submission.

---

## v1.4.98 — 2026-09-03

- **YouTube uploads no longer fail because Story Studio's private chapter and source markers leaked into the description.** The readable chapters, timestamps, citations, and links remain exactly where expected, while the internal boundary lines are removed at the final upload gate. Any other angle bracket that YouTube forbids is also removed before submission, so the API can no longer reject an otherwise valid description with `invalidDescription` for this reason.

## v1.4.97 — 2026-09-02

- **Durable queue evidence now coalesces safely during concurrent job updates.** A burst of pause, resume, cancellation, and recovery mutations is captured in the correct project snapshot instead of serialising into redundant writes or losing later intent after a failed write. Authoritative paid-work inspection now reads the persisted job record under the checkpoint lock, so a stale in-memory copy cannot authorize a replacement.

## v1.4.96 — 2026-09-02

- **Relaxed-queue voice models now appear on their own clearly labelled shelf.** Story Studio preserves GenStudio's queue classification and availability notice, keeps direct and relaxed Fish Audio products separately selectable, and shows the relaxed shelf after the direct catalogue with GenStudio's disclaimer once for the group.
- **Published TTS sale pricing is visible without changing how narration is charged.** The picker shows the current per-1,000-character rate beside GenStudio's undiscounted rate and carries GenStudio's sale details through unchanged; quotes and finished-job settlement remain authoritative.

## v1.4.95 — 2026-09-02

- **Chinese Ink-Wash Storytelling is now a standalone visual style.** Its original full-frame preview, calligraphic wet-and-dry brush language, rice-paper negative space, mist-built depth, searchable metadata, and text/seal/UI exclusions ship together as one independently purchasable Content Pack.
- **Distinct visual variants are welcome when their rendering contracts are genuinely different.** Similarity alone no longer redirects an author to an existing style; only indistinguishable duplicates and simple renames are rejected, while originality, composition-copy, identity, safety, and commercial checks remain unchanged.

## v1.4.94 — 2026-09-02

- **The Style Library now shows Content Packs only.** The 17 retired built-in cards and their duplicate frontend preview files are gone, so each installed signed style appears once and a new customer sees only styles they actually own or receive.
- **Existing projects keep their chosen legacy look.** Project-local `builtin-*` style copies remain renderable for compatibility, but they are no longer republished into the library. New style authoring is now locked to standalone, independently purchasable Content Packs.

## v1.4.93 — 2026-09-01

- **The legacy Content Pack migration is complete as standalone choices.** Seventeen remaining Formula and Topic products and four prepared Style and Thumbnail products now have finished independent sources, while the free History, Explained 1.0.2 compatibility successor stays a free built-in and is not counted as a paid product.
- **Old projects keep working without reviving Channel Kits.** Runtime compatibility IDs remain readable, Dark Psychology resolves through Human Behavior, Music Mix stays available only to existing projects through its dedicated music workflow, and historical Kits remain read-only. Five unused pre-sale reservations were safely withdrawn with their identities permanently retained, so they cannot be recycled or quietly return as products.

## v1.4.92 — 2026-09-01

- **Confirmed failed images can optionally be replaced, with a firm spending boundary.** This image-only setting is Off by default. When enabled, Story Studio waits a fixed 30 minutes and requires authoritative failed-task evidence before considering a replacement. It then refreshes the exact current published price for the same image request and allows at most one replacement per image, only within the additional-credit ceiling you must set for each Story job. Audio and video are unchanged.
- **Thumbnail status now reports what is actually on disk.** Episode list and status responses include the expected thumbnail count, the number still present, and whether the set is complete. If a thumbnail file is removed after generation, connected tools can see the missing asset instead of relying on the historical completion flag.

## v1.4.91 — 2026-08-31

- **Scene-image jobs now share their places fairly.** Continuity Render and Image Pool take turns when both are waiting, while work that is already recovering keeps its place ahead of new work of the same kind. The image-pool generator itself remains serial.
- **One verified Continuity final wave can overlap by one job when GenStudio has just confirmed headroom.** Your chosen scene-image concurrency remains the normal limit. Story Studio may start one next fairly selected image job only after it proves a running Continuity Render is in its under-filled final provider wave and rechecks fresh account capacity. This does not buy or replace work, and it does not promise a speed increase.

## v1.4.90 — 2026-08-31

- **Work held by a temporary connection or capacity problem can safely pick up again.** Story Studio now checks what has already finished before continuing, keeps completed output, and retries only genuinely missing work through its normal safeguards. A pause you made yourself remains paused until you choose to resume it; a temporary failure can still require another attempt if the service cannot complete it.
- **Paused work is easier to find and rejoin.** Filter the Jobs page to Paused and rejoin the visible scope in one action. The page gives immediate “Rejoining…” feedback, and the controls remain usable on compact screens.

## v1.4.89 — 2026-08-31

- **Job timing stays in one dependable place while work is running.** The last-progress reading now remains pinned to the card’s right edge whether Story Studio can estimate time remaining or is still gathering enough evidence to do so. Its quiet state is easier to scan with a subtle information treatment, and a stale reading now carries the same treatment with a clearer warning signal. The timing group also moves cleanly to its own right-aligned row on compact screens.

## v1.4.88 — 2026-08-31

- **Jobs now say what needs attention instead of exposing internal Error and Failed state names.** Cards, filters, batch summaries, action help, and completion notices use the next useful customer action. The underlying queue states, retry and repair safety, settlement evidence, and full diagnostics under Technical details are unchanged.

## v1.4.87 — 2026-08-31

- **Job cards now describe the work you asked for, not the provider attempts behind it.** A completed image is counted from the saved-output audit, so a route that had to be tried several times can no longer make the card claim that several images are missing. If output really is missing, the card says how many images are ready and how many need another try. Attempt IDs, codes, retry chains, and per-attempt records remain available under Technical details when they are useful for support.
- **Credit figures now distinguish a confirmed outcome from an outcome still being checked.** Story Studio only says “No credits charged” after GenStudio has published a complete, balanced settlement. Partial or missing information stays plainly pending, with any returned amount marked “so far”.
- **Automatic image retries are now fail-closed.** A child image request is retried automatically only after GenStudio proves it charged zero credits and released the entire reservation. Content refusals ask you to review the prompt instead of submitting the same prompt again.
- **Architecture documentation now reflects the live GenStudio boundary.** It no longer describes retired direct image and narration providers as active.

## v1.4.86 — 2026-08-30

- **The Story workflow now puts Script Generator immediately before the optional Introduction everywhere it is shown.** The shared order propagates through the sidebar, workflow ribbon, dashboard, Production Board, and episode status strip. Every flow keeps the same stages, routes, completion rules, presets, and pipeline execution; only the user-facing order changes so the episode is written before its optional opening is configured.

## v1.4.85 — 2026-08-30

- **Scene-image throughput now starts at the safer two-episode recommendation, and Custom works when you need something else.** A new install — or one with no saved value — now runs scene images for two episodes at once instead of three. A value you already chose is left alone. Choosing Custom always opens a numeric box, even when the current number is also one of the named choices; it accepts the established one-to-fifty range, and the save message reports the value Story Studio actually applied.
- **The Jobs page now puts the useful action and explanation first, without exposing internal job and request codes.** Each active card leads with its safest normal action and keeps cancellation or abandonment alternatives under More actions. Repeated capacity notices collapse into one count, Review failures takes you straight to the failed rows from the latest pipeline run, and full errors plus provider item state remain available in clear disclosures. Internal identifiers are still retained for reconciliation, settlement, recovery, and support evidence, but are no longer printed in cards, messages, notifications, previews, or related generation confirmations.
- **Account-capacity numbers are shown only when GenStudio has just confirmed them.** A fresh, well-formed account overview shows the live standard lanes, provider queue, and submission rate. Missing, stale, or malformed data instead says that capacity is unverified and schedules conservatively, so fallback numbers can no longer look like live account facts.

---

## v1.4.84 — 2026-08-30

- **Three scheduled videos went up titled "# SEO-Optimized Video Titles". That cannot happen again.** When Story Studio asks for five title ideas it asks for them one per line, with no commentary. Almost always that is what comes back. Occasionally the model writes its own heading above the list first — *"# 5 SEO-Optimized Video Titles — EP0061"* — and the step that tidied each line knew how to remove a dash, a number, a full stop and a pair of quotes, but had never been told anything about a `#`. So the heading survived as the first line, was picked as the episode's title, and went to YouTube as the name of the video. It also pushed the fifth genuine title off the end of the list to make room for itself. Story Studio now recognises a heading, a numbered preamble and the wording of its own instruction for what they are, and throws them away *before* it chooses — so the heading never becomes a title, and no real title is lost to it.
- **Episodes already sitting on YouTube with the wrong title can be repaired with one click.** The five titles the model actually wrote are saved beside every episode, and the broken ones were only ever the heading that got in front of them. Story Studio now notices when the saved title is a heading rather than a title and uses the first real one instead. Press "↻ Update metadata" on the affected row and the correct title replaces the heading on YouTube. Your privacy setting and your scheduled publish date are not touched.
- **Descriptions no longer show you the asterisks and hashes.** YouTube has no bold and no headings — it prints `**AI DISCLOSURE:**` to your viewers with the asterisks still in it, and `# The Harbour That Waited` with the hash still on the front. Story Studio now removes the marks and keeps the words on the way out, so the heading reads as a heading and the sentence reads as a sentence. It also drops the `EPISODE EP0057 —` label the document uses to name itself, which is scaffolding for you and noise for a viewer. Nothing is deleted: across every episode package on this machine, not one word of actual writing was removed — only the marks around it. The chapter list and the sources list the app builds itself are left exactly as it built them.
- **And a refusal, so this is caught rather than discovered.** Every upload and every metadata update now passes one last check immediately before it reaches YouTube. If the title is empty, is a heading, repeats the instruction we gave the model, or carries formatting marks — or if the description still has any of that in it — the upload stops and says so in plain words, quoting the exact text it is objecting to and pointing at the Metadata page. The check sits at the only two places anything in the app can reach YouTube at all, so no part of it can go around them. It was calibrated against every episode package on this machine before being switched on: it flags the three that were genuinely wrong and stays silent on the other eight hundred and fifty-four, including the ones whose titles legitimately end with an episode number.

---

## v1.4.83 — 2026-08-29

- **The app stays responsive while it is rendering video.** Opening Story Studio during a render used to show "Loading channels…" and sit there, sometimes for a very long time, looking like it had died. It had not — but four separate things it does on the way to answering *any* request were asking the disk a question and then refusing to do anything else at all until the disk answered, and a disk busy writing video does not answer quickly. Writing the request log did it, on every single request. Sweeping away old log files did it, on whichever unlucky request happened to land on the hour. Reading your channel list did it three times per channel, two of them outside the safety net written to catch exactly this. And working out where your Library is did it once more per channel on top. None of them wait like that any more, and the safety net now covers every part of reading a channel — so one folder on an unresponsive drive costs you one slow row instead of the whole app.
- **Your channel list appears immediately, and refreshes behind itself.** The home page no longer starts blank. It shows the channels from your last visit the moment it opens, quietly says "Refreshing…" while it checks, and reconciles when the answer arrives — whatever the app returns replaces what you were shown, so a channel deleted elsewhere still disappears. If the check fails, the list stays on screen and says plainly that it could not be confirmed, with the buttons to try again or to point Story Studio at a different Library folder. The very first run on a new machine still shows the spinner, because there is genuinely nothing to show yet.
- **A request that never comes back now says so instead of spinning forever.** The app had no time limit of any kind on its own internal requests, so anything that got stuck stayed stuck silently. There is a limit now — generous enough that nothing you legitimately wait for, such as a picture being generated, a pack being installed or a preview being rendered, comes anywhere near it — and all three limits are settings you can change.
- **Pickers no longer show you internal codes instead of names.** When the model or voice list could not be loaded, the model picker and the voice picker both fell back to displaying the raw internal identifier of whatever you had chosen — strings like `gemini-3.1-flash-lite-discount` — in the box, and again when you hovered over it. Story Studio now remembers the names of the models and voices you have used, so it shows the name and adds "(unverified — catalog unavailable)" so you know it could not check. Where it has never seen the name it says "Saved model" or "Saved voice" rather than showing you a code. What may actually be *run* is unchanged: an unconfirmed choice is still checked before anything is generated or charged.
- **Research documents name the model, not its internal code.** Every `research.md` carried the raw product identifier in its header line. It now carries the model's published name — and where that cannot be looked up it simply leaves the model out, rather than printing a code at you. The identifier is still kept in the machine-readable file beside it, where it belongs.
- **A hundred identical failure lines are now one line with a number on it.** When a busy period caused a batch of images to be declined all at once, the job card wrote out the same sentence — "an image didn't finish, the provider declined it, 9 credits were returned" — once for every single image. Over a hundred times, identically. It told you nothing the first line hadn't, buried everything else on the card underneath it, and left you counting rows to find out how many there were and how much came back. Repeats now collapse into one line that says how many and adds up the credits: "37 images didn't finish… 333 credits were returned in total." Genuinely different problems still get their own line each, because a different cause is something you need to read. Nothing is hidden — every individual item is still listed, one by one, under Technical details.
- **Two different times for the same deadline, one of them wrong.** A queued card could read "automatic escalation at 00:00" and, in the very next sentence, "GenStudio will step in Today 10:24 PM" — the same deadline, stated twice, hours apart. One of them was being read out of a sentence written by the service by looking for anything that resembled a clock, which sometimes found the wrong number and never adjusted for your time zone. The other was the real timestamp, which was sitting right there all along. The guesswork is gone; the deadline is now said once, from the real value, in your time zone.

---

## v1.4.82 — 2026-08-29

- **Scene lengths now land inside the pacing band you chose, instead of always overshooting it.** When Story Studio divides an episode into scenes it walks the subtitles and closes a scene once it has enough narration. It was adding the next subtitle line and *then* checking the length — so it closed at the end of the line that broke the limit, and every single scene came out at your target plus one whole extra line of speech. On a tight band that pushed scenes past the maximum you set, and the safety check meant to catch exactly that could never fire, because the target was always reached one line earlier. Scenes now close at the last subtitle boundary that actually fits, choosing whichever boundary sits closest to your target. The one case that can still run long is a scene spanning a silent gap between chapters — the silence is not narration, so it is no longer counted against your maximum, and nothing is chopped up to satisfy a limit it was never breaking. The same mistake in the fallback used when scene planning fails has been corrected too.
- **"Repair long scenes" now actually repairs them — and tells the truth when it cannot.** The repair re-divided the plan using the same faulty walk, so it frequently changed nothing and then reported "no scenes exceed the selected cap", sending you off to re-stitch subtitles that were already perfectly correct. With the division fixed the repair now converges. When a scene genuinely cannot be divided — it holds a single unbreakable subtitle line, or spans silence with no narration to cut on — it says so plainly and suggests the two things that would actually help.
- **Scene Review flags over-long scenes against your pacing setting rather than a fixed twenty seconds.** It was accusing scenes your own settings consider perfectly fine, and staying silent about ones they consider too long. It now reads the same number Scene Plan does, and re-reads it when you switch episodes.
- **Job cards are now progress trackers instead of walls of technical detail.** A running batch used to be a list of every scene, one line each, beside a code that means nothing to you and a pile of billing rows — you had to count the lines yourself to work out how much was left. A card now says how many pieces there are, how many are being made right now, how many are done and how many remain, roughly how much longer, and when something last actually happened. Money is three plain figures: charged, on hold, returned. Anything that went wrong gets its own sentence saying what failed, whether you were charged, and what happens next — and the link to inspect problems only appears when there are problems. Every log line, every per-scene state and every identifier is still there, folded into one "Technical details" panel.
- **The time remaining is measured, not guessed.** It comes from how fast this job is actually settling, and it is withheld until enough has finished to mean something. Failing that, it uses how long this kind of job has genuinely taken before. Failing both, it shows nothing rather than inventing a number. The same is true of "last progress: 40 seconds ago" and of deciding when a quiet job has been quiet too long — that is judged against how fast this kind of work normally moves, measured, not against a figure typed into the code.
- **Episode lists now always agree with the episode's own page.** Finishing a step could leave the selector, the pending filter and the Production Board still reporting the state from a minute earlier, while the page in front of you said the work was done — the "Steps 10 of 12" against "100% greenlit" split. Two causes, both closed. Saving a change asked the app to refresh in a way that never actually cleared the stored answer, and four of the scene-image actions never cleared it at all. And three different screens each kept their own private list of which steps count, which had quietly drifted apart — the dashboard's was missing two stages entirely. There is one list now, and one definition of a finished episode, which all three read. Optional steps still never hold an episode back.
- **"Pending only" now says why a finished episode is still on the list.** Keeping the episode you have open is deliberate — a step you just completed should not vanish from under you mid-edit — but the row looked exactly like a genuinely pending one. It now says so.
- **Progress messages no longer describe our machines.** A retry could read "every machine was busy"; a queued job could report which of our sites had not accepted it and when its placement window closed. That is our plumbing, not your business, and it is now written in terms of the thing you actually care about: high demand, waiting for capacity, and when it escalates. What matters is unchanged — whether you were charged, and that it is retrying by itself.

---

## v1.4.81 — 2026-08-29

- **If the app is closed while pictures are being made, it now picks the work back up instead of quietly starting something else.** Quitting mid-batch left those episodes in a strange half-state: still shown as running, but not actually running, and never marked as failed either. Because they no longer counted as using one of your generation slots, the app saw three free slots and started three *new* episodes — so three jobs became six, all competing, while the interrupted ones sat still. Meanwhile the service kept working on what it had already been given, and finished a few hundred images nobody was collecting. Interrupted picture jobs now restart themselves the moment the app opens. Anything the service already finished is pulled down using the receipt saved next to each picture, at no extra cost, and only genuinely missing pictures are ordered again. Because they rejoin the queue before anything new is admitted, they also get their slots back first — so the interrupted work finishes before fresh work begins, rather than after. This is the same recovery narration has had for months; pictures were simply never added to it. A job with nothing worth collecting is still left alone rather than restarted, so nothing is re-ordered on a hunch.
- **A large batch can now finish checking with the service instead of asking forever.** When the app wants to know how a big job ended, it asks about each picture in turn, with one time limit for the whole round of questions. It also asked again about every picture it had already had a final answer for — on a batch of a hundred and forty, that was ninety-six pointless questions, and the time ran out before it reached the ones that actually mattered. Five seconds later it started over from the beginning and did the same thing again, forever. It now skips anything already settled, so the questions that matter get asked. Answers it already has are still counted, so a failure buried among successes still decides the outcome and cannot be lost.
- **"Clear finished (6)" now clears six.** Six cancelled jobs, a button offering to remove them, and clicking it removing nothing — repeatedly, with no explanation. Nothing was broken on either side; there were simply two different definitions of "this is finished" written in two places, and they disagreed about one word. The button used one and the thing behind the button used the other, so it counted rows it would then refuse. There is one definition now, in one place, which both read. A cancelled job counts as finished and can be removed. Work genuinely still running at the service is still protected from being cleared away — and is no longer counted by the button either, so the number you see is the number that disappears. If a click ever does clear nothing, it now says so and points at the row that explains why, instead of reporting "cleared 0" and leaving you to guess. A narrower version of this was fixed in v1.4.77; the count was corrected then, but the second definition was left in place and brought it back.
- **A job interrupted by a restart no longer says it is dealing with a cancellation you never asked for.** Work picked up after a restart and work that was genuinely cancelled followed the same path, and both reported "reconciling the provider cancellation" — telling you an action had been taken that had not, on work you still wanted. Interrupted jobs now say what is actually happening: the app is checking what the service already finished.

---

## v1.4.80 — 2026-08-29

- **When a writing request fails outright, the app no longer blames the model for something it was never sent.** A batch of scene prompts was refused by GenStudio before a single word came back — the reply had not proved it came from the model you paid for, so it was thrown away rather than handed to you. Story Studio then examined a response that did not exist and wrote, once for every scene in the batch, that the model had left that scene out of its answer. Fifty accusations about fifty seconds of silence. Worse, those invented complaints were passed straight into the automatic second attempt, so every paid retry opened by telling the model it had dropped scenes it had never been shown. A failure that produced no reply now produces no per-scene findings at all. The scenes are still reported as missing, the automatic repair still runs, and the repair now says plainly that the previous attempt returned nothing — which is what actually happened.
- **That refusal now says what it was.** GenStudio checks that a reply really came from the model a product sells, and refuses it when it does not. Story Studio did not recognise that particular refusal, so all you saw was the generic "language generation failed" with a code after it and no cause. It now reads as what it is: the reply did not identify itself as the model you bought, so it was refused rather than passed off as yours. A second, quieter version of the same gap is closed too — one of the reasons the app already knew how to explain could never be recognised when it arrived quoted inside the message rather than published as its own field. Reasons are now read from one list, so a new one is understood everywhere the moment it is added.
- **Abandoning a stuck job no longer tells you nothing was refunded when your credits are already back.** In this same incident, GenStudio had released every credit on its own side forty-three minutes before the job was abandoned — and the job's own log said so, three lines above the message insisting otherwise. Story Studio itself holds no balance and cannot refund anything; that is true and is still said. What it will no longer do is speak for GenStudio. If the job recorded credits coming back, the message now quotes them and adds them up. If it recorded none, it says where the real figure lives — your GenStudio account — instead of announcing a verdict it has no way to know.

---

## v1.4.79 — 2026-08-29

- **The word "Episode" is gone from the other place it was being drawn, too.** The previous release fixed this where thumbnails are made on the Image Prompts page. Generating a whole episode in one go writes its prompts by a separate, older route that never passed through that fix — and worse, it instructed the model outright that every thumbnail "MUST include" a sentence beginning *The episode title "…"*, which the model duly lettered into the picture. That instruction no longer contains the word, and the prompts this route produces are now cleaned before they are written to disk, so a model that says it anyway still cannot paint it. Found by checking whether anything else reached an image model the same way; it did.

---

## v1.4.78 — 2026-08-29

- **Thumbnails no longer have the word "Episode" painted into them.** Titles are drawn into your thumbnails on purpose — that is what the text controls are for — but the instruction sent to the image model called it "the episode title", and a model that draws text draws the label along with the words it labels. So "Episode" kept appearing above the real title, inside the artwork, where the only fix was to generate again. The label is now stripped from every prompt at the last point before it is sent, which is what matters, because the phrasing arrived from three separate places at once: the writing model that composes the prompt, the guidance inside published thumbnail packs whose contents are frozen and cannot be edited, and the built-in channel guidance. Only that final step sees all three. It is removed at the two sources that can be changed as well, so in most cases the phrase is never written in the first place. Your title still goes in exactly as before; only the word "Episode" stops coming with it.
- **A model that vanishes from your account is now visible instead of silent.** When a pinned model disappeared, the app quietly healed the selection and carried on without saying so, leaving you reading a menu that no longer described what would actually run. The substitution is now shown on the three screens that ask for it, and it travels with the result on the prompt-edit screen too, which had no job log to carry it.
- **How long a writing request may run is now yours to set.** It was a fixed number in the code. A long chapter on a slow provider hit that ceiling and failed for no reason you could see or change. It is a setting now.
- **Research can approve claims for you, if you ask it to.** A new "Approve claims automatically" toggle, off by default, so nothing changes unless you turn it on.
- **Saving an edited image prompt no longer depends on when the page was opened.** The save route was being registered while a request was already being handled, rather than once at startup — the kind of ordering that works until it doesn't. It is registered at load now, like every other route.
- **The Deep Time Field Record gains its third volume.** *Human Origins & Ancient Worlds* is written: a hundred named subjects with twenty distinct angles each, every one anchored to a named site and a named stretch of time — two thousand episode ideas, matching the first two packs in the collection exactly. The boundaries against the two already shipped were settled by a check written before the pack was, rather than argued about afterwards.
- **A retired formula is no longer referenced by a pack that ships today.** The Wars & Treaties Topic Pack still pointed at a formula that no longer exists. Its published versions are frozen and cannot be edited, so the correction ships as a new version alongside them, and the originals are left exactly as they were.
- **The built-in copy now says what the published packs say.** Fifteen pieces of wording across seven files had been waiting on a publication that has now happened, because the live copy is pinned field-for-field to published pack contents and those cannot change once sold. Every replacement was derived from the difference between each pack and the one before it rather than retyped, so the two agree exactly.
- **The pack shipper stopped refusing packs it should have accepted.** Its check for third-party trademarks read pack files as raw bytes, so it also inspected internal identifiers — lookup keys the app branches on and nobody ever sees. That refused nine of the thirteen approved packs, each on an identifier the plan had deliberately kept. It now reads those files as documents and checks exactly the text a customer can see, and a file it cannot read still falls back to the strict byte check rather than passing quietly.

---

## v1.4.77 — 2026-08-29

- **Scene Plan now writes as many scenes per request as the chosen model can actually take, instead of stopping at fifty.** The panel said it sized each batch from the selected model's published output limit, and it did — and then threw that number away against a fixed ceiling of fifty that nothing on screen mentioned. Typing 200 into the batch field got you fifty and no message, because a value above the ceiling was rejected and quietly replaced by the default. Measured across eighty-five thousand real scene prompts, one scene costs about 150 tokens typically and 330 at the 99th percentile — so fifty scenes were using three percent of a large model's allowance, and not one request on record had ever hit a provider's output limit. The ceiling was protecting nothing. Batch size now defaults to 250 and has no maximum anywhere in the code, and the two numbers behind it — how many tokens to allow per scene, and how much of the model's allowance to use — are settings you can edit under **Scene Plan → Advanced batch controls**. A value the model genuinely cannot take is now reported to you rather than swapped out behind your back, and a reduction the model forces is stated where you can see it. On a library the size of the one this was measured on, the same work falls from about 1,950 requests to about 590. Every successful request now also records how fast it ran, so the next decision about batch size is a lookup rather than an argument.
- **A job that can never be finished can now be let go.** A batch of narration transcriptions charged for the nine tasks it managed to send and then lost the connection before the other twenty-two were given an id. The job ended in Error, and every way out of it refused at once: retry declined because the provider evidence was unsettled, "Clear finished (1)" counted the row and cleared nothing, removing it from history did nothing, checking with the service again was offered but could never succeed — and the one action built for exactly this, abandoning the job, was not offered at all, because the app measured "you still have a way out" by whether any button was clickable, and the useless one was. Abandoning is now offered whenever there is no working way to clear the row. Two things behind it were wrong as well: the check that matches your job up with the provider's work only ever looked at the eight most recent items, so any batch larger than eight declared itself permanently impossible to reconcile; and a check that landed after you abandoned a job recorded "every task for this job has finished" against the one job we know least about. Abandoning is not evidence, and is no longer minuted as if it were. Nothing is deleted when you discard: the charge and all thirty-one task ids survive, no success is claimed, and the row stays there to inspect until you clear it. The "Clear finished" badge also now counts what the button will really clear, instead of promising one and delivering none.
- **When a provider refuses your image or your narration, you now see why.** A blocked thumbnail said only that image generation had failed, with a code after it. The actual reason existed the whole time — a refusal naming the objection — but it never left the service that received it, so the same prompt was retried three times at twenty credits a go, and the credits came back but the hour did not. The provider's own sentence is now shown on the failed job, and when the refusal was about the content, a short line suggests rewording. That suggestion is chosen from a stated category, never by reading the words of the message: when the service says plainly that it does not know why something failed, no advice is offered at all — inventing "try editing your prompt" is how somebody rewrites a prompt that was never the problem while the real cause goes unnoticed. Against a service that publishes neither field, the message you see is exactly what it was before.
- **Third-party trademarks are out of everything a customer reads, including the parts that can never be changed afterwards.** A style pack's display name had already been cleaned up; its identifier had not, on the assumption that an identifier is internal. It is not — it is printed on the permanent Installed tab, it becomes the filename you save, a folder in your own library, and a key inside your project file, and unlike prose it freezes for good the moment a pack is first sold. So the identifier is the harder surface, not the softer one, and it has been renamed. Thirteen already-published free starter packs could not be edited at all, because a published pack's contents are frozen by design; they are reissued as new versions with the wording changed, and the originals left byte-for-byte as they were. One built-in art-direction note that asked for a look by brand name now asks for it by description instead — it is text you can read and edit, and it never reaches an image model, so nothing you generate changes. The check that guards this now covers identifiers, family names and filenames as well as prose, so a mark cannot quietly come back.
- **The Deep Time Field Record gains its ocean volume.** *Ancient Oceans & Deep Sea* is written: a hundred named subjects, each with twenty distinct fully-authored angles, every one anchored to a named site and a named stretch of geological time — two thousand episode ideas with no padding, matching the first pack in the collection exactly. The pack was held back until the thing that made it risky was settled first: marine reptiles, ocean anoxia and reef extinctions can each be written honestly from either side of the line between "the organism and the extinction" and "the ocean as a system, and the record it left". That boundary is now held by a check built and deliberately broken before a single line of the pack was written, four borderline subjects were ruled on in writing, and two whole categories were left unwritten rather than argued over. The same check will measure the next pack in the collection on the day it lands.
- **The test system now has to prove every lane ran, not just the biggest one.** The last release closed a hole where a test file could die halfway through and have its results silently discarded, so a run finished green with whole files missing — but only one of the four lanes was given that floor. The other three still rested on their own summary, which is precisely the thing that had just been proved capable of lying. All four now report how many of the files they found actually finished, and a lane that discovers nothing fails instead of passing, which is otherwise the most convincing green light there is. Separately, four false failures in a single day all turned out to be tests asserting that the machine would schedule them promptly — an assumption that is simply untrue when several test runs share one computer; one forty-millisecond pause was measured taking two and a half seconds. Those now either control the clock outright or measure their patience in work done rather than time passed, and a ratchet keeps the remaining cases from multiplying. A failing lane is also named correctly in the verdict now, rather than every failure being reported as the backend one.

---

## v1.4.76 — 2026-08-28

- **Opening the episode list on a large project now takes seconds instead of minutes.** On a project with three hundred episodes the first open took just under eight minutes, and while it ran the rest of the app stopped answering — every other page you tried timed out waiting for it. The app was re-reading the entire project folder from scratch once for every single episode, to answer a question whose answer was identical for all of them: over one and a half million file lookups to draw one list. It now reads the folder once and reuses that answer for the whole request, which makes the first open roughly twenty times faster, and the app stays usable while it happens. The list itself is also 15% smaller, because every row had been carrying a file path that nothing anywhere ever read.
- **Video Assembly now says exactly what is missing, and a skipped opening can be covered in one click.** An episode could pass Scene Review completely green — every scene approved, nothing missing, nothing stale — and then be refused by Video Assembly with "Not ready", with neither page saying why. Both pages were right, about different things: the plan genuinely had nothing covering the first four minutes, because the opening chapter was skipped when the plan was made, and only one of the two was looking at that. Rendering it would have put four minutes of narration against a frozen frame and pushed all three hundred scenes off the audio they were timed against. Video Assembly now names the gap in seconds instead of blaming "timing, images and approvals" as one lump, the same gap is shown on the Scene Plan page where you can actually act on it, and a new **Cover the opening** action closes it by holding the first scene across it. It is opt-in, never assumed, and states what it will do before you choose it. "Repair coverage" is no longer offered for this gap — it declines gaps this size by design, so the one-click fix the old message pointed at could only ever have done nothing.
- **A narration chapter whose connection drops is now retried, instead of failing the batch.** A dropped connection is not a refusal — nobody said no, the answer just never arrived — but it was being treated as a dead end, so a momentary network blip ended a chapter on the first attempt and reported it as a raw connection error. Those chapters are now retried on a ladder measured in minutes rather than seconds, which is the scale a provider restart actually takes. Crucially the retry reuses the same job rather than starting a new one, so a chapter that was in fact received while the connection dropped is reconnected to instead of being bought a second time. You are never charged twice for one chapter.
- **The batch will no longer write a new opening over one you already have.** Episodes made before openings were split into their own file keep the opening inside the main narration, and the check for "does this episode have an opening" only ever looked at filenames — so it found nothing, and the batch happily generated a fresh opening straight over the real one. There is no versioning on that path and no backup, so the original was simply gone, and credits had been spent destroying it. On a three-hundred-episode project where every episode genuinely had an opening, none of them were detected. Those openings are now recognised, once, and remembered.
- **An episode you looked at before its files existed no longer reports itself empty forever.** Opening an episode a moment too early — before the folders it will use are on disk — recorded that emptiness as the answer and then never checked again, for as long as the app stayed open. The work could land and the episode would still show nothing done, with nothing you could do about it short of restarting. That result is no longer kept.
- **Topping a channel up by a single idea works again.** Asking for one more idea failed while asking for sixty succeeded, which made it look like the pack had run out when it had fifteen hundred combinations left untouched. The search was sized from the size of your request rather than from how much of the pack was already spent, so a small request stopped looking long before it reached anything new. It now looks past what has been used, not just past what was asked for.
- **The per-episode concurrency setting now says everything it controls.** It was labelled "Images per episode at once", and it has never governed only images — subtitle transcription, AI video and continuity renders all share the same dial. So turning it down to be gentle on image generation quietly slowed three other things, with nothing on screen to suggest it would. It is now called "Cloud requests per episode at once" and names all four outright. Only the wording changed: whatever you have it set to stays exactly as you set it.
- **The Symbolic Psychology kit now offers a thousand episode ideas, and is four pieces like every other kit.** It was sold on the same depth as the rest of the shelf but pinned to a starter-sized Topic Pack, so it planned ten ideas and stopped. It is now pinned to a Topic Pack measured at a thousand genuinely distinct ideas by the app's own planner. It also carried two extra art styles, making it a six-piece kit where a kit is four; both are established packs in their own right and are now sold separately rather than bundled.
- **The Deep Time Field Record collection begins.** Its first Topic Pack, *Prehistoric Life & Extinction*, is written: a hundred named subjects across twenty distinct evidence-anchored angles each, every one tied to a named site and a named stretch of geological time — two thousand episode ideas, none of them padding. It pairs with the Deep Time documentary Formula the app already ships.
- **The test system can no longer report a pass for work it never ran.** A test file that ended early — a crash that happened to look like a clean exit — simply stopped producing output, and nothing downstream noticed: the run finished green with a whole file missing. That is how three suites vanished from a passing run. Every run now records which files actually finished and checks that against the files it found, so an incomplete run fails loudly instead of quietly. Three real problems the old behaviour had been hiding were found and fixed the moment it was switched off — including one that had been quietly leaving stray background processes behind after a failed run.

---

## v1.4.75 — 2026-08-28

- **The Archival Ledger kit now plans two thousand ideas, where it planned a hundred.** It was sold on the same depth as every other paid kit and pinned to a starter-sized Topic Pack, so it produced a hundred ideas and then ran out — twenty times short of what the rest of the shelf delivers. It is now pinned to a Topic Pack that measures a hundred subjects across twenty distinct settings each, so the depth is counted from what is actually written rather than assumed from the label. The kit is checked against that number by the app's own planner, not by the number printed on the box.
- **Five paid Topic Packs were rewritten to full depth, and the question seeder reached a thousand without padding.** A pack can reach a large number two ways: by writing a thousand distinct things, or by taking a small set and multiplying it until the count looks right. The second way passes a count and fails the promise, and it is why a pack was rejected here before. Empires & Trade, Infrastructure & Commodities, States & Revolutions, Wars & Treaties and Money & Debt have each been authored out to full depth and measured on every axis independently — the subject, the object, the setting, the mechanism and the evidence — so a thousand ideas means a thousand genuinely different ones. The audience question seeder now reaches a thousand the same way.
- **Two new thumbnail recipes, and you can see them before you choose.** A recipe described in words is a guess until you have spent something to find out what it looks like. Object Hero + Question and Route Map + One Promise both ship with rendered previews, so you are picking from pictures rather than from a description.
- **Your description no longer has to come out the same shape every time.** Every channel's description was built in one fixed arrangement, and the only way to get another was to rewrite it yourself afterwards. There are now five description shapes built in — a calm story-first opening, chapters first, a curiosity gap, community first, and a minimal one — with a picker on the metadata page, and a per-episode override so a single episode can differ without changing the channel. A channel that picks nothing behaves exactly as it did before, so nothing you already have moves.
- **The internal section names stopped leaking into your YouTube descriptions.** A description is assembled from named sections, and those names are instructions to the writer, not text for the reader — but the model was printing them into the description as headings, so words only ever meant for the app ended up in what your audience reads. New descriptions are now written clean at both ends: the model is told not to print them, and any that slip through are removed before anything is saved. Descriptions already on your disk are cleaned as they are displayed rather than rewritten underneath you, so they read correctly straight away and it costs nothing — no regeneration, no credits.
- **"Install all missing" now shows you it is working.** Pressing it began a long run of installs and then looked like a button that had not been pressed: no count, no progress, no way to tell whether anything was happening or how much was left. It now reports what it is doing while it does it.
- **Introduction previews are found again for episodes made before v1.4.73.** Openings written before that release were saved without a title recorded alongside them, and the preview looked them up strictly by title — so it failed to find work sitting right there and showed nothing, on episodes whose openings had generated perfectly well. The lookup now recognises those earlier openings and displays them.

---

## v1.4.74 — 2026-08-27

- **The Introduction preview fills itself in, and says so when it fails.** Asking for an opening only ever put the job in the queue, but the preview panel went looking on disk the moment you pressed the button — before anything had been written — found nothing, and was never told to look again. So the panel sat empty until you navigated away and came back. It now follows the same live job feed the rest of the app already listens to, and fills in as soon as the opening exists. And a generation that fails now says it failed, instead of looking exactly like one still running.
- **The composition workspace is back.** The whole feature was still there underneath — the job, the controls it drives, the model picker, everything — but one missing line meant the setting was thrown away every time the page loaded or saved, so the feature could only ever be off. It has been reconnected end to end, and whether you use it is a switch you own again.
- **Music prices show their discounts.** A sale price on a music model was read correctly and then displayed nowhere, so a discount was invisible — you could not see that a model was on offer, and you could not see when it stopped being. Music now shows the full price with the discount marked, the same way images already did, and it prices the model you will actually be charged for.
- **Photos from your phone work as references everywhere.** A phone photo is roughly four thousand pixels along its long edge, and the models publish a ceiling well below that. Only one of the places you can attach a reference was fitting the picture to that ceiling; every other one — master, per-scene, character, thumbnail and art style — uploaded it happily and then failed the render with "resize it and retry", on a file you had no way to resize inside the app. Pictures are now fitted once when they arrive, against the strictest ceiling published, and your original is never altered.
- **Moving between episodes on a large project is roughly five hundred times faster.** Every time the app regained focus, the episode dropdown re-read the entire project from disk to find out what had changed — on a project with hundreds of episodes that is a long, visible stall, repeated every single time you switched back to the app from anywhere else. The app already watches the folder and already knows the moment anything changes, so the rescan was rebuilding an answer it was holding all along. It now trusts what it is watching, and only re-reads what genuinely moved.
- **Pack updates and restores no longer jam on ownership paperwork.** Updating or restoring a pack you already own could stop with "Install failed — try again", and trying again did exactly the same thing, because the receipt the app checks did not list everything the account permanently owns — so a pack you owned outright could fail the ownership check. Both routes now verify against the full list of what you own, and the message you get when something genuinely is wrong says what is wrong instead of telling you to repeat yourself.
- **The Installed count is correct.** The number on the Installed tab was counting the wrong set, so it could disagree with the list sitting directly underneath it.
- **Relaxed Queue models now have a shelf of their own.** Some models are sold at a lower price in exchange for waiting longer in the queue. They were mixed in with everything else with nothing to mark them, so the cheaper price looked like an unexplained inconsistency rather than an offer. They now appear in their own clearly labelled Relaxed section in all three places you pick a model, with the trade-off stated once, plainly — including that the lower price is permanent, not a promotion that will expire.

---

## v1.4.73 — 2026-08-27

- **Every channel now opens in its own voice, instead of every channel opening like a sleep channel.** The opening was the same seven beats for everyone: a breathing exercise in front of a business explainer, a subscribe push before a prayer. There was a mechanism meant to let a channel differ, and it could never actually run — the setting it read was never filled in for any channel, so the branch that would have used it was unreachable. The opening now comes from the channel's Series Formula, the same place its narrator, its closing and its chapter counts already come from, and all twenty-two built-in Formulas ship an opening written for the kind of channel they belong to. It comes free with the Formula, because a default you have to buy is not a default. A channel still carrying the old seven beats is handed its Formula's opening; a channel whose opening was edited keeps every word of it, and the page says which of the two it is looking at.
- **The list of things an opening can cover grew from seven to twenty-one, and each one now says what it does.** "Community question" and "story teaser" meant nothing unless you already knew, and they were the only names on offer. There are now twenty-one, including a cold-open hook, what the episode answers, where the evidence comes from, reading a passage, an invitation to pray, and how to listen — and each is described in a sentence next to it rather than hidden behind an arrow, so you can tell which suit your channel. The breathing exercise now says outright that it is for sleep channels.
- **You can choose which model writes the opening, and save an opening as a reusable recipe.** The opening was written by whichever model wrote the chapters, with no way to say otherwise. You can now leave it as the same model — still the default, and what every existing channel has — or pick one just for openings. And the whole recipe (the beats, the wording, the length, the host, the model) can be saved and applied to another channel. Whether the channel actually uses openings is deliberately not part of the recipe, so applying one can never quietly start spending money on a channel that had it switched off.
- **Scene renders can now use the episode's reference image, which the switch promised all along.** The Character Sheet's "Use episode anchor" switch has been writing its setting to disk with nothing reading it, so you could turn it on and watch nothing happen. Renders now actually send one reference image per scene — the generated layout template if there is one, otherwise the anchor you uploaded — on character scenes only, so a cutaway does not drag the anchored character back into a frame they should not be in. Where the app's own template is larger than a model will accept, the app fits a copy rather than failing the batch and telling you to go and resize a file you never made; your original is untouched. Models that accept no references still render, and say why out loud rather than quietly doing nothing.
- **Visual Recipe is gone.** It was half-removed already: its editor had been deleted, and because of that every Character Sheet save switched the feature off and there was no way to switch it back on. Rather than leave a feature that could only ever be off, it has been taken out properly — the job, its controls, the leftover per-scene fields and the buttons that drove it. Episodes already on your disk are deliberately left exactly as they are; nothing rewrites your own files to remove a setting nothing reads any more.
- **The six built-in art styles are now proper packs, like everything else you can own.** They were hardcoded into the app, which meant they behaved differently from styles you install — most visibly, the built-in route quietly dropped the "avoid this" half of a style before it reached the image model, so part of what the style described was never applied. All six are now signed packs travelling the same route as any other, with the whole style arriving intact.
- **Every starter Channel Kit now delivers the thousand ideas it is sold on.** Each kit was pinned to the first version of its Topic Pack, so a kit advertising 500–1,000 unique episode ideas actually produced between 10 and 40. Four had a fuller Topic Pack sitting there unused; the other six had none written at all, so six were authored — fifty subjects each, every combination written rather than assembled. All ten kits are now measured at 1,000 ideas by the app's own planner, rather than assumed.
- **One Topic Pack was reaching a thousand ideas by padding, and has been rewritten.** Habits & Momentum passed the count and failed the promise: every subject shared one identical setting, every mechanism ended in the same fixed clause, and the subject's own name was glued into the text to make repeated entries look distinct. It counted to a thousand by multiplying, not by writing. It has been fully rewritten with fifty new subjects and a thousand genuinely distinct entries on every axis. A new check measures the difference rather than trusting the total, and it is honest about two other packs that are not yet where they should be instead of quietly passing them.
- **A retiring model's countdown is shown correctly in the thumbnail reference menu.** The badge that warns a model is being withdrawn was working out "how far away" from the wrong moment, so on the day the date rolled over it could state a figure that was a day out.

---

## v1.4.72 — 2026-08-26

- **The Production Board and the Pipeline stop disagreeing about Research and B-Roll.** The Board could say research was done for twenty episodes while the Pipeline showed every one of those episodes as still needing it. Neither view was lying about what it knew — the Pipeline simply had no rule for Research or B-Roll at all, and its list of rules quietly answered "not done" for anything it did not recognise. Both stages now read exactly the field the app itself checks when it decides whether to skip work, so the pills, the counts, the "select everything still pending" button and the batch run finally agree with each other. The tick keeps meaning what it always meant — that the evidence exists — and whether the claims have actually been looked at is now said in words when you hover, rather than being folded into the tick where it would have hidden a different problem.
- **Research runs several at a time, like every other writing job.** It was never given a place in the shared writing budget, and anything without one falls back to running strictly on its own. So fifty queued research jobs went one after another no matter how high "Writing jobs at once" was set — the setting simply did not reach them. Research now draws on the same budget as outlines, chapters and metadata, which is the honest place for it: it is an ordinary writing job, and giving it a private allowance of its own would have made the real number of things running at once a number nobody chose.
- **Two jobs can no longer overwrite each other's scene plan.** Twenty-two different places in the app wrote to an episode's scene plan, and none of them took any precaution against another one writing at the same moment. When two did overlap, the second wrote back the copy it had read before the first one started, and the first one's work vanished silently — no error, nothing in the log, just a field that had been set and was suddenly empty again. Every one of those writers now waits its turn and re-reads the file once it has it, so it is always editing the current version rather than a stale one.
- **Deleting a scene plan no longer brings it back.** Deleting was the one writer left out of the change above, because removing a file looks like the single case that cannot collide with anything. It is actually the worst of them: a job that is midway through its own edit rewrites the file when it finishes, so a delete that slipped in underneath was undone a second later, and the plan reappeared carrying only what that job happened to know about. The delete now waits its turn like every other writer, so what you deleted is gone and stays gone.
- **Chapter regeneration is now proven to stay one-at-a-time, not merely assumed to be.** It has to: each chapter regen rebuilds the episode's whole narration document from scratch, so two at once would talk over each other. That has always been true and was always argued from reading the code rather than from watching it happen — twice. It is now demonstrated by an actual test that turns the budget up as high as the app allows, asks for three chapters of one episode at the same time, and fails if more than one ever starts.
- **The Introduction is a real part of your channel now, and it has stopped forgetting itself.** Nothing anywhere recorded whether a channel opens with a spoken introduction. It was a tick-box tucked inside the Script page's Outline tab; it started switched off every single time, and something on that page switched it back off again whenever the page reloaded what it knew about the channel. Worse, the control was only drawn at all for channels whose Series Formula happened to describe an opening — one Formula out of twenty-one does — so on seven of your ten channels there was no control, and nothing to tell you openings existed. It is now its own page in the sidebar, marked Optional the way Research and Music Library are, and it is there whether or not you use openings, because a setting you cannot see is a setting you cannot learn about. It holds everything the old tick-box held and considerably more room: who the host is, how long the opening runs, the exact first line if you want to fix one, and the ordered list of things it covers — each of which you can switch off, move, delete, add to, or give your own wording.
- **Once a channel says it opens with an introduction, everything that writes an episode writes one.** The unattended batch runner used to keep its own separate tick-box for this, sitting beside the Script box, needing to be ticked on every single run. Forgetting it is exactly how four finished episodes ended up with no opening at all. That box is gone. A run that writes chapters for a channel with openings switched on writes the opening too, and the Pipeline says so on screen before you press Run rather than afterwards. A run that is only re-rendering audio for finished episodes is left alone, because it is not producing episodes and should not quietly grow an extra bill.
- **Your existing channels were not made to guess.** Neither answer was safe to assume for a channel that predates this: assuming "no" makes channels that were using openings go silently quiet, and assuming "yes" spends money on channels that never wanted one. So each channel's setting was worked out from what that channel has actually made — if it has ever produced an opening, it is switched on. The page says outright when the setting was worked out rather than chosen, and asks you to confirm it; saving, whichever way you leave it, settles the matter.
- **You can finally see which episodes have an opening — and you are warned before you pay to voice one that has not.** The app has known this about every episode all along and showed it nowhere: no tick, no count, no filter. It is a column on the Production Board now, and because the stage is optional it never holds an episode back from counting as finished. Separately, if you go to narrate an episode that has no opening on a channel that opens with one, the Audio page says so first. That is the last cheap moment to notice — the opening is read as part of the same narration, so adding it afterwards means voicing the episode again.
- **Asking for an opening now takes an episode and nothing else.** There is no model to pick on the Introduction page, and there is not meant to be: the opening is written by the same language model as the chapters it introduces, and the page says so in plain words instead of leaving a hole where a control should be. If it cannot work out which model that is, it refuses and tells you where to set one. It will not choose one for you.
- **Episodes always live in the channel's own folder.** A channel used to be able to keep its episodes anywhere on your disk, and that setting is why one of your channels appeared completely empty for a while — it was pointed at a folder beside itself that did not exist. Every one of your channels already uses the ordinary location, so nothing moves and nothing is lost; the ability to point somewhere else is simply gone, along with all the code that had to work out where a channel really lived. The honest warning stays: if a channel's episodes folder is genuinely missing, the app still says so, names the folder it looked in, and does not invent a replacement.
- **Two long-standing bugs fell out of removing it.** Files you had picked were sometimes reported as missing when they were sitting exactly where you left them — several pages were measuring "somewhere inside this channel" from the wrong starting point, and now measure from the real one. And a channel you happened to name "Episodes" never had its episodes folder created at all, so it reported itself missing forever.

---

## v1.4.71 — 2026-08-26

- **The app now warns you *before* a model disappears, not after.** GenStudio decides in advance when it will stop selling a model, records the date, and publishes it alongside every model in the list — it has been doing this the whole time. Story Studio read straight past it. The only thing the app could say about a retirement was said afterwards, at the moment a model you had chosen months ago stopped answering: "retired or unavailable, choose a replacement". A countdown that had been running quietly for weeks reached nobody. Models being retired are now flagged in the picker so you can spot them while browsing, and while one is chosen the app tells you underneath, in plain readable text, the date it stops being available **and how far away that is** — because a bare date just makes you do the sums. It says nothing about what to switch to: that is your choice, and the app has always promised not to make it for you. The same flag now appears in the other two places you pick a model as well — the thumbnail reference reader and the web-research list.
- **A channel you set up months ago gets the same warning.** The picker only helps someone who happens to open it, and there is no reason to reopen it before the date passes — which is exactly how this bites. Every model a channel has saved, wherever it was saved, is now checked against the same published dates, and anything being retired shows up under "Action needed" with its date and its countdown, soonest first. It clears itself as soon as you move that stage onto another model.
- **Six pieces of information the app was throwing away now arrive intact.** This was the third time in a row that GenStudio published something honest and Story Studio dropped it on the floor — after the credit balance, then the data notice. The full list of what else is being discarded has been written down, so the next one is found by looking rather than by a customer noticing.

---

## v1.4.70 — 2026-08-26

- **"GenStudio Unavailable" no longer appears while the app is working.** The little balance panel in the corner asked GenStudio for your credits once, waited eight seconds, and if that one request was slow or came back wrong it wiped the number and announced the whole service was unavailable — next to a narration job that was generating perfectly normally. Everything else in the app already knew better: the model catalogue and job submission both try again, and both fall back on the last good answer during a short interruption. That balance check was the only part that did not. It does now, and there are three honest answers instead of two: your current credits, your last known credits marked with how old they are, or — only after the retries have genuinely failed and there is nothing left worth showing — Unavailable.
- **GenStudio's data notice is now actually shown to you.** Some language models are offered at a reduced price on the understanding that what you send them may be kept and may be used for training. GenStudio publishes that notice on every model it applies to — and Story Studio was reading right past it. Since language models are only ever chosen inside this app, that meant nobody ever saw it: you could pick one of those models today without being told. Models carrying a notice are now flagged in the list so you can spot them while browsing, and the full wording appears underneath the picker, in ordinary readable text, for as long as such a model is the one you have chosen. It vanishes when you pick a model without one. There is no box to tick — the notice ends by saying not to use those models if you do not agree, so choosing one is the agreement, and there is nothing extra to click past.
- **Prices and limits say when they might be out of date.** The app keeps using catalogue figures for up to half an hour after a failed refresh, which is the right thing to do, but until now only the Settings page ever admitted it. The Audio Generator shows the rate per request, the minimum charge and the characters-per-request limit as plain fact, with nothing to say whether they were read a second ago or twenty minutes ago. A quiet "Last known · 12 minutes ago" now sits beside those figures whenever they came from a kept copy, and nothing at all appears when they are current. Settings, the balance panel and the generator all word it the same way.

---

## v1.4.69 — 2026-08-26

- **This is v1.4.68, rebuilt so that it starts.** The v1.4.68 download would not open at all. It was packaged from a folder where the app's supporting libraries were only a shortcut to somewhere else rather than the real thing, so the packager skipped them and the finished app had nothing to run on. Every fix listed under v1.4.68 below is in this build, unchanged — only the packaging was wrong.
- **A build that cannot start can no longer be released.** The release check confirmed the app was correctly signed, correctly named and correctly structured, but never that it actually runs, which is exactly how a dead build got through. It now opens the packaged app for real and waits for the app's own internal service to answer before the build is allowed to pass, and it separately confirms every library the app needs is genuinely inside the package.

## v1.4.68 — 2026-08-26

- **The app stopped writing its own name into your scripts.** Every narration file it built opened with a line naming the app and the episode number, and that line is the first thing a model reads when it works out what the episode *is*. That is why descriptions came back saying "In this episode of Story Studio" and carrying #StoryStudio — nothing you wrote put it there, the app did. The line is no longer written, and it is stripped out of files already sitting on your disk as they are read, so old episodes stop causing it too. What this does **not** do is go back and rewrite metadata you have already generated: descriptions and tags saved before today stay exactly as they were saved, deliberately, because they are yours to keep or change. Anything already uploaded has to be corrected in YouTube itself.
- **Audio is split up according to the voice you picked, not the one you used last time.** It had been reading the model from the episode's previous run, so changing voice and regenerating gave you sections sized for the old one. There was also a leftover 4,800-character limit and a table of chunk sizes for three voice engines that are no longer used at all. All of it is gone. The only boundary left is the published limit of the model actually in use.
- **The Introduction uses your script's model.** In a batch run it was quietly falling back to whichever model happened to be listed first, which is not the one you chose. It now uses the model set on your script, and if it cannot work out which one that is, it stops and asks you to pick rather than choosing for you.
- **Two lettering styles were describing the wrong thing.** "Script" and "Handwritten" live in the list that sets a finish — gold, ink, and so on — but their wording described letter shapes, so choosing either one quietly overrode the letterform you had already picked. They now describe only their finish, and read as Golden Shimmer and Inked Finish.
- **All 35 built-in lettering swatches ship inside the app.** Every one shows a real sample in the picker the moment you open it. The inked finish was redrawn as well: its texture used to flatten into a plain grey square once shrunk to picker size, so the one style whose whole point is visible grain was the one you could not see.
- **Errors no longer show internal file paths.** A pack that fails to verify or install now names the pack and what went wrong; where it lives on disk stays in the log, where it belongs.
- **Machine-specific and identifying details have been removed throughout.**

## v1.4.67 — 2026-08-25

- **The Story registry is reconciled.** Historical authored and reserved content-pack identities, exact receipt-bound dependencies, and the six lettering transitions now share one validated canonical ledger.
- **Ten thumbnail recipes are included locally.** All ten authored recipes have independent specification and visual-quality reviews, thirty deterministic 1672×941 previews, and repeatable keyless build evidence. They remain local authored source candidates; no purchase, activation, publication, or live stocking was performed.
- **Starter successors preserve their quoted history.** The two Formula 1.0.0 dependencies required by the immutable Kit receipt remain intact while the approved thumbnail successor references are verified.

## v1.4.66 — 2026-08-25

- **The Content Store works again.** It had a rule refusing any reply from GenStudio containing more than 4,096 separate pieces of data, and the list of what your account owns finally grew past it — eighteen packs bought today, each adding a receipt. Nothing was wrong with the store or your account; the app simply refused to read an answer that had become one item too long. The limit is now 65,536, about eleven times the largest thing you have, and still small enough to refuse a genuinely hostile reply. The check that proves you own what you bought is untouched, and a test now loads all 82 packs and verifies every signature to prove it.
- **When a reply is too large, the app says so.** This cost a full day to find because every failure looked identical: "The Content Store is unavailable", every count zero, no clue anywhere. It now names what was too big, which request it came from, and tells you that updating the app is the fix rather than refreshing.

---

## v1.4.65 — 2026-08-25

- **Installing a pack you own stopped asking GenStudio the same question 65 times.** Before every single install, the app fetched the entire release history of every pack you own — just to check whether any had been withdrawn. Installing a library meant thousands of requests. Nothing errored; it was simply slower than the app's own timeout, and it told you "the Content Store is unavailable" when the store was perfectly healthy. The server had already answered that question in one field the app was not reading. 65 requests became none.
- **Select all, then one click buys all.** The selection bar counted your packs and totalled their price, and then the quote showed one product and bought one product. It now prices the whole basket, shows a single total before you agree to anything, and settles each pack independently — so one failure does not undo the rest, and you are told exactly which failed and why. Packs you already own are skipped rather than charged, and a retry cannot buy the same pack twice.
- **A row of Content Store cards lines up.** The selection bar, the selection buttons and the install-progress strip had no styling written for them at all, which is why "2 selected" and the credit total ran together as one word. The cards used a layout that spread each card's spare height between everything inside it, so the picture, the price and the title landed at a different height on every card.
- **An information notice no longer looks like a warning.** Every heading in a notice box was coloured warning-amber, including purely informational ones — which is how you learn to ignore amber before a real warning arrives.
- **Internal notes stopped shipping inside packs customers download.** Four packs and two built-in channel types carried working notes naming this channel's own shows and four outside creators. They are gone from the bytes, not just the source.
- **The wildlife formula covers insects**, instead of excluding them and pointing at a pack that was never made. A thumbnail recipe that both required and forbade a subtitle banner now agrees with its own artwork, and three series that pointed at subject packs which do not exist now point at the ones that do.

---

## v1.4.64 — 2026-08-25

- **Your channel types no longer decide what your videos look like.** Nine of them carried art-direction written into the file itself, and if a channel had no style of its own the app quietly used that instead — with nothing on screen to say so. Four of your channels were being drawn in a look nobody had chosen. Each one has been pinned to the exact look it was already using, saved as a normal style you can see and change, so the pictures come out word for word the same as before.
- **A Formula can now only suggest.** Its recommended look appears on the Formula card in one of three plain states — already in use, installed with a button to apply it, or not installed with a link to where you can get it. Nothing is ever written into a project without you clicking.
- **The app will no longer save an art style that isn't there.** That is what had been silently happening to one of your channels: a style it could not find, no warning anywhere, and images generated without it for months. Saving one now fails with a clear message instead of succeeding quietly, and a project already in that state says so on screen.
- **A pack that fails to install no longer sits in a corner marked broken for ever.** Installing it successfully now clears the old failure, and failures leave a trace in the log instead of vanishing without one.
- One thing did change: **one channel's thumbnails** lose their separate charcoal-and-ink direction, which lived in a slot the new saved-style setting cannot reach. Its covers now follow its scene style. Picking a thumbnail recipe for that channel in Settings restores a deliberate look — the psychology one already installed is the closest match.

---

## v1.4.63 — 2026-08-25

- **The Content Store came back.** Adding font packs this morning broke it in two places at once, and this is the half that lives in the app. The app's screens were taught what a font pack is; the part that checks what the shop sends back was not. One unrecognised item does not get skipped — it collapses the whole list, so all 82 products disappeared, not just the six new ones. Your credits, your purchases and the 64 packs you own were never at risk; the store was simply frozen until both halves were fixed.
- The other half was on the server and needed no code: that process had been running since Sunday and had never heard of font packs either.

---

## v1.4.62 — 2026-08-25

- **Six font packs are on the shelf.** True Crime & Investigation, Horror & Dread, Documentary & Archive, Bold Explainer, Calm & Sleep, Retro & Arcade — six lettering styles each, three letterforms and three treatments per pack so any two can be combined. 300 credits a pack, 90% off until the end of the year. No font files are installed: each style carries the phrase the image model draws from, so the letters are part of the picture instead of a layer stuck on top.
- **Every style ships with its own swatch.** All thirty-six were rendered once, showing the same word, and travel inside the pack — so a pack style shows a picture the moment it is installed, with nothing to generate and nothing more to pay.
- **Three faults in the lettering work, each of which would have made those packs worthless.** A pack's swatches counted as unreferenced files, so no font pack could be built at all. The picker read only the built-in list, so an installed pack's styles never appeared in it. And when they did appear, the app ignored the swatch in the pack and asked an image model to draw a new one — charging you again for a picture you had already bought.
- Pack styles now show their real name in the picker instead of their internal id.

---

## v1.4.61 — 2026-08-25

- **"Reference-guided thumbnail" is collapsed by default.** It is an occasional tool and it sat wide open between the art style and the lettering, breaking the run you actually make every episode: style, then recipe, then what the words say and how they look. It is now a single line — "Use an existing thumbnail as a guide" — that opens when you want it.
- The closed line still says whether a reference is applied, so one set weeks ago cannot quietly shape every thumbnail with nothing on screen to show for it.

---

## v1.4.60 — 2026-08-25

- **"Thumbnail text" — the nine options for what the words actually say — was in a block you could not see.** Twice. It shipped in 1.4.56 near the top of the Thumbnail Prompts tab, in a group that does not render on the layout you use, so from your seat the feature did not exist. It now sits at the top of the Thumbnail lettering card, above the font, as the first of four decisions — because what the words say changes the picture more than how they look.
- If the options fail to load, the card says so instead of showing an empty box.

---

## v1.4.59 — 2026-08-25

- **Rendering a swatch failed with `400 Bad Request`, every time, and it was my mistake.** The Thumbnail Prompts page chooses a *language* model — it writes the prompts — and I passed that where an *image* model was needed. GenStudio quite rightly said DeepSeek is not in its image catalogue. A swatch is an app-level picture, not a per-project one, so the page no longer supplies a model at all: the server picks the **cheapest published image model** that can render 16:9, deterministically, so the choice is stable and never silently orphans swatches already rendered.
- **Each of the three lettering choices is now one line, with the grid in a popup**, like the Recipe Library and the Style Library. The chosen style shows as a small strip — its swatch, its name, the phrase it injects — and "Browse" opens the full grid. That holds at thirty-five styles and still holds at three hundred.
- "Let the model decide" is a swatch inside the grid rather than a radio button above it, so every option lives in one place.

---

## v1.4.58 — 2026-08-25

- **One card for the whole lettering decision, where you were already looking.** The swatches added in 1.4.55 went into a block higher up the Thumbnail Prompts tab, while the three dropdowns you actually use — Text style, Font, Title location — sat further down, unchanged. That was my mistake and it made the swatches invisible. Those three dropdowns are now a single "Thumbnail lettering" card, shaped like Channel art style: the font, the finish and the position together, with the swatches in place of the words.
- Each part says what it decides in plain terms — the font is "the shape of the letters", the text style is "the finish on the letters", the location is "where the words sit in the frame" — and each keeps a "Let the model decide" option. The duplicate randomise button below the card is gone; the card carries its own.

---

## v1.4.57 — 2026-08-25

- **A Content Pack can now ship thumbnail lettering styles, so a font pack is something you can sell.** Until now the font and treatment lists were hardcoded in the app, which meant a pack could not add a lettering style at all — there was nothing to put in a font pack whatever else was built around it. `lettering-style` joins the seven existing pack item kinds on exactly the principle the last three were added on: a look is a description the engine interprets, and the thumbnail prompt builder already turns a lettering phrase into an instruction for the image model.
- **A pack style must ship at least one rendered swatch.** A lettering style without a picture is a name, and a name is what a buyer cannot judge. The phrase itself is the product; everything else on the document exists to help somebody choose it.
- **A pack can never take an id a built-in already owns** — refused when the pack is built, and refused again when it is read, so a pack authored against an older build cannot shadow a style added since. Otherwise a buyer pays for a style that silently loses a lookup, or worse, changes what every existing thumbnail prompt means.
- No font files and no local typesetting: the image model draws the letters.

---

## v1.4.56 — 2026-08-25

- **You choose what the thumbnail says, in nine options instead of two.** Full episode title · two or three words · a curious question · one-line summary · this versus that · the cost or the warning · a number · a line from the episode · no text at all. Each says plainly what you get, and each carries an exact word budget — "curiosity hook" with no length was an invitation to write a sentence, which is how a whole title ended up in gold serif across a symbolic-split cover.
- **The recipe supplies a default; it no longer overrules you.** Before, the recipe decided and there was no way to say otherwise. Now an explicit choice wins, a recipe fills in when you have not chosen, and only when neither has said anything does the old behaviour apply — deliberately unchanged, because a recipe that never asked for a hook has not consented to one and every existing channel would otherwise have been silently rewritten. New work on the Thumbnail Prompts page starts on "two or three words".
- **Every invented headline comes back for review.** The words the model picked are returned in the title field, so you can read them before rendering rather than discovering them inside the picture. An invented headline may never fall back to the full episode title — that is the exact failure the mode exists to prevent, and it is stated in the instruction.

---

## v1.4.55 — 2026-08-25

- **You can now see what a font or a text style looks like, instead of reading its name.** "Neon", "blackletter gothic calligraphy", "retro 1970s chrome lettering" are only meaningful if you already know what they look like — which is the opposite of what a picker is for. Both the Text Style and Font Style choosers now show a grid of swatches: the same word, rendered once in every style, picked by eye.
- **One variable per swatch.** A font swatch changes the letterform and keeps the treatment plain; a text swatch changes the treatment and keeps the letterform plain. A swatch that changed both would show you a combination and teach you nothing about either. The word is the same in all of them for the same reason.
- **Rendered once, kept for ever.** Each swatch is one image, cached by content, and a style added later costs exactly one more — nothing already rendered is discarded or re-made. Every swatch uses the exact phrase the prompt builder really injects for that style, so it shows what will actually be asked for rather than a paraphrase.
- A "Show me" button renders whatever is still missing, one at a time, and if one fails the ones already rendered are kept. Styles that have no swatch yet say "not rendered yet" rather than showing an empty tile.
- Worth knowing: `script` and `handwritten` exist in **both** catalogues, so the two kinds are cached separately — otherwise the font swatch and the text swatch of the same name would share an entry and one would silently show the other.

---

## v1.4.54 — 2026-08-24

- **Thumbnail prompts were printing the episode code as the headline.** Every prompt for EP0344 came back reading `Large bold sans-serif text 'EP0344' is placed on the right` — five images with a filing code across them, and credits spent making them. One line was responsible: with no title on the request the generator fell back to the episode id, and the resolved title is exactly what gets drawn inside the image.
- **An episode's own title is now looked up when the request omits one**, from the same idea record that named its folder. If there is genuinely no title anywhere, the run refuses and says where to add one. Refusing is the cheap failure; five paid thumbnails reading "EP0344" is the expensive one.

---

## v1.4.53 — 2026-08-24

- **Idea campaigns were throwing away good ideas and then failing.** A thirteen-idea run on the Animals pack lost six of its first ten slots to "output drifted from assigned subject", kept refilling, and ended `12/13 required item(s) verified`. Nothing was wrong with the ideas. The check asked whether the subject's own words appeared in the title, and a Topic Pack subject is a category — "mammals", "big cats", "corvids" — while a good title names the animal. "Why the Naked Mole-Rat Never Gets Cancer" shares no word with "mammals", so it was discarded every time.
- **An idea now counts as on-brief if it matches either the subject or the specific thing it was told to be about.** Every assignment names an episode object — "a leopard hauling a kill up a tree" — and an idea that mentions the leopard has done exactly what was asked. Genuine drift is still caught: an idea sharing nothing but grammar with its assignment is still refused, because ordinary words are dropped before anything is compared.
- **Topic Packs now say where they came from and what they can actually do.** A pack bought from the Content Store and a built-in of the same name were two identical rows, so installing a fifty-subject Animals pack and then seeing "10 subjects" in Channel Identity was a mystery with no clue in it. Each pack is now badged Owned pack, Built-in or Custom, and the summary reads "50 subjects · 1,000 episode ideas" instead of "1 coverage axes", which told nobody anything.

---

## v1.4.52 — 2026-08-24

- **The Content Store had grown to sixty-five packs and read as one long pile.** Owned and Updates now group what you have by what it actually is — Series Formula, then Topic Pack, Visual Style, Thumbnail Recipe, and Channel Kits last. The order is fixed rather than alphabetical, so a section never moves about as your library grows, and a kind this build does not recognise still appears under "Other" rather than vanishing from a library you paid for.
- **"Install all missing" installs everything that is owned but not on this Mac**, in one click. A pack whose installed copy is an older version counts as missing, because the files on this Mac are not the release the account owns. Anything incompatible with this Story Studio is never queued — that would be queuing a guaranteed failure.
- **Installs are queued instead of refused.** Clicking Install used to disable every other Install button until that one returned; with sixty-five packs that is sixty-five deliberate waits. Clicks now go into a queue that works through them one at a time, each button saying whether it is Queued or Installing, and one failure no longer strands the rest of the batch. Installing still happens one at a time under the same coordination lock as before — what changed is that you no longer wait for it.
- **Filter by whether a pack is on this Mac** — All, Not installed, Installed — with a live count on each.
- **Buy several at once.** Tick the packs you want in Discover and the store walks you through their quotes in turn. GenStudio still quotes and charges one pack at a time and still asks you to confirm each one; what is gone is returning to the grid between every purchase. Anything that became owned between choosing and quoting is skipped rather than quoted twice.
- **A completed purchase no longer throws you onto another tab.** It used to jump to Owned every time, which made buying six packs six separate journeys.

---

## v1.4.51 — 2026-08-24

- **Opening a library was taking nine seconds, and it was about to get worse.** The Thumbnail Recipe Library showed a spinner for nine seconds to display twelve recipes — measured, three times, with no caching in between. The cost was never in the recipes. Every time the app listed anything from your content packs, it re-read and re-hashed all sixty-four installed pack versions — forty-four megabytes, the archive once and every unpacked file twice — and then did it again for the next list, and the next. At two hundred packs the same twelve recipes would have taken half a minute.
- **A pack version's contents cannot change without the app noticing, so it is now checked once and remembered.** The memory is keyed to the actual state of the files on disk — every path, its size, its timestamp and its permissions — so any edit, replacement or truncation misses the memory entirely and pays the full check, exactly as before. Nothing is written to disk and nothing survives a restart; startup still verifies everything from scratch. Since startup does that check anyway, the memory is already warm by the time you open anything.
- Three tests hold the line: the second check of untouched files does no work, a file edited after a successful check is still caught, and a file swapped for different content of exactly the same size is still caught.

---

## v1.4.50 — 2026-08-24

- **The four music packs you asked for are in: Sleep, Eastern Calm, Meditation and Calm Adventure.** Forty new worlds, ten to a pack, each with its own look, four scene variations so no two videos share a background, and the music styles it suits. Ninety worlds in total now.
- **Sleep** is the quiet end — a bedside lamp, a night train berth, embers in a snowbound cabin. **Eastern Calm** is mountain temples, ink-wash peaks, bamboo groves and tea houses, scored for guqin, guzheng and bamboo flute. **Meditation** is the spare one: salt flats, a raked sand garden, the centre of a frozen lake. **Calm Adventure** still moves — a coast road at sunrise, a ferry deck, a lighthouse path — without ever stopping being calm.
- The check that used to insist on exactly fifty worlds now checks the thing that actually matters: whole packs of ten, every register accounted for, and every world complete enough to shoot and to score. A count goes stale the first time you add a pack; the shape does not.

---

## v1.4.49 — 2026-08-24

- **Thumbnails no longer hold up your fleet.** Thumbnails and Scene Review shared one budget, so three thumbnail episodes — which run on a cloud model — consumed the whole allowance while your local machines sat waiting for a slot they were never going to take. They are separate lanes now: neither can starve the other.
- **Two numbers instead of one**, both in Settings. "Episodes making scene images at once" covers Scene Review and Image Pool — the work on your own machines. "Episodes making thumbnails at once" is its own dial, and raising it cannot slow your fleet down.
- The split is by the kind of job, not by which model you happened to pick, so the lane a job sits in is settled when it is queued and never changes underneath it.

---

## v1.4.48 — 2026-08-24

- **Opening a large channel re-read the same two files hundreds of times.** Listing a 302-episode channel went back to disk for `ideas.json` (275 KB) and `project.json` once *per episode*, several times over — roughly 68 MB of the same JSON parsed to answer one request, for two files that cannot change while that request is being answered. That is where the seven-second first load went.
- **They are now read once per request and shared.** Measured on a 302-episode project: the folder-resolving pass drops from **465 ms to 162 ms — 65% faster** — and that is only one of the several passes per episode that now share the same read. The saving on a genuinely cold load is larger.
- **Nothing about what the app concludes has changed.** Only the raw file contents are shared; every episode still finds its own title, its own folders, its own renamed-folder match. Tests prove a snapshot resolves byte-identical paths to a fresh read, that it never outlives the request that made it, that one made for a different project is ignored rather than believed, and that a failed read is retried instead of remembered.

---

## v1.4.47 — 2026-08-23

- **The "More" menu now closes when you click away from it**, and on Escape. It was built from the browser's own collapsible element, which by design only closes when you click the same button again — so it read as stuck. Both places that use it are fixed together, and a test keeps it that way.
- **The withdrawn iCloud sync is no longer described on screen.** "No script was found — if iCloud just delivered it" told you to wait for something that cannot happen: library linking and iCloud delivery were withdrawn, and one folder is chosen at first run. Six places said it; all now describe what actually happens, which is a file appearing on disk. The Settings page still mentions iCloud Drive where it means the folder you chose, which is true and useful.

---

## v1.4.46 — 2026-08-23

- **The update still would not install, and this is the actual reason.** 1.4.45 taught the app to accept your account-wide proof of ownership, and it got further — then failed with a generic "Failed to install". Underneath, the pack file was being quarantined as invalid: the final check still read your proof in the *purchase* shape, looking for a product block, a release block and a purchase-time component list. Your account-wide proof has none of those; it lists the current version of everything you own. So it verified the signature, found the wrong shape, and threw the file away.
- **The check now reads whichever kind of proof it was given**, decided by the proof itself rather than a flag beside it. The bar is unchanged: same signing key, same account, and it must name this exact pack, version, contents hash and byte count. A kit's four components bind the same way — to the versions you are entitled to today, which is the whole point of a free upgrade.
- **This is the third attempt at one bug, and the first two were called fixed while it was still broken.** Both were checked by reading the source rather than by installing anything, and neither could see a quarantined file behind a generic error. There is now a test that publishes a new version, offers it as an update and installs it — and it fails if any part of that chain breaks.

---

## v1.4.45 — 2026-08-23

- **"Install update" did nothing on all five kits, and it never could have.** The app demanded a purchase receipt naming the exact new version — but a free upgrade is never purchased, so no such receipt exists or ever will. Your original receipt is frozen at the version you bought, deliberately, because a receipt has to keep saying what it said on the day. Every free upgrade the store has ever offered was refused for this reason.
- **It now accepts the account-wide receipt GenStudio mints fresh on every check**, which exists precisely to say "this account, these packs, these current versions, right now". It is signed by the same key and was already being verified before this point — for an upgrade it is the stronger evidence, because it is current rather than historical. Every identifying detail is still matched exactly: pack, version, contents hash and byte count.
- **A kit's four components now bind to the version you are entitled to today** rather than the one pinned on the day you bought the kit, which is the whole point of a free upgrade.
- **The test fixture was hiding this.** It rebuilt every purchase receipt from the pack's *current* version, so a receipt quietly rewrote itself whenever a new version appeared — the exact situation the code had to handle was impossible to reach in a test. It now freezes at purchase, like the real thing.

---

## v1.4.44 — 2026-08-23

- **Every Content Store pack you own has been switched off since you installed them.** All 55 of them, since 16 August. They downloaded, they verified, they show as installed — but each one was missing the single marker that tells the app which version to actually use, and without it every formula, style and thumbnail template inside them was skipped. You have been running on the built-in ones the whole time and nothing said otherwise.
- **That is also why today's new packs looked like nothing had happened.** With no version marked as in use, the store reads a pack sitting verified on your disk as "not installed" — so the nine packs that got a new release today had nothing to compare against, and the Updates tab stayed at zero while telling you everything was current.
- **Nothing was ever going to fix it on its own.** The startup repair that exists for exactly this kind of damage began by skipping any pack with no version in use — the one case it needed to catch.
- **On first launch, the app now adopts the newest version of each affected pack** and reports what it adopted. It only adopts a version that fully passes the same verification a rollback uses, and it never touches a pack you have deliberately pinned, recalled, or removed. If nothing verifies, the pack stays switched off rather than being forced on.

- **The test suite was passing while a test was failing.** It printed the failure in full and then reported success, and two releases went out on top of that. It is now judged on what the run actually reported — no summary means an unfinished run, and an unfinished run is a failure — rather than on a number produced while the runner is already shutting down. Turning it on immediately found two more real problems, both below.
- **A folder anywhere above the one you scan could lend its name to your videos.** Archive Sweep looked for an episode code across the whole path, so a disk, user folder or sync cache whose name happens to contain letters-then-digits could attach that code to an unrelated video. It only ever caused a confusing "skipped" message — the channel check still refused to move anything it could not place — but the code was invented from somewhere you never pointed at. It now reads only the folders inside the one you chose.
- Two settings checks were still looking for the old spelling of the Settings panel after last night's rewrite. The settings themselves were fine; the checks were reading a stale copy.

---

## v1.4.43 — 2026-08-23

- **Repair no longer turns one broken episode into a search of the whole channel.** Every screen that offers Repair already knew exactly which episodes were broken — the failed-batch banner, the missing-assets report — and every one of them threw that list away and started a scan of all 302 episodes instead. They now hand the codes over, so Repair checks only what actually failed.
- **The one button that really does sweep the whole project now says so.** It reads "Scan all for repair", not "Repair assets" sitting next to per-job Repair buttons that fix one thing. Choosing the sweep should be a choice.
- **"Recover this episode" has stopped appearing where it could never work.** It was offered on Scene Plan, which produces text — Repair only recovers audio and picture files, so there was never anything for it to fetch. It was offered on Scene Review too, whose images Repair cannot even see. Both were exactly the rows you were looking at, and both sent you to a full-library scan that could not have helped either one.
- **Retry on a Scene Review job was described as the expensive option. It is the cheap one.** It first pulls back every image the provider already made and charged you for, at no cost, using the record kept for each one, and only re-submits scenes with nothing to recover. The tooltip said the opposite — "re-runs the whole step, no repair path" — so the free fix looked like the costly one.
- The repair list also stopped offering two job types that were deleted with the retired scene-image generator.

---

## v1.4.42 — 2026-08-23

- **Saving the throughput settings told you nothing.** It also threw away the server's reply, so a number the server adjusted to fit a limit still showed as what you typed — you'd have walked away believing a value that wasn't real. It now reports what is actually in effect.
- **Every throughput setting is a dropdown with the reasoning in it**, instead of a box you had to guess at. "Auto" was a magic word you could only use if someone told you it existed.
- Each option says why: which number is recommended, which one overwhelmed the fleet last week, which one GenStudio itself accepts. Custom is still there on every field, and there's a "Use recommended" button to put everything back.

---

## v1.4.41 — 2026-08-23

- **Both throughput numbers are now yours, in Settings.** "Episodes making images at once" (3) and "Images per episode at once" (auto — follows what your account can actually run, and rises by itself as you add machines).
- **The first attempt at this missed Scene Review**, which is the only image generator you still use. It would have shipped, you'd have installed it, and your batch would still have run one episode at a time. Now every kind of fleet work is pipelined — images, video and narration each with their own allowance, so a big picture batch cannot block a voice job queued behind it.
- **The retired scene-image generator is gone, root and stem.** Four job types, one whole generator file, its executor registrations, queue lanes, cancellation auditors and retry-policy entries. The front door had returned "this is retired, use Scene Review" for a long time; the machinery behind it was still wired up and still looked alive.
- Your three image generators are untouched and confirmed working: Scene Review, the thumbnail generator, and image pool generation.

---

## v1.4.40 — 2026-08-23

- **The other half of the idle-fleet problem.** One episode of 108 images was running exactly 50 of them — because 50 was written into the code. Your account's published limit is 128, and GenStudio had **nothing** queued. Nothing was full, nothing was throttling, nothing was waiting. The app just never offered more work.
- **It now asks how much you can run instead of guessing.** GenStudio already publishes your real ceiling, so a 108-image episode now goes out as 108. This is safe because GenStudio decides what actually starts — the app can't flood it, only under-feed it, which is exactly what it was doing.
- **When your fleet grows, this grows with it.** Your ceiling rises as you add machines, and the app follows. Nothing to set and nothing to remember.
- If your account ever publishes no ceiling, it falls back to the old 50 — unknown stays cautious rather than unlimited.

---

## v1.4.39 — 2026-08-23

- **Your machines were mostly idle and nothing said so.** With 50 Scene Review jobs queued, 51 of your 74 online fleet workers had nothing to do — and a location connected that morning had one busy worker out of twenty.
- **Neither the fleet nor GenStudio was the limit.** Your account can run 128 jobs at once; 25 were running. Story Studio was doing the episodes **one at a time**, because image work only ever had a single slot. Fifty queued episodes were strictly serial, no matter how many machines you owned.
- **"Episodes making images at once" is now a setting, defaulting to 3.** Scene Review, Images, Thumbnails and Image Pool share it. One left your fleet idle; thirty is the flood that lost a third of a transcription run last week. Three is busy with headroom — and since your fleet grows most weeks, the number is yours to raise.
- This is the third lane with the same story, and the first found by measuring rather than by something breaking.

---

## v1.4.38 — 2026-08-23

- **Music channels.** A new "Music Mix" format and a Music Library page: buy songs once, then build as many long-form music videos from them as you like. Building a video never costs anything.
- **Your library is a shelf, not a shopping list.** One request to the music model returns two complete songs for one charge, and both are kept. About ten requests buys an hour of music, so a two-hundred-song library costs roughly six dollars once — and after that the fiftieth video costs exactly what the second did: nothing.
- **The page is organised around what spends money.** Exactly one section is marked "costs credits" and tells you how many songs you're ordering. Preview and Build are marked free, and Preview shows you the whole tracklist and runtime before you commit to anything.
- **It never quietly buys or quietly shortens.** If your library is too short for the length you asked for, it says by how much and stops — it will not top itself up mid-build.
- **Two songs from one request are kept apart in a mix.** They come from the same instruction, so they sound like cousins; back to back a listener hears one song looping.
- **Fifty worlds to choose from, and they're data.** Add one, edit a scene, change the music styles — no code change needed. A two-hour video loops one still image, so it takes minutes to make rather than hours.

---

## v1.4.37 — 2026-08-23

- **Scene Plan now refuses a model that cannot return structured data, before it spends anything.** Four batches failed today on a DeepSeek model that publishes no structured-output support. Your system can only *ask* such a model for JSON and reject what comes back — so it answered properly for two chunks of forty scenes and wrote prose for the third. Two episodes stopped at exactly 80 of 111 and 80 of 113. That was never a size limit; it was where the luck ran out.
- **The app genuinely could not see the problem.** Its catalogue reader had only two settings for "can this model return structured data", and "no" wasn't one of them — anything that wasn't the strictest setting was filed as "yes". So a model that cannot was recorded as one that can, and GenStudio's own correct diagnosis had nowhere to go.
- **The refusal names which model you picked** — there are two with nearly the same name and only one of them works — tells you what to switch to, and says plainly that nothing was charged.
- It refuses rather than warns on purpose. A model that works *some* of the time is worse than one that never does: you get half-finished episodes that look like a glitch instead of a wrong setting.

---

## v1.4.36 — 2026-08-23

- **An outline that comes back LONGER than asked for is now kept, not thrown away.** EP0056 asked for 10 chapters, the model wrote 11, and the whole thing was binned — after GenStudio had already done the work and charged for it, with no automatic retry. You paid for an outline that contained everything you wanted plus a bonus chapter, and got nothing.
- **A longer episode is more runtime, so extra chapters are the point, not a defect.** The extra chapters now flow all the way through: expansion, the completion checks, the outline editor and the cleanup sweep all follow what the outline actually produced instead of what was requested.
- **It can still never come back SHORT.** That rejection stays exactly as it was, and for a good reason: a short outline gets quietly padded with empty chapters that turn into waffle nobody notices. Long is an opportunity; short is a hole.
- **The limit is yours, in Settings.** "Extra chapters allowed" defaults to 2 — up to double the target. It exists only to stop a garbled answer turning into hundreds of paid chapters, not to police quality. Set it to 1 if you ever want the exact number.

---

## v1.4.35 — 2026-08-23

- **The Pause button now actually pauses.** It did not, in four places. On image batches it stopped nothing at all — the app carried on buying every remaining scene and thumbnail to the end of the run. On subtitles a Pause pressed during a wait was ignored for up to five minutes. Contextual Cues and Image Pool had the same gap.
- **And a paused job now says "paused", not "failed".** This is the part that mattered. Once the app genuinely stops early, the pictures you chose not to buy are missing from disk — and its own final check treats missing files as a failure. So a working Pause would have punished you for pressing it. It now settles as paused, keeps everything already bought, and Resume buys only what is genuinely still missing.
- **One refused clip no longer ends an episode's whole motion pass.** "Make every scene move" had no safety net around each scene, so a failure on scene 3 of 50 threw away the other 47 — never attempted, never reported. Each scene is now handled on its own and the run continues, naming what failed. Cancel, Pause, and running out of credits still stop everything, because carrying on would be wrong for each.
- **Motion batches stop discarding their own crash-recovery notes.** They were being overwritten at the end of every run. It never cost money — the retry identity is read from disk — but recovery after a crash was working from nothing.

---

## v1.4.34 — 2026-08-23

- **Image Pool now waits when your machines are busy. That is all eight generators — the whole set is protected.**
- **This last one was the easiest to lose work in without noticing.** A pool has no script and no scene list to check against, so asking for 40 images and quietly getting 31 has nothing to contradict it. It now waits 30 seconds, then 2 minutes, then 5, and says plainly that nothing was charged.
- **Nothing else about the run changed.** An image that runs out of waits fails exactly as before and the rest of the pool carries on. Running out of credits still stops everything immediately, with no waiting.
- Behind the scenes, the checklist that tracked which generators still had this fault is now closed. In its place is a stricter rule: any new generator that talks to your machines must handle this from the day it is written, or the tests fail.

---

## v1.4.33 — 2026-08-23

- **Contextual Cues now waits when your machines are busy** instead of throwing away the episode's whole batch of proposed labels. Seven of eight generators protected; one left.
- **This one already knew how to wait — for a different problem.** It had a 15-second retry for the provider being briefly overloaded. A busy fleet is not that: GenStudio has already spent fifteen minutes looking for a free machine before it gives up, so a 15-second retry just rejoins the same queue. The two now have separate waits and separate budgets, and the old one behaves exactly as it did before.
- Cancel and Pause are honoured within seconds during a wait, and every wait says plainly that nothing was charged.

---

## v1.4.32 — 2026-08-23

- **"Retry all" is here, next to "Repair all".** Two buttons you press yourself. It never repairs for you and it never retries what it cannot vouch for.
- **What it will and will not re-run.** Anything with no repair option (most job types, subtitles included) is retried straight away — a repair could never have helped it. Anything you repaired that still came up short is retried, because the shortfall is proven. Anything you never repaired, or whose repair failed, is **left alone and listed**, because your machines may already have finished it and you would pay a second time. That is the exact trap that got a combined button removed once before.
- **A number the app knew and never told you.** Repairing pictures reports how many are still missing, and the Jobs page had been dropping it — you saw a plain "repaired" tick whether four were missing or none. It now shows the real count, which is also what makes Retry all able to tell "proved missing" from "never checked".
- Everything goes through the normal queue, so a big Retry all is paced rather than fired all at once.

---

## v1.4.31 — 2026-08-23

- **Motion Review now waits when your machines are busy** instead of throwing the clip away. Six of eight generators protected.
- **This one was the worst of the set.** The "make every scene move" run had no safety net around each scene, so a single busy moment on scene 3 of 50 killed the whole episode's motion pass — not one clip, all of them. Now it waits 30 seconds, then 2 minutes, then 5, and says in plain words that nothing was charged.
- **Video is the most expensive thing the app buys**, so it still refuses to re-ask about anything except the one failure that provably cost nothing. Cancel and Pause are honoured within seconds during a wait, not at the end of it.

---

## v1.4.30 — 2026-08-23

- **Scene Images now waits when your machines are busy** instead of dropping the picture and asking you to run it again. Five of eight generators protected.
- **It also closed a fault that was harmless until today.** Two copies of the same internal record disagreed slightly — and nothing read the second one, so it never mattered. Adding a retry makes something read it, and the app would then have asked for the same picture under two different names. That is exactly how you end up paying twice for one image. It was found and fixed rather than built on top of.
- **Two things noted, not changed.** A waiting scene here does not show "waiting" the way Scene Review now does — it shows a log line and a percentage that stops moving, which could read as a hang. And pressing Pause mid-picture still does not take effect, only during the new waiting. Both change behaviour for every scene, so neither belongs in a retry fix.

---

## v1.4.29 — 2026-08-22

- **Your publishing cadence was saving but never loading. Fixed.** The panel wrote your days, time and the auto-schedule tick correctly — and then showed you an empty form every time you opened it, because the app was only allowed to hand back a fixed list of settings and these two were not on it. Worse than merely annoying: if you had pressed Save on that blank form for any reason, it would have wiped your real cadence and quietly switched automatic scheduling off. You can now see what is actually set.
- **Scene Review waits when your machines are busy** instead of throwing the picture away and asking you to run it again. Same as subtitles, voice and images. Three tries — 30 seconds, 2 minutes, 5 minutes — and the log says plainly that nothing was charged.
- **A safety feature would have cancelled that fix, and nearly did.** The app pauses a job when nothing finishes for ten minutes. A full render farm is exactly what causes nothing to finish — so it would have paused the job and killed the waiting. The pause is now held off only for as long as a scene is genuinely waiting, and never longer.
- **A waiting scene now says so.** While it waits you see "waiting, retry at…" rather than a spinner that looks like a hang.
- Four of eight generators protected — subtitles, voice, images and Scene Review. The remaining four are still named in the app's own tests.

---

## v1.4.28 — 2026-08-22

- **The two throughput numbers now have a screen. Until now they had none.** Settings → This Mac → *How much runs at once*. You asked where to change them and the honest answer was nowhere: both had been moved out of the program's code into a settings file the app reads when it starts, with no page and no way to reach them. That is half a fix — a number you cannot get to is barely better than one written into the code.
- **Two boxes.** *Episodes transcribing at once* (2) — each episode still transcribes all its chapters together, this is how many episodes start together. *Writing jobs at once* (8) — ideas, outlines, chapters, metadata, image prompts and scene plans share this one. Both show their standard value and accept 1 to 50.
- **Saving takes effect immediately, not at the next restart.** The queue is updated as well as the file. A setting that quietly does nothing until you restart is one you stop trusting.
- **They live on This Mac rather than on a channel** because they describe what this machine's fleet can absorb, not anything about a particular show.

---

## v1.4.27 — 2026-08-22

- **Writing jobs now run 8 at a time instead of 50.** Ideas, outlines, chapters, metadata, image prompts and scene plans all shared one queue that allowed fifty at once. When a lot were started together they waited a **median of 15 minutes**, and sometimes twenty. Eight is the number: your chat work has already run eight at once successfully, GenStudio itself only accepts twelve so anything above that just hides the queue rather than shortening it, and fifty is what produced the long waits.
- **It is a setting.** Raise it as you add machines.
- **This was the last unlimited queue.** Every other kind of job already ran one at a time; writing and subtitles were the only two that could stampede, and both are now bounded.
- **The thing you were worried about was never happening.** A slow generator does not block a fast one — each kind of work has its own queue. Over one week, image generation and transcription were running at the same moment **15,257 times**, image and voice 6,038, chat and image 5,301. Scene Review being slow only ever slows Scene Review. Nothing needed building; it is now locked in by a test so it cannot quietly stop being true.
- **One trade worth knowing.** Those six kinds of writing share a single queue. At fifty that never mattered; at eight, a burst of slow scene plans can delay quick metadata. If that ever bites, the answer is a separate limit for each kind — never a bigger shared number, which would only bring the long waits back. That instruction is written into the code.

---

## v1.4.26 — 2026-08-22

- **Image generation now waits when your machines are busy, instead of throwing the picture away.** This is the biggest one of the set: image generation is the busiest thing the app does — 7,419 jobs on your fleet in the last 30 days, five times more than the transcription that failed on you today. It had simply never met a burst. It would have.
- **It reuses the waiting that was already there.** Images already knew how to wait when no picture provider would take the work; it just didn't recognise "your own machines are full" as the same kind of problem. Two separate waiting schedules are kept apart on purpose, so changing one can never break the other.
- **A crash mid-wait cannot buy you a second picture.** Each retry is labelled from what already happened rather than made up fresh, so if the app dies while waiting, the next run asks for the same picture again instead of paying for another one.
- **Found and deliberately not fixed:** pausing does not really work anywhere in the image generator — it only ever checks for cancel. Pause now works inside the new waiting, but making it work across a whole image batch is a separate change with its own consequences, so it was left alone and written down rather than slipped in.
- Three of eight generators now protected — subtitles, voice and images. The remaining five are still named in the app's own tests so they cannot be quietly forgotten.

---

## v1.4.25 — 2026-08-22

- **You asked what else has this bug. Here is the honest answer: eight generators could lose work when your machines are busy, and until yesterday none of them handled it.** Subtitles was fixed yesterday because you happened to run thirty episodes at once and saw it. Audio is fixed today. Six remain, and they are now written down by name inside the app's own tests rather than left as something I might remember.
- **It had already happened to your voice generation and nobody noticed.** Five voice jobs were refused for a busy fleet on 13–15 August and their sections were silently dropped. That is the shape of this whole problem: the only symptom is a missing piece that a later retry quietly fills in, so it looks like ordinary flakiness and never gets looked at.
- **Voice generation now waits and asks again**, using the retry machinery it already had for a different kind of busy — a provider declining, which it has handled since 7 August. The gap was that a provider saying no and your own fleet being full are different things, and only the first was covered.
- **The remaining six are tracked, not forgotten.** Scene Review, Motion Review, Images, Scene Images, Contextual Cues and Image Pool. A test names them, and a new generator that handles these failures without either fixing or declaring the gap will fail the build. The question "what about the others?" can no longer go quietly stale.
- **Nothing here retries anything that might have cost you money.** Only the two codes that mean GenStudio never gave the job to a machine, where the whole reservation is returned. If a job ever reports that while still having taken credits, it stops rather than resubmits.

---

## v1.4.24 — 2026-08-22

- **A chapter turned away because every machine was busy now waits and asks again.** This is the other half of yesterday's flood: of 353 transcriptions, 122 were refused for want of a free machine and simply dropped, leaving you to chase each one by hand. They now wait and retry — three times, after 30 seconds, 2 minutes and 5 minutes.
- **It is free to retry, and that is the only reason it happens automatically.** GenStudio refuses these before any machine has touched the job, and gives the whole reservation back — its own words are *"the job never reached a worker, so there is nothing to settle."* So trying again is a fresh charge for work that never happened, never a second charge for the same work.
- **It checks the money, not just the reason.** If a job somehow came back saying "no machine free" while still having taken credits, it is not retried — because that would mean a provider had been paid and might have done the work. When something stops matching what it promised, the right move is to stop, not to try again.
- **Only a busy fleet is retried.** A genuine fault — unreadable audio, a provider refusing the request — is reported straight away as before. Retrying those would turn a clear error into ten minutes of silence followed by the same clear error.
- **Cancelling still means cancelling.** A chapter you cancel is never resubmitted.
- **The waits are minutes, not seconds, on purpose.** GenStudio already waits a full fifteen minutes for a free machine before giving up, so anything reaching this point means the fleet is genuinely full. Retrying two seconds later would just rejoin the same queue.

---

## v1.4.23 — 2026-08-22

- **Thirty episodes at once flooded your own fleet, and a third of the work was refused.** You started thirty transcriptions together and watched many fail. Checking GenStudio afterwards: **231 transcriptions succeeded and 122 were refused** because no machine was free, with 103 running at the peak. Every job started in the same second and the refusals landed in a three-minute window as the fleet filled up.
- **You were right about the fix and the cause was the other way round.** The chapters inside an episode were *already* running side by side, ten at a time — that is what makes a single episode fast, and it is exactly what you asked for. What was unlimited was **episodes**: the queue let fifty start at once, so thirty episodes of about eleven chapters each arrived as one wave of roughly 350 requests.
- **Episodes now queue; chapters still run side by side.** Two episodes at a time by default, each still transcribing all its chapters simultaneously. That is about twenty requests in flight instead of a hundred — and a single episode takes exactly as long as it did before, because the part that decides that has not changed.
- **The number is yours.** It sits in your app settings and can go from 1 to 50. If your fleet grows, raise it.
- **The switch existed all along and nothing could reach it.** The queue has had a setting for this since it was written, and no part of the app outside a test ever called it — so it sat at fifty, unreachable. It is now read when Story Studio starts.
- **Still to do, and it would have saved most of those 122:** when a chapter is refused because every machine is busy, it is given up on rather than waited for and retried. That is a separate change to the part that handles billing, so it is not in this release.

---

## v1.4.22 — 2026-08-22

- **The caption check was showing you an old answer, and that nearly cost you an hour.** You opened it on EP0051, saw captions that did not match the narration underneath them, and were about to re-transcribe. Your transcript was fine. What you were looking at was a check that had run before your last re-stitch — the subtitle files were rewritten at 14:23 and 14:32, after the run whose results were still on screen. Running it fresh gave captions matching the file exactly.
- **It now knows when the file has moved on.** Each check records which version of the subtitle file it looked at. Come back to the page after re-stitching and it greys the frames out, says plainly that they describe an older version, and offers to run again — instead of quietly looking authoritative.
- **A confirmation given on stale evidence is withdrawn.** If you had already ticked "these are right", that tick is undone when the file changes, so a render can never be waved through on a check that no longer applies.
- **The frames themselves were never wrong.** Nothing was miscounting or mistimed — the check simply had no way to know which version of your subtitles it had read, so it kept answering a question about a file that no longer existed in that form. That gap had been there since the caption check first shipped; adding the audio clips is what finally made it visible.

---

## v1.4.21 — 2026-08-22

- **Your upload scheduling now has tests. Nothing was wrong with it.** You said it plainly — *"i've schedules and upload for a while. no issues whatsoever"* — and that matches what I found. The code was correct; it simply had nothing protecting it. Every failure I hit while writing these tests was my own test setup, never your scheduling.
- **What is now locked down** is the part that decides where your next episode lands: a video that already went live never pushes new episodes further out, the newest booked date is the one that counts, an episode being rescheduled is not pushed past its own date, and a video that is already public on YouTube is never given a new publish time. That last one is your rule, and it is now impossible to lose quietly.
- **One awkward date format is pinned too.** YouTube sometimes returns times without fractions of a second, and an older version compared them as plain text and missed them — which could book two videos into the same slot. That is now checked.
- **The duplicate I warned you about is gone.** Last night's scheduling shared its calendar maths but kept its own copy of one small piece, because touching untested code that sets your real publish dates was the greater risk. With tests in place that risk is gone, so the three copies — preview, apply, and automatic scheduling — are now one.
- **The reminder I left myself worked.** I had added a test that would deliberately fail the moment anyone covered that route, telling whoever saw it to remove the duplicate rather than let a temporary shortcut become permanent. It fired today, named the file that changed the situation, and has been retired along with the duplication it was watching.

---

## v1.4.20 — 2026-08-22

- **A finished episode can now take its own publish slot.** Turn on *Give each episode a publish time as soon as it finishes rendering* in Channel Identity and every render lands in your schedule by itself — no picking it out of the upload list, no pressing apply. **Nothing is sent to YouTube.** The episode gets its date and waits; you still press upload, which is what you asked for.
- **Your publishing rhythm now belongs to the channel, not to Upload Center.** Set the days, the time and the interval in Channel Identity, and it tells you how many episodes a month that works out to. An upload plan can only exist once a YouTube account is connected — one of your channels existed for months before its account did — so the rhythm lives on the channel and becomes the plan the moment you connect.
- **Your existing channels are untouched.** All eleven already have plans, and a plan always wins: the cadence screen says so plainly and points you to Upload Center. Re-authorising an expired token will never reset a schedule you have tuned.
- **Nothing that is already live gets moved.** An episode that is public on YouTube, or that already has a publish time, is left exactly as it is. That was your condition, and it was already the rule the manual apply followed since v1.0.46.
- **One thing I checked and did not change:** your schedule never needed its start date bumped. It already walks past the last slot you claimed, so each new episode lands after the previous one automatically.
- **On the duplicated logic.** The scheduling code shares all the calendar maths with the manual apply, but copies one small piece — the scan that finds the last claimed slot. That is deliberate: the apply route you rely on has no tests at all, so refactoring it would risk your real upload dates with nothing to catch a mistake. Instead there is a test that fails, naming the difference, if the two copies ever stop agreeing — and another that fails the day somebody adds tests to that route, so the shortcut gets revisited instead of outliving its reason.

---

## v1.4.19 — 2026-08-22

- **One-click renders were quietly dropping three of your settings.** You remembered this and you were right. A render started from the Pipeline used a hand-written copy of what the Video Assembly page sends, and three things had never been added to that copy — so the same episode rendered two different ways depending on which button you pressed, with nothing said either way.
- **Scene effects were being lost entirely.** Every per-scene effect you picked was saved in your preset and thrown away by a one-click render. This has been true since scene effects shipped.
- **Aspect ratio was ignored, so a one-click Short was impossible.** Batch renders were always widescreen no matter what the channel asked for — the vertical support added a few days ago never reached the Pipeline at all.
- **"Hide captions during the intro" was ignored**, so a one-click render burned captions over your branded opening even when you had turned that off.
- **One thing I checked and left alone:** the scene-pool setting also isn't copied across, but the renderer sets it itself, so it changes nothing. Not padding the list with it.
- **The real fix is that this cannot happen again quietly.** There is now a test that reads the page's own code, works out every setting it can send, and fails if the Pipeline can't send the same one — naming the missing setting. This is the fourth time a setting has gone missing this way; it is the first time anything would have noticed.

---

## v1.4.18 — 2026-08-22

- **You can now change a channel's episode shape yourself.** Project Settings → Channel Identity → Project formula has an **Episode shape** panel: usual length and the shortest and longest allowed, usual chapter count and its range, reading pace, whether chapters stand alone, and the title voice. You set these numbers on 21 formulas yesterday and had no way to change them afterwards without editing files. Your words: *"series formula editing ui. do it please then, i thought you already did it."* Fair — I said 1.4.16 would wire it and it did not.
- **It shows you what the numbers mean before you save.** Change the length or the pace and it tells you roughly how many words that is per episode and per chapter, so a "45-minute episode at 155 words a minute" is a real amount of writing rather than two abstract numbers.
- **A built-in formula is never overwritten.** The first change makes that channel its own copy, and every other channel using the same formula is untouched. The panel says so before you save, and the confirmation says which happened.
- **Numbers that contradict each other are refused, with a reason.** A usual length of 90 minutes inside a 40–50 range is rejected rather than quietly clamped — that exact shape, a default sitting outside its own range, is what made a two-hour sleep story impossible to request before yesterday.
- **This was the part that could have gone badly.** The existing "save formula" path checks documents against a description that has never included chapters, length, pace, narrator voices, title rules or the chapter-by-chapter plan. Saving a real formula through it would have thrown all of those away — editing Sleep Stories would have deleted its ten narrator voices. The new editor changes only the fields you touched and carries everything else across untouched, and there is now a test that edits the Hidden Mechanics formula and checks its nine named chapters and ten voices are still there afterwards.

---

## v1.4.17 — 2026-08-22

- **The caption check now lets you hear the narration, not just read it.** Each of the three frames has a player under it holding exactly the words on that frame, cut from the narration the render will use. You said it plainly: *"this subtitle render is a good idea but there's nothing for me to hear so I can compare it at all."* You were right, and it undercut the whole point — reading a caption proves the words exist, it cannot prove they are the words being spoken there. The fault this check was built to catch was one episode's captions burned onto another, and both episodes' captions read perfectly well on their own.
- **The clip covers the caption, start to finish**, with three-quarters of a second either side so it does not sound chopped. A very short caption still gets two seconds so you can recognise it; a very long one is capped at twenty so a check never becomes a download.
- **A clip that cannot be cut says so instead of pretending.** ffmpeg does not fail when asked for audio past the end of a file — it writes an empty one and reports success. A valid clip is about 67 kB; that empty one is 358 bytes. Anything that small is thrown away and the frame says "no narration to play", because a silent player looks like missing narration rather than a clip that was never made.
- Frames written automatically beside a finished video are unchanged and still silent — those are a record of what was rendered, not something to listen to, and cutting clips for them would add time to every render for nobody.

---

## v1.4.16 — 2026-08-21

- **Every one of your 21 channels now has its own runtime, chapter count and speaking pace.** Until today only two of them did. The other nineteen fell through to one shared setting — five chapters, eight minutes, 160 words a minute — and, more importantly, to a shared **maximum of twenty minutes**. A sleep story is now 135 minutes by default and may run to 150; a prayer is 18; Hidden Mechanics is 45; the nature channels and the explainers sit around 25. The numbers are yours: you gave them on 2026-08-21 and they are written in each channel's own file, not in the program.
- **Speaking pace now follows delivery instead of one number for everybody.** 160 words a minute is a news-reading pace and suited almost none of your channels. Sleep and mindfulness now sit at 115, prayer at 120, preaching and philosophy at 145, the history and nature channels at 150–155, business at 160, the listicle voice at 165 and hustle at 170. Slower channels get more words on the page for the same runtime, faster ones fewer, so a "25-minute episode" is actually 25 minutes on each of them.
- **Thirteen channels were being told to write sleep-story titles.** Prayer, preaching, psychology, philosophy, devotional, mindfulness, motivation, history narration, the POV channel and all four nature channels had no title voice of their own, so the program fell back to a line written into the code: *"Hook-y, curiosity-driven, calm/dreamlike tone."* A fix in v1.0.69 was meant to prevent exactly this, but it only worked for channels that stated their own voice, and these thirteen did not. All 21 now do, in their own words.
- **That tone is no longer written into the program.** It is a setting on the channel and on the format, so you can change it without anybody touching code. What remains in the program is a deliberately plain last-resort line for a channel you add later and have not given a voice yet.
- **Hidden Mechanics keeps its nine parts.** Its runtime moved from 36 to 45 minutes as you asked, but the nine chapters are a named sequence — from "The familiar story" to "The changed world" — so the extra time became longer chapters rather than more of them.
- **Deep Time was left exactly as it was**, at 150 minutes and 120 words a minute. It already had considered settings, and cutting it would have halved your longest format on the strength of a bad reading on my part.
- **Your eleven sellable content packs carry the same numbers.** They are copies of these same channels, and they had no runtime at all before today, so anybody who bought one got the twenty-minute cap. Say the word if you would rather a pack differ from your own channel.

---

## v1.4.15 — 2026-08-21

- **You can now choose the shape of a video, not just its size.** Video Assembly has a new Aspect Ratio box beside Resolution, offering widescreen 16:9, vertical 9:16 for Shorts and Reels, square 1:1, 4:5 for Instagram and 21:9 ultrawide. Until today every video Story Studio assembled on this Mac was widescreen and there was no way to make a vertical one, even though the picture side has offered vertical for a long time — so a channel could generate tall pictures and then get them squeezed into a wide frame with black bars down both sides, with nothing said about it.
- **Each channel proposes its own shape.** A channel's format already states which shape its pictures should be, and the render now starts from that answer rather than assuming widescreen. You can still change it for any single render, and a saved export preset still wins, exactly as with every other setting on that page. If the format asks for something the box does not list, that shape is added to the box for you.
- **Nothing about the shape is fixed in the program.** The renderer works out the frame from the shape and the resolution rather than looking up a list of allowed sizes, so a shape nobody has asked for yet already works. "1080p" now means the narrow side of the picture is 1080 pixels — 1920×1080 lying down, 1080×1920 standing up — and every widescreen video comes out at exactly the size it always did.
- **Everything drawn on top follows the frame.** Title cards, chapter titles and the small on-screen labels used to be sized against the height of the picture, which is the same thing as the width on a wide video and quite wrong on a tall one — a title would have come out nearly twice too big and run off both sides. They are now sized against the narrow side instead, which changes nothing for widescreen and makes vertical correct.
- **A gap in the title card that was already wrong is fixed too.** The space between a title and its subtitle was a fixed 40 pixels, decided when everything was 1080p. On a 4K video the lettering tripled in size and the gap did not, so the two lines nearly touched. The gap now grows with the lettering.
- **Story Studio tells you before it renders if your pictures are the wrong shape.** Run the caption check and it now says, in plain words, that your scene images are (for example) 16:9 while the render is 9:16, and that they will end up inside large black bars. The same warning appears in the render's own log. It warns rather than refusing, because sometimes bars are exactly what you want — but you find out first rather than by watching the finished video.
- **The caption check now draws its three frames at the real shape**, and fits the picture into them the way the render actually does. It used to fill the frame by cropping, which happened to look identical while everything was widescreen and would have hidden the black bars completely on a vertical render — the one thing worth previewing.
- **The effect, motion, transition and caption-style previews follow the shape too.** A corner logo, a lower third or a caption previewed in a wide box tells you nothing about where it lands in a tall video.
- **Cinematic bars step aside on a tall video and say so.** The 2.35:1 letterbox effect is a widescreen idea; applied to a vertical frame the arithmetic still works and covers three-quarters of the picture in black. It is now skipped, with a line in the log explaining why, instead of quietly ruining the render.
- Also fixed two things found on the way: burned-in captions in the fallback path were told the video was always 1920×1080, which would have skewed them on any other shape; and two different requests inside Story Studio shared one name, so the program had been quietly treating them as a single thing for some time. They are two names now.

---

## v1.4.14 — 2026-08-21

- **Chased down a test failure that turned out not to be Story Studio's fault at all.** One test failed roughly once in every two hundred runs, and the way it failed looked alarming: it read as if the episode list had briefly forgotten an episode that had just been created. On this app that would be the channel list dropping one of your episodes, so it was worth being sure. It was not that. The test's temporary web server was leaving one door unlocked, and now and then another program on the same Mac — Tailscale — quietly took over the same door number and answered the test's questions in Story Studio's place, always with "not allowed". Nothing reached Story Studio, and nothing in the episode list was ever wrong.
- **The door is now locked to the exact address the test knocks on**, so no other program can take it over — proved by watching a stand-in try and be refused. This covers every backend test, and a new test raises the alarm if the protection is ever dropped.
- **The two tests that failed this way now say what actually went wrong.** They used to fall over three lines later on an unrelated-looking symptom, which is what made a five-minute question into a long one.
- Nothing in the app itself changed.

---

## v1.4.13 — 2026-08-20

- **Six messages sent you to tabs that no longer exist.** Four told you to fix an API key in "Settings → API Keys", a tab that was folded into "This Mac" some time ago; they now say This Mac. The wizard that builds a format from a sample said to switch projects to it from "Project Settings → Format", which folded into Channel Identity. And the Image Pool page called the next step the "🎞 Scenes" tab in four places, while the app's own navigation calls it Video Assembly — the icon was right and the word was wrong, which reads as precise and is not.
- **Three more credit figures now say "credits".** The Jobs page tooltip said "Balance after: 4,250", the Credits page's own jobs table had columns headed just Reserved, Settled and Returned, and the motion clip picker read "45 credits (minimum 30, price v3)" — where "v3" is a price-list version sitting immediately after the word "price", in a picker you use while spending money. It now reads "minimum 30 credits, price list v3".
- **A failed load no longer strands you on a form you cannot finish.** If the Series Formula, Production Path or Topic Pack list failed to load — a momentary blip is enough — you got an error and nothing else, and the only way forward was to leave the page and come back. Each now has a "Try again" button that reloads just that list where you are.
- **A long Library path no longer pushes the welcome screen sideways.** A path with no spaces in it could not wrap, so in a narrow window the whole first screen scrolled left and right — on the one screen you have to complete on a new Mac. Fixed there and on the Audio Assembly page's source-folder line, which has the same shape.
- Also removed a leftover key-entry component that nothing had used since the API Keys tab was retired.

---

## v1.4.12 — 2026-08-20

- **Story Studio no longer puts emoji into the text it writes for you.** Titles, descriptions, tags, the episode ideas it generates, playlist descriptions and the labels burned onto the screen all come out as plain text now. A title that used to arrive as "🔥 The Forgotten Helots of Sparta — What the Temple Dig Really Found 🏛️" arrives as "The Forgotten Helots of Sparta — What the Temple Dig Really Found".
- **Emoji you typed yourself are never touched.** This is the important half. If your script, your title, your channel's own instructions or your notes contain an emoji, that is your decision and everything written for that episode is left exactly as it came. The prayer channel is the clearest case: its own rules deliberately ask for exactly one 🙏 in the description, and that 🙏 still arrives, because the instruction asking for it is part of what you wrote.
- **A description you have already edited is never rewritten.** Cleaning happens the moment the text arrives from the model, before it is merged with anything of yours. Once your paragraphs and the automatic chapter and source blocks are in one description, the two cannot be told apart, so nothing touches it there.
- **The models are asked first, not just corrected afterwards.** Every prompt that writes text you publish now says plainly not to use emoji. Cleaning the result is only the net underneath — a net alone would fight the model on every single generation and teach it nothing.
- **Removal is whole-character, which is the point.** One emoji is often several pieces joined together — a family, a skin tone, a flag, a keycap — and removing a piece leaves broken text. That is exactly the bug that made DeepSeek look unreliable last week. Emoji are removed as whole characters or not at all, and where a character sits alone it is dropped rather than half-kept. Ordinary symbols like ™ and © are left alone; they are punctuation, not decoration.
- **You can turn it back on.** Settings → This Mac → "Emoji in generated text" has a single switch. It starts off, which is what you asked for, and turning it on stops both the instruction and the cleaning at once so the app never says one thing and does another.
- **Story Studio's own buttons and menus keep their emoji.** The bin on "Hidden channels", the box on "Move this project", the tick on a finished folder — that is the app talking to you, not something going out under your name.
- **One prompt was arguing with itself and has been settled.** The playlist description generator carried its own rule — "no excessive emoji (one max, only if it fits the channel voice)" — which is the opposite of what you asked for. It now follows the same rule as everything else. Comment replies keep their existing behaviour of matching the viewer: if a viewer wrote with emoji, a reply may too.
- **Image prompts are told never to contain an emoji**, because an image model treats one as a thing to depict and draws it into the picture.
- Nothing you have already generated is changed, and subtitles and the alerts Story Studio sends you are unaffected — neither is written by a model.

---

## v1.4.11 — 2026-08-20

- **Story Studio no longer tells every channel it is a history documentary.** Before writing any image prompt, the app attached a paragraph of guidance that opened with "This is a history and documentary channel", and told the model to render the hardest subjects as engravings, woodcuts, frescoes and manuscript plates. Every channel got it, every time — fungi, plants, insects, motivation, prayer, preaching and business economics included. All of them were being told what they were and what they should look like by a helper whose job is neither.
- **The useful half is kept.** That paragraph exists because image providers refuse ordinary subject matter: aftermath instead of the act, suffering shown through posture and surroundings rather than injury, no explicit ages on figures, medicine shown as the room and the instruments. That is craft, it works, and it stays — reworded so it applies to any subject rather than only to history. What is gone is the claim about what kind of channel this is, and the woodcut steer. It now ends by saying, in as many words, to follow the channel's own visual style for how the image should look.
- **If a channel does want the period-illustration look**, put it in that channel's visual style, where you can edit it and where it applies to that channel alone.
- **Negative prompts are gone.** You said you never use them, so nothing sends one now. Two separate things were removed. The first was a "Negative:" line shown in each channel's niche details in Settings — you could read it, it was written into six of the built-in niches, and no part of image generation had ever used it. A setting you can see that does nothing is worse than no setting.
- **The second banned people from your own scenes.** Continuity videos classify each scene as character, event, environment, map or artifact. Every scene that was not a character scene had a hidden list attached — `person, people, child, boy, kid, human figure, character, portrait` — meaning a battle, a market or a coronation was asked for with every human being banned from the frame. Its 2026 intent was narrower: keep the anchored guide character from wandering into a cutaway. The part that actually does that — dropping the guide's description and reference images from those scenes — is untouched and still works.
- **What you will notice from this: nothing, and that is worth knowing.** In tracing it we found the negative prompt was never reaching the image generator at all. It was assembled, logged, handed over, and then dropped before the request was built, because the image service takes only the fields it names and that is not one of them. It has been dead for some time. Your images will render exactly as before.
- **The job log no longer claims otherwise.** It used to print "Prompt layer: … + negative prompt", telling you something had been applied when nothing had been sent. It now names only the layers that are really in the prompt.
- Your saved settings are untouched — a negative prompt already stored against a channel stays on disk, it is simply not used. Visual styles are unchanged.

---

## v1.4.10 — 2026-08-20

- **Archive uploaded videos could have moved a video you never uploaded into another channel's folder and deleted the original.** Nothing had happened yet — the button had not been run, and there is no damage to undo. But had it run as shipped, it would have taken finished masters you never published, filed them under the wrong channel, and removed them from where they belonged. That is fixed, and Archive is safe to use.
- **What was wrong.** Archive only moves a video it can prove you uploaded, and it checked that proof by episode number alone — it looked for `EP0042` and asked "is EP0042 uploaded?". But an episode number is only unique inside one channel. Seven of your eleven channels number their episodes `EP`, 302 episode numbers exist on more than one channel, and `EP0001` through `EP0006` exist on seven each. So one channel's `EP0042`, which you have not published, was proven "uploaded" by a second channel's `EP0042`, which you have. The first channel's master would have been copied into the second channel's archive folder, checked byte-for-byte against itself, found perfect, and then deleted from the first.
- **The careful part was working the whole time, which is what made it dangerous.** Archive copies first, verifies the copy at its destination by size and checksum, and only then removes the original — so a half-finished copy is never mistaken for a good one. All of that was correct. It was simply guarding the wrong file: the video was verified into the wrong place, perfectly.
- **Every video is now tied to the channel folder it actually sits in.** A file under a channel's folder is checked against that channel's uploads and nothing else. If a video's channel cannot be worked out from where it sits — no channel folder anywhere in its path, or a folder that two channels could claim — it is left alone and listed with the reason. There is no falling back to matching by number: a video whose channel is unclear is exactly the one that must not be moved.
- **The list you approve is now the list that runs.** Pressing "Move them" used to re-scan the folder and act on whatever it found the second time, so anything arriving between reading the bill and agreeing to it joined the move unannounced. Only the videos you were shown are moved now, and anything that turned up since is reported instead.
- **The confirmation box now says what is actually true.** It used to describe every skipped file as "not confirmed uploaded", including the dozen-odd files in your TerenceGaming folder that have no episode number at all and were never candidates. It now breaks the skipped pile down by the real reason.
- **Archiving can no longer invent an episode folder.** When Archive notes where a video went, it writes that note into the episode's existing folder — and it used to create the folder when it was missing, which alongside the bug above meant conjuring an episode on the wrong channel as a side effect. It now refuses, finishes the move, and tells you the folder is missing.
- **Why this shipped: the tests could not have caught it.** Every test for this feature used a single channel, so "two channels sharing an episode number" was not merely untested — it could not be written down. The tests now cover several channels, and the new one was run against the old code first to confirm it fails there.

---

## v1.4.9 — 2026-08-20

- **The "flaky DeepSeek" failures were never DeepSeek.** Metadata and other generations have been dying intermittently for days with a message about a character that "can't be encoded" — and because retrying with a different model usually worked, it looked like one provider being unreliable. It was not. The bug was in Story Studio, it could hit any model, and switching models only changed the odds. Nothing was wrong with DeepSeek V4 Flash; there is no reason to keep avoiding it.
- **What was actually happening.** Before sending your story to a model, Story Studio trims it to fit — the first 1,500 characters of the narration, the first 500 of the description, and so on. Emoji are stored internally as two joined pieces, and the trim was counting pieces rather than characters. Whenever the cut-off point landed in the middle of an emoji, it kept half of one — and half an emoji is not valid text, so GenStudio refused the request before generating anything. That refusal was correct. The broken text was ours.
- **That is also why it came and went.** Every regeneration produces slightly different wording, so the emoji lands in a different spot and the cut misses it. Same episode, same model, works on the third try — which is exactly what made it look like a provider having a bad day.
- **Trimming now stops before an emoji instead of through it.** If a cut would land inside one, the whole emoji is dropped and the text stays valid. This was fixed everywhere text is trimmed on its way out, not only in metadata: story context for scene plans and image prompts, your Series Formula instructions, continuity directives and style bibles, on-screen cue labels, subtitle previews, and YouTube titles, descriptions and tags.
- **And a second guard behind it.** Models occasionally produce a broken half-character on their own, which no trimming rule can prevent. Every request Story Studio sends to GenStudio is now checked and repaired on the way out, so an invalid character can no longer reach it. The same check runs on what gets sent to YouTube.
- Nothing you have already generated is affected, and no request that previously worked behaves differently. The only change is at the trim point, and only when an emoji sits on it.

---

## v1.4.8 — 2026-08-19

- **"Got it" on the two upgrade notes now means forever.** The notes about custom folder labels and about finished videos moving into your Library came straight back every time the app started, no matter how often you closed them. Dismissing one wrote nothing down: at every launch the app rebuilt both notes by re-checking the same things that were true when it first wrote them, and those things are still true — so the notes reappeared seconds after you got rid of them. Story Studio now remembers that you have read a note, and a note you have closed is never shown again. Not after a restart, not after a hundred, and not if you go back to an older version and come forward again.
- **Nothing of yours was deleted to achieve that.** The obvious shortcut — throw away the old folder settings so the notes have nothing left to report — would have taken your `named-roots.json` and your existing exports folder setting with it, and both are still read for good reasons. Closing a message says something about the message, not about your files, so only the message is forgotten.
- **If closing a note ever fails, it now says so.** Before, the note disappeared from the screen whether or not the app managed to record it, then quietly returned later — which is a large part of what made this baffling. The note now stays put until it has actually been saved, and tells you if it could not be.

---

## v1.4.7 — 2026-08-19

- **Credit figures on the Jobs page now say "credits".** The GenStudio batch line read `50 items · 450 on hold`, where the 450 is credits and the 50 is items — so it looked like 450 items were on hold. Every credit figure on that page now carries its unit.
- **And they all say it the same way.** The same page was spelling one fact three different ways: the batch summary printed `450 charged` with no unit, the per-job line printed `charged 450` with no unit, and the held figure alone printed `on hold 450 credits` with one. All twelve places now read `450 credits charged`, `450 credits on hold`, `450 credits returned`.
- The numbers themselves were correct — nothing was misreported, only under-explained. The capacity figures beside them (lanes, queued, submissions per minute, waiting locally) already name what they count and are unchanged.

---

## v1.4.6 — 2026-08-19

- **Copying your channels onto a new Mac and pointing Story Studio at them works — checked properly this time.** Put your channel folders wherever you like, launch the app, choose that folder on the welcome screen, and every channel appears straight away. Folders with spaces, apostrophes and Khmer names all come through; anything in there that is not a channel is ignored and left alone.
- **A Library that goes missing is no longer quietly recreated as an empty folder.** This was the serious one. If your Library sat on a drive that was not plugged in, the next page load created the folder again — empty — so the clear "your Library is not available, here is where I looked" turned into a silent "you have no channels". On an external drive it was worse: it could leave a folder standing where the drive should mount, and stop the real drive appearing there. It now refuses, and says so.
- **If your Library goes missing you can get back.** Before, you could not: with no Library there are no channels, and the only place to change the location lived inside a channel's settings. The error screen now offers **Choose a different folder…**, and the welcome screen lets you re-point at the new location without copying anything.
- **Setting a Library in a development build actually works now.** It was being written to one file and read from another, so it saved and did nothing. Only affected running from source, never the installed app.
- **The release-notes window no longer covers the welcome screen on a brand-new Mac.** It was appearing before you had chosen anything, on top of the one screen you have to complete. It waits until you are set up.
- **Choosing your Downloads or Desktop folder itself now says it will be untidy** — three Story Studio folders loose among everything else in there — while still letting you do it. A folder inside is usually neater, but it is your Mac.
- **The welcome screen can be completed without a mouse**, and pressing Return in the folder box now confirms your choice.

---

## v1.4.5 — 2026-08-19

- **Removed a second, unsafe way to move finished videos.** Settings had a **Migrate finals here →** button that moved finished videos without checking the copy first — it copied the file, then deleted the original, with no size check, no checksum, and no check that the video had ever been uploaded. On an external drive, which is exactly where finished videos get moved to, a copy that quietly truncates would have taken the original with it. It is gone. **Archive uploaded videos** does the same job and checks every file twice before removing anything.
- Only one finished video was still sitting in a project folder anywhere in your library, so nothing of value was lost by removing it — and if one ever turns up again, the Archive panel will move it safely.
- **The "External final-video root" panel is honest again.** Its Save, Clear and Browse buttons had been talking to a route that was removed in 1.4.3, so they would have failed silently. Finished videos go to the `Exports` folder inside your Library — that is now simply stated, not offered as a setting you can change from there.
- **The Archive panel has been checked on screen, not just in tests.** The preview, the per-channel breakdown, the reason beside every skipped file, the progress while it runs, and the refusal when a file of the same name is already in the destination were all exercised in a real window, including at phone width where a table of figures would normally overflow. A finished video was moved, verified, and its breadcrumb written, end to end.

---

## v1.4.4 — 2026-08-19

- **Archive uploaded videos — one button that clears finished films out of the way.** In Settings → Storage, point it at the folder your finished videos are in, pick where they should go, and Story Studio moves every video it can prove was uploaded to YouTube. What is left is a folder containing only finished films — something you can back up, park on a slow drive, or delete with ordinary tools. Story Studio does none of those for you, which is the point.
- **It can see the videos you already have.** Your finished videos are in `~/Downloads/YouTube Exports`, not in your Library, so the sweep lets you point it anywhere rather than only looking where the app would put things today. On your library right now it would move **166 videos and reclaim 197 GB**, across eight channels.
- **It only touches videos it can prove are uploaded.** The proof is the same one Story Studio has always required before deleting a finished video: a YouTube video id recorded for that episode. There is deliberately **no override**. Anything unproven stays exactly where it is and is listed with the reason — on your library that is 40 videos, 23 GB, mostly episodes that were never uploaded.
- **Nothing is deleted until its copy has been checked.** Each video is copied to the new folder, then checked there by both size and a full checksum, and only then removed from the original place. If a copy cannot be verified, the original is left alone and you end up with two copies rather than none. Losing a finished video is the one outcome this feature must never produce.
- **You see the bill before it runs.** How many videos, how much space you get back, which channels, and every skipped file with its reason. Then you press the button.
- **You can stop it.** A long sweep reports progress and can be stopped; it finishes the file it is on and stops before the next, so every video is always either wholly moved or wholly untouched — never half.
- **An archived episode says "archived", not "missing".** Each episode records where its video went. Without that, the missing-folder warning added in 1.4.2 would have started accusing archived episodes of being broken — the app would have been manufacturing the exact false alarm it just learned to catch.

---

## v1.4.3 — 2026-08-19

- **One folder holds everything now — your Library.** Story Studio used to have four different ideas about where your work lived: a default folder buried in the system, a custom override, a list of "linked" folders scattered anywhere on disk, and a separate map of labelled shortcuts. That is gone. There is one folder, with a folder for each channel inside it, a `_Project Assets` folder for anything you share between channels, and an `Exports` folder for finished videos.
- **Story Studio asks where to put it, and suggests somewhere you can actually find.** On a new Mac it opens on a single question with `~/Documents/Story Studio KH` filled in, which you can change to Desktop, Downloads, an external drive, or anywhere else you can write. **Nothing is created until you press the button**, so browsing around and changing your mind leaves nothing behind. You can move it later in Settings → Storage.
- **Connecting an existing folder is now just copying it in.** No linking, no registering, no import step. Any folder inside your Library that contains a `project.json` is a channel — copy one in and it appears, take it out and it is gone. That is the whole mechanism.
- **iCloud support is withdrawn.** You said it plainly: it is too unreliable. The code that tried to detect half-downloaded iCloud placeholder files is gone, along with the advice to "right-click and Download Now" that came with it. Saving files still writes safely — if the app is killed or the Mac loses power mid-save you get the old file or the new one, never a broken half — because that protection was never really about iCloud.
- **Finished videos go into your Library.** New renders land in the `Exports` folder there. **Your existing exports have not been moved** — the 220 GB already in your Downloads folder is exactly where it was, and Story Studio still finds those videos when working out what is done. They are yours to move, keep, or delete whenever you want to.
- **Nothing at all was moved by this upgrade.** Where an old setting pointed somewhere outside your new Library, Story Studio tells you once, names the folder, and leaves it completely alone. Five channels were registered from iCloud folders that no longer exist; those dead entries were dropped quietly, because a shortcut to a folder that is gone is not worth interrupting you for. The same five channels are healthy in your Documents folder and appear as normal.
- **Shared files use one label instead of a per-Mac map.** `${ASSET}` now always means the `_Project Assets` folder inside your Library, on every machine. The old custom labels pointed at a different folder on each Mac, which meant a project that worked on one did not work on another. If you had any, Story Studio lists them once so you can move those files across.
- **If your Library is missing, Story Studio says so.** Put it on an external drive and open the app without the drive plugged in, and you get a clear message naming the folder it looked for and a button to look again — never an empty list that looks like your work disappeared.

---

## v1.4.2 — 2026-08-19

- **A channel whose episodes folder has gone missing now says so.** If the folder a project points at is not there, the channel card shows **Folder missing** and names the exact path it looked for, and the project page says the same thing at the top. Until now that project looked completely normal and simply had no episodes in it — the app had already worked out the folder was missing and never mentioned it. Your files are not lost when this happens; the app just cannot see where they went.
- **Nothing guesses a replacement folder.** The path is named and you decide. Guessing is exactly the wrong move here: one real case had an empty `episodes` folder sitting right where you would expect it while the actual episodes were in a folder next door, so an automatic fix would have quietly pointed the project at nothing and called it done.
- **The app stopped telling you to press a button that no longer exists.** Four places — including the confirmation dialogs for *unlinking* and *hiding* a project — told you to recover it later with "Add existing project folder…", which was removed from the All Projects page some time ago. Following that advice left you with no way back at all. They now describe what actually works: put the folder in your projects folder and Story Studio finds it by itself. Settings → Storage shows where that folder is.
- **Hiding a channel has a way back again.** "Hide project (keep files)" is still there, but the panel that restored hidden channels had disappeared, which quietly turned hiding into a one-way door — the files stayed safe on disk and became unreachable from the app. The **🗑️ Hidden channels** panel is back on the All Projects page, with **Restore** on each one.
- **Imported projects are now recorded in a way that survives moving to another Mac.** Importing a folder used to write down its full path, including your username and drive — which stops working the moment either changes. When the folder lives in your projects folder it is now recorded relative to the project instead, so it keeps working after a move. A folder on an external drive is still recorded in full, because that is the honest answer for it.
- Checked while in there: **"Move this project to…" was never the cause of this** and cannot re-create it — it relocates the folder and never rewrites the episodes path.

---

## v1.4.1 — 2026-08-18

- **Your overlay effects can travel between episodes; their timing cannot.** You said overlays should belong to episodes but still live in presets so you can randomise the effects. Both are true now: a preset carries the overlay itself — which file, its opacity, size, position, blend and looping — and each episode keeps its own answer to *when* that overlay appears. A 12-second flourish placed over the closing line of a 16-minute episode was landing mid-sentence in a 9-minute one.
- **Applying a preset no longer re-times another episode's overlays.** This was the same fault that put one episode's captions on another episode's video, in a different place: something specific to one episode was riding along in a preset and surviving a switch. Changing episode now loads that episode's own overlay timings, or none — it never leaves the last episode's standing.
- **Timings you already set are kept, not thrown away.** Presets saved before this release still carry overlay timings. When you apply one, that timing is rescued and saved against the episode you are on — but never on top of a timing that episode already had — and the page tells you once that it happened.
- **Randomising overlay effects cannot scramble their timing.** Because the timing is no longer inside presets, anything that shuffles overlay looks between presets simply cannot reach it. That is a property of how the data is stored rather than a rule something has to remember.
- **Version numbers now only move on the last digit.** Story Studio stays at 1.4 and counts up from there — 1.4.1, 1.4.2, and onward past 1.4.100 without a break. Where a release matters more than usual, these notes will say so in words rather than in the number.
- Checked while making that change that nothing breaks once the last digit reaches two or three figures — the release checks, the changelog ordering and the What's New pop-up were all already fine at 1.4.100.
- Fixed while in there: content pack version lists were sorted as text rather than by number, so a pack's tenth update would have been listed as though it came before its second. This affected the order things were shown in, never which version was actually installed or rolled back to.

---

## v1.4.0 — 2026-08-18

- **You no longer choose which subtitle file to burn.** Story Studio picks it — this episode's corrected stitched transcript, or the best full transcript it has — and Step 5 simply tells you which one it is using. You asked for the choosing to go away, not for the file to be a mystery, so the name is always on screen.
- **The per-chapter files are gone from that list.** Each one covers a single chapter, so burning one would caption a fraction of the episode. They were never a sensible choice and are no longer offered. If any exist, the page says how many it is not showing, so their absence never looks like a missing-file bug.
- **You can still choose, behind a "Change" link.** You said you should not *need* to pick, not that picking should be impossible. Your choice is remembered per episode and cannot follow you to another one, and one click puts it back to automatic.
- **Your subtitles now stitch and re-stitch themselves.** You no longer have to remember. Before every render Story Studio checks whether the stitched transcript still matches the chapters it was built from, and rebuilds it if not — then says in the log what changed and why, so a rebuild is never something that just happens.
- **It compares the words, not the file dates.** Copying a project folder, restoring one from a backup or letting it sync rewrites file dates without a word changing, and can make an out-of-date transcript look newer than the chapters it came from. Story Studio compares the actual content instead, so it cannot be fooled by any of that.
- **This repairs the mid-July damage on its own.** Every stitched transcript you already have was made before this record existed, so the first time each episode is rendered it re-stitches once, correctly, and records what it used. **You do not need to re-stitch anything by hand.** You do still need to re-render the affected episodes — a video that has already been made is not changed by any of this.
- **If the captions cannot be timed, the render stops and says so.** When Story Studio cannot work out how much audio plays before your narration begins, it now refuses rather than assuming there is none. Assuming was exactly what put roughly sixteen seconds of drift into everything merged since mid-July, silently. It names the cause and tells you to re-run Audio Assembly for that episode.
- **The corrected transcript is what gets burned now.** Where Story Studio has fixed the spelling of names your narration uses — the pass that turns Whisper's "Mirion" back into your "Neorion" — those corrected words now go into the video. Until now your scene images were being generated from the corrected words while the video burned the uncorrected ones: one episode, two spellings, and the wrong one on screen.
- **Three frames of the real video before you render it.** Press Generate and Story Studio takes three pictures from different parts of the episode — around a sixth of the way in, the middle and near the end — with the captions burned in exactly as the final render will burn them. You look at them, and the render only starts when you say they are right. It takes about a second.
- **Every frame is guaranteed to have a caption on it.** The three sample points are pulled onto the nearest caption rather than taken at a fixed moment, because a frame of silence proves nothing. Each one is labelled with its timestamp and the line it is showing.
- **They are the real thing, not a mock-up.** The captions in those frames come from the same code that burns the final video, at the same size, from the same lines — so what you approve is what you get. The picture behind them is the right scene but skips motion, grading and overlays; the page says so.
- **Batch renders get the frames too, without stopping.** A Pipeline run has nobody watching it, so it saves the same three pictures next to each finished video instead of waiting for a click. They sit beside the video as `..._subtitle_preflight_1.png` and so on.
- **Story Studio now warns when your Scene Plan is following old caption timing.** Your scene plan is built *from* the stitched subtitles, so an automatic re-stitch that shifts the timeline leaves the pictures where they were. It now tells you, on both Scene Plan and Video Assembly, how far out things are — and points you at **Reconcile timings**, which re-times your existing scenes and keeps every image, prompt and approval. Nothing is repaired behind your back.
- Fixed while in there: the warning that appears when a plan is older than its subtitles used to send you to **Repair long scenes** or a full rebuild. Neither is right for this, and a full rebuild renumbers every scene and leaves the images you have already paid to generate unattached to anything. It names Reconcile timings now.

---

## v1.3.4 — 2026-08-18

- **A video can no longer be given another episode's subtitles.** You rendered EP0047 and the captions burned into it were EP0048's — Timbuktu's words across Rome's video. Video Assembly holds the subtitle file you pick as a path to one episode's file on disk, and nothing replaced it when you changed episode. Pick a file for one episode, switch to another, and Step 5 was still pointing at the first one. It moves with you now.
- **It re-picks rather than forgetting.** Changing episode finds the same kind of transcript in the new one — corrected stays corrected, stitched stays stitched — instead of emptying the box and making you choose again every single time. When the new episode has no equivalent the box clears and says so, rather than quietly keeping the old file.
- **And it always tells you.** Whenever the file changes because you changed episode, the page names the file it dropped and the one it put in its place. Swapping the words about to be baked into your video without a word is the same fault in a quieter form.
- **Story Studio now refuses to render a subtitle file that is not the episode's.** The page forgetting to reset was the bug; the renderer cheerfully burning any file it could find is what turned it into a finished video you were about to upload. It checks before a single frame is encoded, names the episode the file really belongs to, and stops. It does not silently substitute the right one — which transcript goes in is your call, not the app's.
- Fixed while in there, same shape and both reach the finished video: the **title screen picture** and the **episode title text** each stayed on the previous episode's value whenever the new episode had nothing to replace it with. Both clear now instead of borrowing.
- Fixed while in there: when the asset scan failed, the page went on showing the previous episode's scene count, cycle estimate and low-asset warning as though they described the episode on screen.
- Fixed while in there: the Step 6 summary reported scene shuffling and excluded scenes from a saved preset, while the render has both switched off regardless. It states only what actually happens now.
- **Batch renders get their captions.** Found while fixing the above: running Video Assembly across several episodes from the Pipeline left the subtitle file blank on every one of them, because a saved bundle deliberately does not carry one episode's file and nothing filled in each episode's own. Those videos came out with no captions at all and nothing said so — the render did not even count them as missing. Each episode now uses its own subtitle file (your pinned choice if you made one), and says which in the log. If an episode genuinely has none, the render says that plainly instead of quietly leaving them out.
- **Your subtitles are back in time with your intro.** Re-stitching EP0047 gave a timeline starting at zero even though its merged audio opens with your 15-second branded intro — so every caption ran sixteen seconds ahead of the picture. The cause was small and unlucky: since July, every audio merge writes a little bookkeeping file beside the track, named closely enough that the code measuring your intro picked *that* instead of the audio, failed to measure a text file, and reported "no intro". Everything merged since mid-July was affected and everything older was fine, which is why it looked random.
- **The answer was already written down.** The merge records exactly what it put in front of your narration — for EP0047, 16.066 seconds. Story Studio reads that record now instead of working the number out a second time, so what the Merged Audio row tells you before you render and what your captions are shifted by can never disagree.
- **Re-merged tracks are found too.** If you merged again and ended up with a second file beside the first, the intro measurement used to skip it entirely and report zero.
- **"No intro" and "I could not work out the intro" are different things now.** They used to be spelled the same way — a silent zero — so a timeline sixteen seconds early looked exactly like a correct one. Stitching states which happened every time: the offset it applied and where that came from, or that nothing precedes your narration, or that it could not tell, why, and what to do about it.
- **Your YouTube chapter timestamps were early by the same amount**, on the same episodes, for the same reason. The same change fixes them, and when the intro cannot be measured the package now warns that the chapter marks may be early instead of presenting them as exact.

---

## v1.3.3 — 2026-08-18

- **Contextual Cues saves itself.** You said you keep forgetting to click Save changes, so you no longer have to. Every edit — a title, a time, an approval, a dragged label — writes itself a moment after you stop. Leaving the page, switching episode or reloading the timeline writes first, so nothing is left behind by walking away.
- **Save changes is still there, and still does something.** Press it and it writes whatever is pending straight away. Press it when everything is already written and it tells you so, instead of sitting there greyed out looking broken.
- **The page says where it has got to** — "Unsaved changes — saving in a moment", "Saving…", "Saved at 21:14" — next to the buttons, so you never have to guess whether your last edit is safe.
- **If a save fails, nothing is lost.** Your edits stay exactly where they are, the row says plainly that it did not save, and Save changes tries again. It will not quietly retry on a timer, so a backend that is down does not get hammered while you read the message.
- Two saves can no longer overlap, and a reply that arrives late can no longer overwrite what you typed while it was travelling — so a cue title never reverts under the cursor.
- **Approve all saves like everything else.** Making a bulk approval wait for review was considered and rejected: approving fifteen cues one at a time would save, approving the same fifteen in one click would not, and that difference is invisible until it loses work. Nothing is committed by saving an approval — the cue only reaches the video when you render, and it stays one click from undone until then.
- **A preset now tells you when it changes Auto-approve safe proposals.** You applied your "Contextual Cues - DeepSeek" preset for its model and pacing and found automatic approval switched on without being told. The preset really does carry that setting, and it is staying — you asked for presets to keep everything they can — but it announces itself now, in both directions: switched on, switched off, and, when a preset has nothing saved for it, left alone with nothing said.
- Fixed while in there: applying a preset saved before that setting existed used to switch automatic approval **off**, because "this preset says nothing about it" and "this preset says no" were being read as the same thing. They are now different, and a preset with no opinion changes nothing.
- Fixed while in there: a save started just before you switched episode addressed whichever episode you had switched *to*. It now addresses the episode the cues actually came from.

---

## v1.3.2 — 2026-08-18

- **You can now open the assets in Video Assembly before you render.** Step 1 listed scene numbers, thumbnails and the merged audio track and let you open none of them. Click any scene number or thumbnail chip to see the picture full-screen, and browse the whole episode with the arrow keys. The merged track gets a player, so a quick listen no longer means leaving the page.
- **The merged audio now tells you whether your intro is in it.** You asked not to find that out after rendering the video. Newly merged tracks record what they prepended, and the row reads back the intro's filename, its length and the gap after it — "Intro included — Channel_Intro.mp3 (6.0s) + 2.0s gap. The narration starts at 8.0s."
- **For episodes merged before this release, Story Studio measures the file instead of guessing.** Every merged track already on your disk predates the record. Rather than reading your current Audio Assembly settings and describing an old file with them — those settings say what is set *now*, and the file may have been made with something else — Story Studio measures how much audio plays before the narration and says exactly that much and no more: "16.1s plays before the narration starts… it can't say whether that is your intro or a music lead-in — re-merging records it." When nothing precedes the narration, that *is* the complete answer, and it says so.
- The measurement is the same one your burned captions are already shifted by, so the two can never drift apart. If the chapter sidecar no longer matches the file, the row says it cannot tell rather than reporting a confident zero.
- **The exact subtitle preview opens in a window, and is worth looking at.** It rendered at 640×360 and sat at roughly 310 pixels wide — beside a rough CSS sketch drawn at twice that. The approximation outranked the accurate one, and enlarging the accurate one only blurred it. It now renders at 1280×720, opens in a large dialog the moment it finishes, and shares its width with the sketch. Click the clip to freeze a frame — useful for judging word-by-word highlighting.
- Sharpening the preview costs about half a second more per render, once, and the result is cached.
- Fixed while in there: the image preview counted across sections, so the third thumbnail of five announced itself as "Thumbnail 122 / 124". It now counts within its own section.

---

## v1.3.1 — 2026-08-18

- Scene Plan now reserves your real opening. When you build a timeline, Story Studio measures the clips that actually play before your first scene — the intro video, a title card, any clips you have parked at the head of the timeline — and starts scene one exactly there. The finished video puts every scene on the narration it was written for.
- This is the other half of the fix from two releases ago. That one moved contextual cues back onto their scenes and deliberately stopped short of moving the scenes themselves, because changing how a video is composed is your decision and not the app's. This is that decision, taken: **new plans are right by construction, and nothing you have already made is touched.**
- What was wrong: three different places each claimed to know how long your branded opening was. Your Scene Plan preset said "start at the first second" and, contradicting itself, "reserve 15 seconds". Your project settings said "branded opening, 10 seconds". The file on disk was 10.0 seconds. The preset won, so plans reserved nothing at all — and every scene appeared ten seconds after the narration it was planned against, with the last ten seconds of pictures cut off the end.
- Only one of those three was ever a fact. Story Studio now asks the file and ignores the other two. If you have no intro, nothing is reserved and nothing moves.
- **There is nothing left to type.** The "Opening visuals" box on Scene Plan no longer asks you for a mode and a number of seconds; it tells you what your clips measure and where scene one will start. Change the opening in Video Assembly and build the timeline again — the figure follows the clips.
- **Scene Plan presets no longer carry an opening length.** A preset should restore a reusable choice, not re-decide a measurable fact about your project's files. Presets you have already saved keep those two stale values on disk and are never rewritten; they are simply not read any more.
- The plan and the renderer now share one measurement rather than each doing their own sum. Two independent answers to "what comes before the scenes" is how this went wrong in the first place, and it would have gone wrong again the day you added a title card.
- **Your finished episodes are left exactly as they are**, as you asked. A plan built before this release still renders the way it always did, including the trick where an intro is stretched to fill a longer reserve. Only timelines built from now on use the measured opening.
- If an opening clip cannot be played on this Mac — a missing file, or one iCloud has not downloaded yet — Scene Plan says so by name instead of quietly reserving a shorter opening than the render will use.
- Fixed while in there: a batch render from Pipeline silently dropped every clip you had added to the timeline yourself, so a batch produced a different video from the one the Video Assembly page produced from the same settings.
- Fixed while in there: whether captions sit out the opening is now decided by whether there is an opening, rather than by a setting saved on another page months earlier. Your own tick-box in Video Assembly still wins whenever you have set it.
- Proved on real video, not on settings: an episode with an intro and one without were both rendered end to end and the actual pixels read back frame by frame, checking that the picture on screen at each moment is the scene planned for that moment.

## v1.3.0 — 2026-08-18

- Contextual cues can now be put where you want them. You can place a label in any of the four corners, or drag it to any spot on the frame — which is what you asked for after a cue landed on top of the channel logo on EP0047, too high and in a corner you could not move it out of.
- Bottom placement was never missing. It was written, it was checked, and the renderer had always drawn it correctly — but six separate places along the way each decided for themselves which corners you were allowed to pick, and half of them quietly answered "the top two". Anything you chose that was not top-left became top-right without saying so. Every one of those six now reads the same list.
- One of them would have caught you out even after the menus were fixed: a cue anywhere along the bottom was refused outright whenever burned-in subtitles were switched on. Since that is nearly every episode, unlocking the menu alone would only have moved the dead end to the moment you pressed Render. It is now a note beside the cue, not a refusal, and it is worked out from where the label actually sits rather than which corner it is nominally in — so a label placed in the middle of the frame is no longer accused of colliding with captions at the bottom of it.
- **Drag to place.** The little preview beside each cue is now the control: drag the label and it moves. It shows the frame, the protected edge, and the label exactly where the finished video will put it. There are Across and Down boxes beside the timings for keyboard use, and the same pad sits in the proposal settings so new cues start where you want them instead of being moved one at a time.
- **Set it once for a whole project.** The default position is saved with your cue preset, so "keep labels clear of my logo" is said once and stamped onto every cue a proposal creates. Any single cue can still be dragged somewhere else afterwards, and **Use everywhere** takes one cue's position and gives it to the rest of that episode.
- **Cues no longer disappear too fast.** A cue used to be refused unless it lasted between 2.25 and 4.5 seconds. Nobody chose those numbers — they arrived with the feature's first commit carrying no explanation — and 4.5 seconds is barely a third of what the longest label the same check allows can actually be read in. An 80-character title with a 100-character second line is 180 characters, which takes around 12 seconds at normal on-screen reading speed.
- So the ceiling is gone as a refusal and is now only a note, shown when a label holds for more than about 12 seconds. How long to leave a label up is a decision about the pace of your own film, and the app should not overrule you on it. Nothing downstream depended on cues being short: they still cannot overlap each other, and still cannot outlast the scene they belong to.
- The floor stayed, and stayed strict. A label that flashes past for half a second is not a style choice, it is text nobody can read — so a cue still has to be on screen for at least 2.25 seconds.
- Corners are still there as one-click presets, and nothing you have already made has moved. Existing cues keep the corner they were saved with and render pixel-for-pixel as before; the new positioning is something a cue gains only when you give it one. Chapter plates stay centred, as they always have been, unless you place one by hand.
- Fixed while in there: clearing a label's position would have pinned it to the very top-left instead of releasing it back to its corner, because an empty value counts as zero in JavaScript. Found by a test written for this release, before it ever reached you.
- Fixed while in there: a saved cue preset that stored a bottom corner lost it every time the preset was applied, and again every time the batch runner in Pipeline read it.
- All four corners and a hand-placed label are now checked by rendering real video and reading the actual pixels back, rather than by inspecting the instructions we send to the renderer. That is the only kind of check that could have caught this: every layer was individually correct the whole time.

## v1.2.9 — 2026-08-18

- Regenerating a thumbnail now changes the picture you are looking at. The small image on the row always updated, but opening the large preview kept showing the previous artwork — so a re-render looked like it had done nothing, and the only way to see the new picture was to restart the app.
- The artwork itself was never the problem. Every re-render wrote the new file correctly; it was the enlarged preview that kept showing an old copy it was holding on to, because a regenerated image keeps the same filename and the browser had no way of knowing anything had changed. It now knows, and swaps the picture the moment the render finishes.
- The same stale-picture fault was found and fixed in four more places before anyone hit them: the Browse Existing Images grid, the thumbnail board after a Repair, the thumbnail shown on the YouTube Upload page, and the scene frames shown in Video Assembly. All five had one cause and now behave the same way.
- Refresh buttons now refresh the pictures, not just the file list. "Refresh" on the image browser re-read what was on disk but kept re-drawing the old artwork, which is precisely what that button exists to disprove.
- Nothing changed on the server. It was already sending the right instructions and already reading each file fresh — the old preview was being shown without the app ever asking for it, so no amount of server-side care could have prevented it.
- The preview's own "couldn't load — retry" recovery is untouched and still works exactly as before.

## v1.2.8 — 2026-08-17

- Closing Story Studio in the middle of a batch no longer leaves a job stuck forever. When a request was still being sent at the moment the app closed, it never reached GenStudio at all — and on reopening, Story Studio would sit waiting for an answer about a request that does not exist. One batch waited twenty-two minutes with forty-eight further images queued behind it, and nothing in the app could clear it.
- Story Studio now understands the difference between "GenStudio says it does not have this" and "Story Studio could not reach GenStudio". The first is a final answer: the request was never created, so nothing was generated and nothing was charged. The batch stops waiting, says so in the log in exactly those words, and finishes.
- The second is still treated as a temporary problem and keeps waiting, because it is. Getting that backwards would mean re-sending — and paying twice for — work a provider had already accepted, so a network failure, a server error, a rejected key and a "gone" response all hold exactly as before. Story Studio never re-sends anything by itself on the back of this.
- Every job now has a way out. A job stuck waiting on something Story Studio cannot resolve used to have its Cancel disabled, its Delete refused, and only a greyed-out button reading "Checking provider status" left — no exit by any button or any route. There is now an **Abandon this job** control, always offered on an unfinished job.
- It says plainly what it does not do, in the confirmation itself: it does not cancel provider work GenStudio has already accepted, it does not refund credits already spent, and output may still arrive and stays recoverable. What it does is stop Story Studio waiting and let the queue move on. The ordinary Cancel is unchanged and still does the careful thing whenever the provider's state is genuinely knowable.
- After abandoning, **Retry** sits on the same row. Generating a replacement is one click from where you gave up, not a hunt on another page.
- New **Recover this episode** button on a failed job's own row. It does what Repair does — pull back output the provider finished but that never landed on disk, at no credit cost — for that one episode, without scanning the library. Repair itself is unchanged and still searches everything, which is what it is for when you do not yet know which episode is at fault.
- Fixed while in there: "Repair all" has always accepted a list of episodes to limit itself to, but audited every episode anyway and then discarded the rows it did not want. The limit was real in what it repaired and imaginary in how long it took.

## v1.2.7 — 2026-08-17

- Contextual cues now appear on the scene they were written for. On any episode with a branded opening they were landing early by exactly the length of that opening — ten seconds on one channel — because a cue is reviewed against Scene Plan time while the finished video starts with an intro the plan knows nothing about.
- Story Studio works the offset out for itself, from the real opening clips, at the moment it renders. There is no new setting, nothing to remember, and nothing to pick per episode. No intro means no offset, and an episode whose Scene Plan already reserves its opening is untouched.
- Because the offset is measured rather than configured, it covers the whole opening — clips placed before the intro, the intro, clips after it, and the title card — not the intro clip alone.
- The render log now says what it did: how long the opening measured, where Scene Plan starts its first scene, and how far each cue moved.
- Video Assembly no longer refuses to render an episode that has no contextual cues. Contextual Cues is optional, and an episode where none was ever proposed has nothing to approve — but the render was stopped anyway, asking for a review of cues that did not exist. It renders now, and says in the log that it is rendering without them, so their absence is never a surprise.
- The same block was coming from Pipeline: switching the project setting on made Scene Review unrunnable across the whole library, eighteen episodes at once, over cues that had never been proposed. Both gates now answer that question from the same rule, so they cannot drift apart.
- What the gate protects is unchanged. A cue that was proposed and left unreviewed still holds Scene Review and still stops the render, because that really is a decision waiting for you.
- Sound Design had the identical fault and is fixed alongside it — found by looking for the shape, not by waiting for it to be reported.
- Choosing Contextual Cues in a Pipeline run still runs it on an episode that has none. "Nothing to review" and "already generated" are different answers, and treating them as one would have quietly cancelled the very work you asked for.
- Fixed while in there: the Pipeline header read "0 blockers" while preflight listed eighteen problems beside it. Both numbers were right, about different things. It now reads "setup blockers", and says on hover that every episode is checked separately when you press Run Batch.
- Fixed while in there: "Exclude intro and title from effects" claimed it also held subtitles back. It never has — the caption filter cannot be time-gated at all — so the promise was empty, and it made "Hide captions during the intro", which does work, look redundant. The wording now says which does what.
- Captions were already right and are unchanged. They answer to the words, and the narration is not delayed by the opening; cues answer to the picture. That is why only one of the two moves.
- Video Assembly now warns when an intro is enabled but Scene Plan reserved no room for it, naming how far the scenes then sit from the narration they were planned against, and how to lock the two together. It renders either way — this was previously silent.

## v1.2.6 — 2026-08-17

- Scene Plan now tells you which art style an episode is using. The "Style from Character Sheet" block showed the style guidance and nothing else, so a wall of art direction gave no way to tell it was "Archival Documentary Reconstruction". The style's name and its category now sit above that text, matching what the Character Sheet shows.
- The channel default style is named the same way, so an episode falling back to it says what it is falling back to.
- Art direction you wrote yourself is labelled "Custom style" and says so plainly, rather than being left nameless. And if the style library cannot be loaded at that moment, Story Studio says the name is unavailable instead of calling a shipped look custom — it will not guess a style's identity from a library it failed to read.
- Finished jobs can be cleared from the job list once their provider work is actually done. A job that finished while one of its provider calls was still in flight kept a note saying that call was unfinished, and nothing ever went back to check — so the row said "Story Studio cannot remove this history while durable provider work is still settling" forever, about work that had finished long ago, with no credits held. Story Studio now re-asks GenStudio, updates what it knows, and offers Remove from history the moment GenStudio confirms everything finished.
- The three possible answers now read differently, because they mean different things. While the check runs, the row says it is asking GenStudio — and it genuinely is. If GenStudio cannot be reached, it says exactly that and offers a "Check GenStudio again" button, instead of making a claim about the provider that Story Studio has no basis for. Only when GenStudio itself reports work is unfinished does the row say the work is still settling, and the re-check button is still there.
- The protection itself is unchanged: history is still never discarded while provider work might genuinely still settle. What changed is that Story Studio asks before saying so, and no longer shows a disabled button labelled "Checking provider status" while checking nothing.
- Contextual Cues has an "Approve all" button. It names how many cues it will approve, and it only touches cues still awaiting review — a cue you deliberately excluded is left exactly as you set it. Like every other edit on that page it marks the timeline as changed and waits for Save changes; it never writes on its own.

## v1.2.5 — 2026-08-17

- Character Sheet presets remember the scene rhythm again. Save a preset with an episode set to "5–10 seconds — Slow & deliberate", apply it on another episode, and that episode now moves to 5–10 seconds along with the art style. Rhythm was deliberately taken out of presets in August, after a preset quietly changed it on 50 of 53 episodes; putting it back is a considered reversal of that decision, not the old bug returning.
- Presets you saved while rhythm was excluded do not contain one, and applying those leaves your episode's rhythm exactly where you set it. Nothing falls back to a built-in default, and nothing already saved on disk is rewritten to paper over the gap.
- Because a rhythm that correctly does not move looks identical to a feature that does not work, the Character Sheet now says which happened. Apply a preset and it either confirms the preset set the rhythm and to which band, or says that preset has no saved rhythm, that this episode is unchanged, and that saving over the preset captures the current rhythm for next time.
- "Use episode anchor" is unchanged and still stays out of presets. Applying a preset will not switch it on and point an episode at an anchor image it never had.
- Fixed while checking the above: the scene rhythm dropdown and the custom shortest/longest boxes had no names a screen reader could read out, so they were announced as blank controls. They now say what they are.

## v1.2.4 — 2026-08-17

- The Content Store now opens fully stocked the first time you visit it after launching the app. The shop front — every product, shelf, cover, description, tag and price — is saved on your Mac and drawn instantly, instead of an empty page while Story Studio talks to GenStudio.
- What you own, what is installed on this Mac and your credit balance are deliberately NOT saved. Those are facts about your account, not about the shop, and a saved one redrawn a week later looks exactly like a freshly checked one. They arrive a moment later, from GenStudio, every time.
- In that moment the app says so rather than guessing. Cards read "Checking…" instead of "Available", the Owned, Installed and Updates tabs show a dash instead of a zero, and the account strip says it is checking instead of showing a balance. Nothing is described as unowned before anyone has looked.
- Buying, installing and Restore purchases stay switched off for that moment, using the same switch that already turns them off whenever the catalog is not freshly verified. Nothing can be purchased against a saved page.
- Opening the Store with no internet at all now shows the saved shop front and says GenStudio could not be reached, instead of an empty "Content Store is unavailable" screen.
- A saved shop front is thrown away rather than trusted whenever anything is off: a different GenStudio account signs in, the catalog came from a different GenStudio address, the file is older than thirty days, its timestamp is in the future, or a future version of Story Studio wrote it in a shape this one does not recognise. Account identity is kept as a one-way fingerprint that cannot be read back or displayed, only compared.
- Added a test that fails if any new account-specific field ever starts being written to that saved file, so the boundary cannot erode quietly in six months' time.

## v1.2.3 — 2026-08-17

- The Content Store no longer reloads itself every time you open it. If it already has a catalog it verified recently, that catalog appears instantly and the check with GenStudio runs quietly behind it, replacing anything that changed. A loading screen now only appears when there is genuinely nothing to show yet.
- Kept being right about what you own ahead of being quick about it. Every visit still asks GenStudio; nothing is served from memory instead of being checked. Buying, installing and Restore purchases still force their own fresh read, and the Refresh store button always goes to the network. If a quiet check fails, the page says it is showing the last verified catalog and switches purchase and install off, rather than leaving old ownership looking current.
- Stopped being quiet about a catalog older than five minutes. The check is the same, but the page shows that it is happening, because figures from an unbounded time ago should not look like nobody is re-checking them.
- Fixed the Content Store blaming filters nobody set. When every published pack was already owned, Discover said "No published products match these filters" and offered to clear filters that were not there. It now says which of four different things is actually true: you own everything published, nothing is published yet, your filters really did exclude everything, or the packs exist but GenStudio has not shelved them.
- Moved the GenStudio credits and lanes strip into the top bar on project pages, so account standing sits in the same place on every screen instead of the sidebar on some views and the top bar on others.
- Put the running version and build date in the project sidebar, where the strip used to be. Project pages previously showed no version anywhere, so there was no way to tell which build you were on without leaving the channel.

## v1.2.2 — 2026-08-17

- Story Studio now checks transcripts for garbled text and says so before it reaches a customer. Speech-to-text sometimes invents characters from other writing systems in the middle of English narration, and it happens more often than anyone would guess: across 4,032 real subtitle files, 18.7% contained letters from a script nobody spoke and 4.4% contained undecodable characters.
- Five checks, each measured against those 4,032 real files before shipping: letters from another writing system (18.7% of files), undecodable characters (4.4%), a word repeated over and over (0.4%), invisible control characters (0.1%), and accent marks with nothing to attach to (0.05%).
- Deliberately does NOT flag ordinary accented text. Café, Škoda, Zoë, naïve, gelmiş, curly quotes, dashes, ellipses, music notes and emoji are all normal and stay silent, as does short deliberate repetition like "No, no, no, no, no!" A warning that cries wolf is worse than no warning, so the rule is other writing systems — not merely unusual characters.
- Shows the actual offending lines — cue number, timestamp and the text itself — so a line can be judged in a second instead of investigated.
- Warns in all three places the transcript matters: on Subtitles, where affected chapters are marked in the readiness list; on Scene Plan, because that text is fed to the model that writes your image prompts, so garbled lines buy wrong pictures; and in Video Assembly, beside the file about to be burned into the video.
- Never edits anyone's subtitles, and never blocks a render. A mangled word cannot be repaired without knowing what was really said, so the app reports and you decide.
- Added a one-click "Re-transcribe this chapter", which is the only real repair. It re-runs just that chapter instead of the whole episode.
- Fixed re-transcription not actually re-transcribing. Ticking "re-run" skipped the local "already done" check but then reconnected to the previous request and downloaded the very same result — so a chapter re-run precisely because its transcript was garbled came back identically garbled. An explicit re-run now asks for a genuinely fresh transcription, while an ordinary retry after a crash still reconnects rather than paying twice.

## v1.2.1 — 2026-08-17

- Caption looks and scene effects can now arrive from an installed Content Pack. A pack may add a caption style, a camera move or an overlay, and each one appears in the same gallery, previews the same way and renders through the same engine as the ones that ship with the app.
- Kept the free library free and complete. The sixteen caption looks, twenty-four scene animations, seven B-Roll motions and thirteen overlays still ship with Story Studio and still work with nothing installed — a pack can only add to that list, never replace or quietly stand in front of part of it.
- Said where every look came from. A style or effect from a pack is marked in the picker and names the pack, and the mark explains what will happen to it if that pack is uninstalled.
- Refused to render a video that quietly lost something. If a pack is removed while an episode still uses one of its camera moves or overlays, the render stops and names the effect and its publisher instead of publishing the video without it. A caption look is unaffected either way, because applying one copies the finished style into the episode rather than pointing at the pack.
- Refused a pack this build cannot honour, naming the field that was the problem: an unknown setting, a look authored for a newer caption or effect engine, a category that is not one of the app's own, a still camera move filed as a B-Roll move, and a corner-logo effect trying to name a file on the customer's machine.
- Held pack content to the same content rules as the rest of a pack. A web address, a provider routing instruction or a pasted API key inside a caption or an overlay is rejected by name, even though each is an ordinary piece of text as far as the look itself is concerned.
- Left a bad pack costing only itself. A pack whose files no longer match what was signed is dropped whole, and the free library is served untouched beside it.
- Fixed the scene-animation picker being able to drop an entry on the floor: its six category names were written out twice, once in the picker and once in the effect library, with nothing keeping the two in step.

## v1.2.0 — 2026-08-17

- Turned every camera move into data. All twenty-four scene animations and all seven B-Roll motions now come from one declarative library instead of hardcoded branches, so a new move is a description rather than a code change and an app release. Every one of them renders exactly as before — 1,163 filter strings captured from v1.1.0 are compared character for character on every build.
- Added a free built-in effect library that composites on top of the finished picture: soft and heavy vignettes, fine and heavy film grain, warm and cool light leaks, CinemaScope and widescreen bars, clean and bare lower thirds, a corner logo, and top and bottom gradient scrims. Each has named settings with documented ranges, and each can be previewed over the episode's own first scene before it is used.
- Said plainly, in the picker, where an effect cannot do exactly what its name promises — the light leaks, the gradient scrims, Blur → Focus, Dolly In and Parallax Drift each carry a sentence explaining what is really being drawn.
- Made the effect library the single source for the Video Assembly vignette, film grain and letterbox controls and for the corner-logo placement, so a control and a library effect of the same name can no longer drift apart.
- Fixed Rotate CW and Rotate CCW producing no preview at all: at a preview's frame height the rotation asked the encoder for an odd picture size, which it refused. Present since the rotations were added.
- Fixed the animation picker giving every tile a different randomly-generated backdrop, which made two animations impossible to compare side by side.
- Fixed the B-Roll motion list being a hand-maintained copy of the renderer's list whose descriptions had already drifted out of step. It is now served by the app.
- Corrected the scene-animation type, which claimed five animations existed while the app offered and rendered twenty-four.

## v1.1.0 — 2026-08-17

- Added word-by-word captions: highlight, pop, reveal, single-word and typewriter modes, each with its own colours, scale and timing, plus a highlighter block behind the spoken word.
- Added sixteen built-in caption looks — from Clean Broadcast and Sleep Soft to Karaoke Pop, Neon Glow, Yellow Highlighter and Minimal Lower Third — applied from a gallery that changes the look only and never touches an episode's subtitle file or settings.
- Rebuilt the caption properties panel around a versioned, purely declarative style schema, with every field exposed in collapsible Typography, Colour, Box, Placement, Animation and Word groups: weight, italics, capitals, letter and line spacing, per-colour opacity, box padding, shadow depth and offset, edge blur, and slide-down alongside the existing animations.
- Made the subtitle preview four seconds long over a full sentence, and render the exact caption document the final video burns, so preview and export now agree on size, stroke, position and timing at any resolution.
- Fixed captions ignoring the chosen line width and line count in final renders whenever no animation or precise position was set — both assemblers now burn through one renderer instead of a lossy shortcut.
- Started collecting per-word timings on every new transcription, at no extra cost, and fixed the request fingerprint that would otherwise have replayed the old word-less transcript while reporting success.
- Added a plain marker on the Subtitles page showing which transcripts carry word timings, so an older episode's estimated word timing is explained rather than mysterious.

## v1.0.844 — 2026-08-16

- Prevented delayed test-only Job Queue persistence from falling through to the configured customer projects folder after temporary test storage is released.
- Added a byte-for-byte regression using an isolated fake projects root, covering both unexpected `jobs.json` updates and unexpected project-directory creation.
- Made the official backend test command create and verify its own disposable per-machine home, settings, and projects boundary instead of reading the developer's live Story Studio configuration.

## v1.0.843 — 2026-08-16

- Added explicit deterministic build and validation support for GenStudio delivery-attested Content Pack archives without publisher key IDs or archive signatures.
- Kept the publisher-signed local import and recovery paths independent, rejecting any attempt to mix the two trust modes.

## v1.0.842 — 2026-08-16

- Added a complete Content Store experience with curated shelves, search and filters, release-proof details, separate Owned, Installed, and Updates libraries, accessible status announcements, and truthful offline and account-scoped states.
- Added support for staged publication of ten free Starter Channel Kits and the componentized Archival Ledger collection, with reusable Formula, Topic, Visual Style, and Thumbnail Recipe components, exact dependency closures, and no automatic mutation of legacy projects.
- Hardened Content Store claims, purchases, restores, and installs with byte-exact signed quotes, idempotent settlement, delivery attestations, OS-protected historical key anchors, account-isolated retained proof, exact bundle verification, and terminal recall enforcement.
- Made Motion Review use exact GenStudio-published image-to-video operations and per-variant pricing, and fixed Scene Review statuses that could remain stale across pause, restart, or overlapping render batches.

## v1.0.841

- Upgraded the desktop runtime from Electron 39 to Electron 43.4.0, removing the vulnerable legacy archive extractor from Story Studio's development and packaging dependency tree.
- Added a release regression that prevents the vulnerable `extract-zip` dependency from silently returning through a future Electron downgrade.
- Preserved Story Studio's packaged app identity, local data paths, offline startup, and unsigned arm64 DMG workflow across the runtime migration.

## v1.0.840

- Added same-account Content Store restore and explicit verified installation, including signed receipt, archive, identity, compatibility, and dependency-closure checks without automatic purchases or downloads.
- Added GenStudio account locks across every model catalog and generation boundary, keeping locked choices visible while preventing locked or Premium models from being selected as silent defaults.
- Added a persistent balance, tier, and lane-standing strip across both Story Studio shells, with truthful local ownership and installed-pack status even when remote downloads are unavailable.

## v1.0.839

- Fixed Content Store scope refusals being mistaken for expired Story Studio web sessions.
- Keeps the Content Store page open so a missing `content:read` scope shows its truthful Settings guidance instead of returning to Channels.
- Preserves the real remote-session login redirect while ignoring account-key scope responses in both desktop and server modes.

## v1.0.838

- Added GenStudio-published per-image pricing to every image-model row before selection.
- Shows the full published rate range when output sizes cost differently, instead of presenting the default 1K rate as if it covered every size.
- Keeps the exact selected output-size rate in the existing output picker and never invents a total charge.

## v1.0.837

- Added a dedicated published-rate line to model selection rows so LLM input/output token rates and TTS character rates are visible before choosing a model.
- Preserved GenStudio's exact LLM rate, minimum, and price-version fields through Story Studio without inventing an up-front total whose output usage is not yet known.
- Kept model descriptions and request limits visible alongside pricing instead of allowing one catalog fact to hide another.

## v1.0.836

- Fixed packaged Content Pack and Content Store pages failing to load because the installed app attempted to discover a development source directory before using its bundled recovery resources.

## v1.0.835

- Added the GenStudio Content Store commerce core: browse published packs, see the exact content-spendable balance, request a signed quote, and confirm a permanent account purchase with durable idempotency.
- Added restart-safe purchase evidence and an unverified receipt cache. Story Studio never repeats a purchase automatically and clearly separates GenStudio ownership from installation on this Mac.
- Added Content Store scope checks and honest empty, insufficient-credit, incompatible, unavailable, and uncertain-outcome guidance. Downloads, restore, and receipt verification remain disabled until GenStudio Phase 2 publishes their contracts.

## v1.0.834

- Adds the local signed Content Pack runtime for Series Formulas, Topic Packs, Visual Styles, and Thumbnail Recipes, with strict offline verification, a bundled recovery catalog, safe import, disable, rollback, and removal guards.
- Pins projects and queued generation work to exact verified pack versions and hashes, so updates never silently change existing creative inputs and missing content blocks only the workflows that directly need it.
- Preserves legacy custom content as explicit project-scoped user forks when edited, keeps original and signed sources immutable, and serves only verified declared preview assets through contained local endpoints.

## v1.0.833

- Adds Economy, Balanced, and Premium navigation to model pickers when GenStudio's live catalog publishes a complete cost classification.
- Applies the same published cost-tier treatment across Language, Image, Video, Music, TTS, and Transcription catalogs; Music keeps its classification in Settings until Story has a customer-facing Music generator.
- Keeps model choice intentional: new fully classified selectors may choose only an available Economy model, never silently escalating to Balanced or Premium, while saved explicit choices reopen their published tier.
- Preserves the existing flat picker and legacy selection behavior whenever any model in a picker is not yet classified, without guessing a tier from provider, price, name, or model ID.

## v1.0.832

- Adopts GenStudio 1.2.0's published retry timing, provider progress, stall recovery, status, and failure details across durable jobs and the Jobs/Remote displays.
- Honors GenStudio's absolute `retry_at` polling schedule instead of substituting a local retry guess.
- Treats each chat model's published structured-item maximum as a safety ceiling for Contextual Cues while preserving checkpointed batch identity and the proven 50-scene Story policy when the limit remains unmeasured.

## v1.0.831

- Makes unsigned and public desktop packaging use the exact Electron runtime already installed from the lockfile, avoiding a redundant network download that could fail after every source/build gate had passed.
- Retains the v1.0.830 neutral Blank-project production guidance so adopted Series Formulas no longer inherit unrelated sleep-story instructions.

## v1.0.830

- Makes new Blank projects start with neutral production guidance instead of inheriting sleep-story audience, welcome, and pacing instructions that could contradict an adopted Series Formula.
- Keeps existing customer-authored production standards untouched; the affected Hidden Mechanics of History soak project was explicitly reset to let its active history Formula own narration.

## v1.0.829

- Makes explicit Audio “Regenerate” work use a fresh deterministic Story-job identity instead of reclaiming a successful TTS task from an older run or retired API key.
- Keeps restart replay idempotent for that same regeneration job while allowing the replacement audio to overwrite only the selected chapter files.
- Re-qualifies forced overwrite and versioned generation against published audio fleet concurrency with no duplicate provider submission.

## v1.0.828

- Keeps “New version” audio outputs on their own `_vN` filenames even when regeneration is forced, preserving the previous audio instead of overwriting it.
- Gives each versioned audio file an independent durable recovery identity, so a replacement voice never reclaims an earlier account’s settled TTS job.
- Re-qualifies versioned regeneration against the selected model’s published fleet concurrency and submits only genuinely new replacement work.

## v1.0.827

- Writes ordinary narration numbers in natural spoken English, including conventional historical and modern years, dates, decades, ordinals, quantities, percentages, currency, decimals, and ranges.
- Applies the same deterministic, idempotent spoken-number safeguard to legacy or imported narration before TTS quoting, chunking, recovery, and submission, while preserving exact identifiers, URLs, citations, equations, model names, paths, addresses, and other ambiguous technical literals.
- Stores spoken forms in newly generated or edited chapter bodies without rewriting structural headings, episode metadata, or legacy scripts during compatibility migration.
- Re-qualifies audio generation against each selected TTS model's live published submit concurrency, so supported replacement audio fans out across the provider fleet while missing or invalid hints remain safely serial.

## v1.0.826

- Checkpoints every completed Contextual Cues batch, reuses saved batches after failure or restart, and paces new language submissions to the live account limit.
- Retries only a confirmed provider-backpressure batch, with a bounded cooldown and a fresh durable identity, when GenStudio proves zero settled credits and a full reservation release.
- Adds cooperative Scene Image pausing before every new provider request, persists the pause across restart, and resumes by verifying existing files before submitting only missing scenes.
- Reports whole-episode image progress as completed, settling, customer-cancelled, failed, and not submitted; customer cancellations no longer appear as provider failures.
- Adds a no-output stall hold that stops new image submissions without cancelling or retrying accepted provider work, while keeping provider reconciliation and duplicate locks intact.

## v1.0.825

- Stops every not-yet-submitted GenStudio request for the same API key after an insufficient-credit response, while already accepted work continues to settle normally.
- Preserves completed Scene Plan prompts and generated assets, prevents automatic repair or later batch items after the credit floor, and makes Retry resume only missing work after the balance increases.
- Records a refused request as failed before dispatch instead of invalid model output, and safely starts fresh work after a proven pre-dispatch credit refusal rather than looking up a provider job that never existed.
- Adds stage-aware Scene Plan restart auditing so recovered visual and motion prompt jobs are marked complete only when their required saved prompts verify on disk.

## v1.0.824

- Made six-modality GenStudio cancellation authoritative: only published pre-dispatch work can receive the single provider cancellation request, including Chat and Music, while dispatched Video work continues settling.
- Made restart recovery read only through the persisted idempotency key for every supported modality, retaining sibling locks until authoritative terminal evidence arrives and never creating replacement paid submissions.
- Preserved exact GenStudio dispatch and settlement facts in durable job evidence and Jobs displays, without inferring refunds, releases, charges, or provider outcomes.

## v1.0.823

- Made cancellation settlement displays truthful by using the provider-published direct release amount when account history is unavailable, while keeping account history authoritative when present.
- Added live GenStudio standard-lane, temporary boost, and service-tier context to Jobs without turning published display capacity into a dispatch promise.
- Made Research and disabled optional production stages truthful: Research never blocks completion, claim-review outcomes remain visible, and disabled stages report complete without invented sidecars.
- Made Motion Review select, persist, and submit an exact live published duration/resolution variant, preserving that pair through durable retries and rejecting stale selections before provider work starts.
- Retired obsolete format-contract vocabulary and remapping while keeping the active Continuity Engine contract and independent B-Roll and Image Pool workflows clear.

## v1.0.822

- Made job controls financially truthful: cancellation, local stopping, provider cancellation requests, reconciliation, and history removal are now distinct actions.
- Preserved provider cancellation outcomes and resumed pending reconciliation safely after restarts without duplicate generation.
- Added visible explanations for duplicate, prerequisite, reconciliation, post-dispatch, and missing-only generation guards.

## v1.0.821 — 2026-08-11

- **Music catalogue access is now verified before production starts** — Settings names the
  required `music:generate` scope, and the read-only key test checks the music catalogue directly
  so a missing scope is reported before Sound Design or another music workflow needs it.

## v1.0.820 — 2026-08-11

- **Interrupted language work now recovers without replacement charges** — outline, chapter,
  listicle, and narrative-repair retries use their recorded GenStudio idempotency keys to look up
  the original durable job. Missing or ambiguous history remains safely blocked, while confirmed
  terminal failures can start one deliberate replacement request.

- **Settings now reports the live GenStudio music catalogue** — the retired standalone voice
  diagnostic has been replaced by Music models, including published provider details and clear
  coming-soon status. The existing TTS model diagnostics remain unchanged.

## v1.0.819 — 2026-08-11

- **Interrupted chapter expansions can always be reconciled safely** — when several earlier
  attempts still contain unresolved GenStudio evidence, Story Studio replays those exact request
  identities first instead of deadlocking or starting replacement work. A newly selected model is
  used only after every older submission has settled.

## v1.0.818 — 2026-08-11

- **Approved episode direction now survives the complete script workflow** — outline edits keep
  their generation snapshot, chapter expansion and regeneration reuse the saved guidance, and
  affected v1.0.817 sidecars preserve any recoverable snapshot.

- **Manual chapter recovery is safe and usable** — fully settled failures can receive one fresh
  retry identity, while pending or mixed provider evidence reattaches with the original model and
  request identity. Partial chapter progress refreshes after every terminal outcome.

## v1.0.817 — 2026-08-11

- **Production release qualification is now deterministic** — the selected-model TTS fan-out check
  uses an in-process submission barrier instead of a timing window, while preserving the serialized
  pre-submit durability writes that protect recovery and prevent duplicate paid work. Production
  runtime behavior is unchanged.

## v1.0.816 — 2026-08-11

- **Web research evidence is now more transparent** — provider-reported source URLs stay with the run and appear as evidence without incorrectly claiming that a source-less result has no sources. Only safe HTTP(S) links are clickable.

- **GenStudio capacity and job states now fail safely and read clearly** — temporary or malformed capacity data limits submissions to five per minute, while real job states use clear labels.

- **TTS now follows each selected model's published submit concurrency** — missing or invalid values remain serial, while supported providers can process sections faster without inferring capability from the provider name.

## v1.0.815 — 2026-08-11

- **Image Generator episode loading now scales cleanly** — each episode exposes exact planned scene-image counts from the existing status scan, so all-image completion no longer depends on Scene Review approval and the extension no longer needs an episode-by-episode recount.
