# Story Studio KH — Changelog

What's new in each release. Newest first.

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
- **Your subtitles are back in time with your intro.** Re-stitching EP0047 gave a timeline starting at zero even though its merged audio opens with your 15-second Boundless intro — so every caption ran sixteen seconds ahead of the picture. The cause was small and unlucky: since July, every audio merge writes a little bookkeeping file beside the track, named closely enough that the code measuring your intro picked *that* instead of the audio, failed to measure a text file, and reported "no intro". Everything merged since mid-July was affected and everything older was fine, which is why it looked random.
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
- **The merged audio now tells you whether your intro is in it.** You asked not to find that out after rendering the video. Newly merged tracks record what they prepended, and the row reads back the intro's filename, its length and the gap after it — "Intro included — Boundless_Intro.mp3 (6.0s) + 2.0s gap. The narration starts at 8.0s."
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

- Contextual cues can now be put where you want them. You can place a label in any of the four corners, or drag it to any spot on the frame — which is what you asked for after a cue landed on top of the channel logo on Boundful EP0047, too high and in a corner you could not move it out of.
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

- Contextual cues now appear on the scene they were written for. On any episode with a branded opening they were landing early by exactly the length of that opening — ten seconds on Boundless — because a cue is reviewed against Scene Plan time while the finished video starts with an intro the plan knows nothing about.
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
