# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.4.414 — 2026-11-19

- **An episode with text can no longer preview as empty.** When the saved metadata was being written at the same moment the preview read it, the preview could come back with a blank description — and a blank field is exactly what a save would then write back. The preview now says the file could not be read and names it, instead of showing an empty box. Measured on the same file while it was being written: 48 of 50 reads came back empty before, none after.
- **An empty edit can no longer wipe a description.** A saved description that is blank no longer replaces the real one and is no longer counted as something written by hand.
- **A picture's record now says what the picture actually is.** The Gateway sends each model's own format, so a scene file can be a JPEG under a `.png` name. The record now reads the format from the bytes, so anything that looks at the record gets the truth instead of the extension.
- **A damaged settings file is reported, not ignored.** Two optional override files were read as "no override" whenever they could not be parsed; a real read failure now names the file and stops, instead of silently dropping a chosen thumbnail.

## v1.4.413 — 2026-11-19

- **A retired model is caught before the work, not hours into it.** A saved plan that names a model the Gateway no longer sells is now refused when the run is started: Pipeline says so before it queues anything, and episode recovery stops before it re-does narration, audio or subtitles. The message names the missing model and where to pick a current one. If the Gateway cannot be read at all, that is treated as an outage, not a missing model, and nothing is blocked for it.
- **A model the Gateway renamed keeps working.** When the live catalogue publishes the same product under another name, the saved choice now finds it and the job says which name it used. It is the same product, so nothing about the writing changes; a product the catalogue no longer publishes is still never swapped for a different one.

## v1.4.412 — 2026-11-19

- **Removed private details from the app's own text.** An example address in the Gateway error message and the comments that named owner channels no longer appear anywhere in the shipped app. Nothing functional changed: no setting, no address and no default was read from either, and the example now uses the reserved documentation range. The native Keychain guard also no longer carries a build path.
- **The gate now cleans up after itself.** A test process left behind by an interrupted release no longer keeps running (and competing for memory) after the gate that started it has gone.

## v1.4.411 — 2026-11-18

- **Clear replaces Hide.** A finished job now leaves the list for real instead of only being hidden: the row and its record are removed, it waits in a new "Recently cleared" area with Restore, and nothing is ever deleted for good. Clear runs by status — finished, failed, or all — for one channel or every channel, and before anything goes Story says how many jobs and how much record space it will remove, measured, and states plainly that the rendered media stays on disk. The jobs already hidden are moved into Recently cleared the first time their channel loads, so nothing disappears without a way back.
- **A frozen API says so, and comes back by itself.** When a request has waited too long, Story logs which operation is holding it and how long, and reports the wait on its health check instead of answering as if everything were fine. The health check no longer touches the disk. If the app is genuinely stuck past its limit, it stops taking work, says so in one sentence and exits cleanly, so the login item brings it straight back rather than leaving a frozen window until someone notices. Both limits are settings; the recovery is on by default.
- **Tests and builds no longer depend on a shortcut folder.** The trash folder is a real, named location instead of a link through the checkout, so emptying the Desktop trash can no longer break a test run or a DMG build.

## v1.4.410 — 2026-11-18

- **Scene Plan now asks for 50 scenes per request by default.** "Automatic" used to send 250 scenes in one writing request. Smaller requests come back sooner, so a slow provider no longer puts a whole batch at risk of running out of time. A channel that already saved its own number keeps it — nothing is rewritten — and 100 is still offered as a choice, along with 250 and 500 and any whole number you type.

## v1.4.409 — 2026-11-18

- **A recovery retry can no longer sit forever.** Retrying a scene plan that had an earlier request at the Gateway could park on "Checking the earlier prompt request" with no end — ten episodes waited 45 minutes with nothing under it. That check now has its own limit, one writing request's own time budget, and when it runs out the row stops and says why, naming Retry and Abandon. It no longer borrows the week-long limit meant for a long render.
- **Retry asks for new work instead of the request it is already stuck on.** The Gateway recognised the retry as the same request it was holding, so it handed back the dead one. A retry you press now carries a new request identity and asks for fresh work. Prompts you already paid for are still collected first, by their saved key, so nothing is bought twice.
- **A blocked retry now tells you why instead of pretending it worked.** Retry used to answer "queued" whether or not anything was queued, so a row that could not be re-run looked like it had been. It now answers with the real reason, in Story Studio's own words.
- **Cancel says what actually stops a stuck row.** When the Gateway cannot stop work it already started, the message now names Abandon — the control that does end the wait — instead of pointing only at Pause, which pauses nothing on a row that is not sending anything.
- **A build can no longer record one machine's folder in the source.** The build's `frontend/dist` link is no longer tracked, so a build on any checkout cannot commit its own local path. Nothing else changes: the build makes the link where it needs it.

## v1.4.408 — 2026-11-17

- **Audio Assembly now makes one audio file: the MP3.** A merged episode no longer leaves a second, much larger lossless copy beside it, so the episode folder holds the MP3 alone and audio takes far less disk.
- **The final video mixes from that same MP3.** Video Assembly no longer looks for a second audio file; it reads the MP3 the merge wrote.
- **Re-mixing an older episode works from what was recorded.** When an episode is re-mixed — for example to add a closing tail — Story re-mixes its chapter audio with the mix settings saved with the original merge.
- **Storage cleanup lists merged narration as one item.** The separate “Full-quality audio” category is gone along with the file it used to clean.
- **Scene worlds for your music can now be edited in the app.** On the Music formula page each world's name, register, sight, scenes and music are editable, and you can add or remove worlds. Saving merges into the formula instead of replacing it; a rename keeps the world where it was; editing and removing the same world in one save is refused rather than guessed. Remove them all and the page says what happens next — each song's scene idea falls back to the formula's register labels, and nothing is lost.
- **A subtitle render is checked against the paired Mac's own limits before anything is sent.** Story reads the subtitle sizes and font count that Mac publishes, and a packet over any of those figures stays on this Mac with the real reason instead of being refused after upload. A Mac that publishes a subtitle profile without those figures is not used for subtitles.
- **Recency Log removals now open the app's own confirmation dialog.** Removing an entry, clearing a kind, or clearing the entire log from Script Generator or the Recency Log page now prompts in Story Studio's own dialog instead of a native confirm that packaged windows ignore.

## v1.4.406 — 2026-11-16

- **A job's bar now shows work that actually finished.** Narration, scene images, music top-ups and the image pool were counting failures as progress, so a batch where nothing succeeded could walk to 94% and then 100% (18 chapters planned, 0 made, 17 failed). The bar now counts completed items only; failed, held and cancelled items each keep their own count on the same row.
- **A resumed scene render now starts its Final Video.** A render that was retried — one scene left to check, the rest already on disk — finished done and left the Final Video it had saved for itself unstarted, with nothing in the log saying why. It now starts that step exactly once, a repeated recovery never starts a second copy, and a saved step that cannot be started says so in plain words instead of going quiet.
- **A stuck Final Video can no longer hang silently for hours.** Each stage of the remote render — getting the packet ready, uploading it, waiting on the paired Mac — now has its own stall limit, the Gateway calls give up after a minute instead of waiting forever, and each row runs on its own so one stuck render can no longer freeze every other Final Video on that Mac. The row says which stage it is in, so a long stretch with no news is a stage you can see rather than a hang you have to guess at.
- **A DMG build no longer dies when your Desktop trash is empty.** The checkout reaches its trash through a link into `~/Desktop/_trash`; emptying that folder left the link pointing at nothing and stopped packaging before it started. The build now recreates the folder behind the link — the link itself is never replaced or retargeted.
- **Refusing to start never costs a job one of its tries.** When Story Studio will not submit because it cannot read the Gateway's model catalogue, nothing was sent and nothing was charged — and that turn no longer counts against the job's automatic retries. It waits a bounded while for a fresh catalogue, says so, and only then gives up with the plain reason and its tries still there.

## v1.4.405 — 2026-11-16

- **Branded typography — your own headline and accent on every thumbnail, off by default.** Settings → Writing & style has a new switch of its own (it does not turn on with the format pool). While it is off nothing changes: the image model letters each thumbnail exactly as before, and the prompt it receives is untouched. Turn it on and the model is asked for art **without lettering**; Story Studio draws your approved headline in the bundled face you choose, in the place your thumbnail layout already leaves for it, and places one of your own transparent accent PNGs (a badge, tag or banner) on the corner you pick. Accents are added with the file picker and retire to Trash — never deleted. Each episode's accent is recorded, so "don't repeat within the last N" reads real history and never empties the pool. The finished picture is a new file beside the art (`…_v1_branded.png` with a sidecar naming what it was made from), the model's art is never written to, and an upload with the switch on refuses to send anything but the branded picture — a stale one (the art was re-made afterwards) says exactly that instead of uploading a headline frozen onto an old picture.
- **Releases you make outside Story now count toward your schedule.** Upload Center → Plans has a **Published outside Story** card: import a CSV or JSON file with the app's file picker, and each row arrives as *needs review*. Only a row you verify counts, and it covers its own day — the calendar marks it as an outside release, never as YouTube-confirmed. A date that is not a real `YYYY-MM-DD` day or a full ISO-8601 instant with a zone is refused with its row number and the value, and a file with any refused row writes nothing at all. A row that would mark a day or an episode the channel already covers is refused rather than counted twice, and the card names the overlapping days.

## v1.4.404 — 2026-11-16

- **Changing a thumbnail's headline no longer leaves the old one in the prompt.** The prompt editor has a **Change the headline in this prompt** action: give the words the prompt already uses and the new headline, and Story replaces that one line in place — the scene and the separate badge keep their own words. If the prompt does not contain the old words, or it carries two different headlines, the change is refused with the reason and nothing is written; editing the full prompt is then the clear way through. Repeating the same change does nothing. A headline no longer sits in a prompt beside the style pack's "do not reserve a title block" instruction.

## v1.4.403 — 2026-11-15

- **One Timeline for the whole episode — and it now renders.** Every second of the episode belongs to one segment, and each segment picks its own media: a generated still, a chart, stock footage, text-to-video or image-to-video. Charts are drawn locally and cost nothing. Segments must join exactly — a gap or an overlap is refused with the second it happens at. **Preflight** prices the whole timeline from the Gateway's live figures before anything renders, and says "price not published" rather than quoting a number of its own; an unpublished price refuses the render instead of spending blind. **Render timeline** sends one job per segment, reuses any segment already done (so a catalogue change never re-buys anything and a model switch re-buys deliberately), then assembles them into one video at the timeline's exact duration, with a status and a plain reason on every segment and a Retry where one failed. Sketch segments are not drawn yet and say so.
- **A pool of thumbnail and title formats, per channel — off by default.** One visible switch, Settings → Writing & style → Format pool. While it is off, nothing changes: one format, one title, exactly as before. Turn it on and you list 1–10 formats; each is a bundle of the thumbnail shell, its lettering (font, text style, title position) and the metadata title style. Every episode gets one from the pool, the same one every time it is opened, and the SAME format drives both its thumbnail and its uploaded title. Each episode shows the format in force on the YouTube Finalizer row and can be given a different one before upload without changing the rest.
- **Every thumbnail Shell now shows a preview of its own layout.** Recipe Shells — including the ones you forked — used to show a blank grey placeholder in the Shell Library, because their layout is written for the image model rather than as text zones. Their preview now draws the layout and typography the Shell asks for, so the formats can be told apart at a glance. A preview that cannot be drawn says so instead of showing a broken picture.
- The Song Pool opens reliably and reports readiness from the channel's current settings. An interrupted image job whose Gateway work is already terminal now ends locally when it cannot safely resume, keeping its evidence and sending no new generation request. A repair's explanation of the Final Video step it adopted stays in the job log as the worker runs.
- **Thumbnail lettering no longer rejects the templates Story Studio ships.** A thumbnail's font and headline descriptions were capped at 200 characters, while the banner triptych's own defaults are 242 and 252 — so every episode using it failed before a single image was requested. The limit is now **1,000 characters by default and yours to change** in Settings → Performance & recovery, which shows the value in force; a description over it is refused with the count, the limit and where to change it.
- **Retry now retires the old job instead of deleting it.** The original row stays in history exactly as it ended — log, provider evidence, cost and timestamps untouched — marked Superseded with the id of the run that replaced it, while the new row points back to it. Superseded rows are off the active list and out of "Needs attention", and a new **Superseded** filter on Jobs shows them with that old→new link.
- A stuck job can now be **Discarded** straight from the Jobs page: the row ends for good as Cancelled with your reason kept on the record (nothing is deleted), and Story Studio asks the Gateway to discard its linked job too — the Gateway's own answer, including when it declines or was not told, is shown on the row. A row whose linked Gateway job has already finished settles itself to terminal without anyone pressing anything.
- An update now holds Story's job queue before it starts: no new job begins, in-flight work gets up to 30 seconds to finish or keep an id the next start follows, and dispatch starts again by itself — nothing is cancelled, queued work stays queued, and an interrupted install never leaves the app refusing to work.

## v1.4.401 — 2026-11-14

- **Regenerate** is one click on a failed image or thumbnail, and **Regenerate all failed** does the whole set. Every regeneration starts a new Gateway attempt with a new operation id — a cancelled or failed job is never replayed — and the old file is kept, recoverable, so you can go back.
- A model that does not publish the aspect ratio you asked for (or its own declared default) is now refused with a clear message instead of quietly rendering a different shape. A Gateway that answers “no eligible machine” shows that reason and the per-candidate reasons.
- The app now has a measured contrast ramp in light and dark (body, secondary text and buttons at 4.5:1), remembered Cards/Table choice per list, warnings grouped with counts instead of repeated per row, and equal-height cards.

## v1.4.400 — 2026-11-13

- **Studio Library** is the new name everywhere in the app — the page, menus, buttons, errors and What's New. Nothing you read says "Content Store" or "GenStudio" any more.
- Installed Studio Library content keeps working without being verified again. Packs you already have open and serve as before; trust is checked only when a new download or an update arrives. If an older local trust record can't be read, the Library no longer blocks the refresh or asks you to restore purchases.
- A Library refusal now says what happened and what to press.

## v1.4.399 — 2026-11-13

- Story Studio no longer checks for or installs its own updates. Settings shows the version and one line — **Updates are installed by Studio Launcher KH** — and nothing in the app can update itself.
- Saved keys and YouTube/social sign-ins live in one owner-only file in Story Studio's own data folder instead of the macOS Keychain, so they keep working after an update and Story never asks for Keychain access. An old Keychain copy is moved across once, if macOS allows it without asking; otherwise the old state is left untouched and you can paste the key again.
- A Gateway connection error now names the address Story tried, and a key field with nothing saved is empty with a hint instead of a row of dots.

## v1.4.398 — 2026-11-13

- The Gateway address accepts a bare IP: no scheme becomes http://, a missing port becomes :8787, and the field shows the address it actually became instead of refusing it.

## v1.4.397 — 2026-11-13

- Every job row has a **Discard** button that removes it for good, with a confirm that says it cannot be undone; **Discard Finished…** does the same for finished history in bulk.
- Two dialogs that still used the system confirm now use the app's own: reusing a still from another episode in this channel, and restoring a channel's settings baseline.

## v1.4.396 — 2026-11-13

- The footer pill says what it does — version and What's New — instead of hiding that in a tooltip, and shows an update waiting as soon as the app knows, not only after a click.
- Channel cards say what an episode code is (EP0001+) instead of showing "EP…", and the grid/list buttons have names for assistive technology.

## v1.4.395 — 2026-11-12

- The sidebar footer is one tidy column: a Support this app row, the version and What's New pill beside an icon-only Check for Updates, and a single status line, with even spacing and the pill on one line.

## v1.4.394 — 2026-11-12

- A deleted preset now goes to the project's Trash and can be undone, instead of being removed for good.
- Channel status badges stay on one line, an empty episode list cannot be opened, and "Draw Songs" says when an episode must be picked first.
- Motion Review and Scene Review no longer mark earlier steps complete when no episode is selected.
- Updates no longer say "Up to date" when the check could not run, and the refresh error is readable in both themes.
- The Settings tab is no longer cut off in the window, and "Open Channel Settings" goes to the section it names.

## v1.4.393 — 2026-11-12

- Opening Story Studio a second time no longer brings the running window to the front. The second copy exits and the window stays exactly where it was.
- A new uninstall removes the app, its helper, the Start at Login job and the login item together, and keeps every channel, episode and setting.

## v1.4.392 — 2026-11-12

- Channels now shows each channel’s YouTube connection beside its Gateway key — connected, needs reconnect, not connected, or unknown — and the sort menu can put YouTube-connected or not-connected channels first.
- One switch in channel Settings, “Auto-approve thumbnail prompts”, is on by default. Turn it off and each thumbnail prompt needs approval before an image is made; an episode can still choose for itself.
- Channel and job lists remain available when saved credentials cannot be read. Channels show “Key status unknown”, and Unlock credentials verifies the saved store before reporting success.
- An update button sits at the top of every window, including Welcome. It shows loading and failed checks honestly, keeps installation deliberate, and fits narrow windows.
- Publishing’s Calendar opens a channel timeline with accepted episodes, actual upload starts, planned releases and the last confirmed YouTube dates, an adjustable weekly target, zoom and a table view. Opening it never uploads, reschedules or changes visibility.
- Private remote rendering checks the paired renderer’s subtitle support and exact font and subtitle file limits before preparing a transfer.
- Motion Review and Pipeline keep the selected model’s published video settings, including sound turned off. Longer scenes hold the final frame; unavailable choices explain why they cannot run.
- The native render helper and the update helper now run from one signed “Story Studio KH Helper” app, so Activity Monitor, Login Items and Background Activity show the proper app name instead of a script or slug.

## v1.4.390 — 2026-11-09

- Opening title cards wrap or shrink long titles to keep the complete text inside the video frame with safe margins.
- Final black-gap checks recognize a deliberate title card only when its rendered text is visible and fits inside the frame. Blank, clipped or unverified cards remain failures.
- Finished remote renders that older versions left running settle from their retained completion evidence after a restart, without changing the accepted final. Acknowledged or safely parked renders no longer inflate running counts.
- Unattended Mac startup refuses Keychain access that needs a prompt and shows “Credentials unavailable” without replacing saved credentials. Help → Unlock credentials… lets someone at the Mac grant access deliberately.

## v1.4.389 — 2026-11-08

- Local release packaging uses the same signing identity across updates and reports a missing identity instead of silently producing an ad-hoc release.
- Closing music continues through the outro and uses the saved fade at the end of the video. Final checks inspect that ending.
- Completed remote renders stay completed after a restart when a newer accepted render has replaced their final video. An evidence-only repair restores affected job records without rendering or replacing the accepted final.

## v1.4.388 — 2026-11-08

- Sleep titles follow the Formula's declared sleep presentation rather than scene pacing. Installed owner Formulas remain available when their store replacement is missing.
- Corner logos respect the measured intro when hiding is enabled, including videos with closing music. Final renders use the local path when the remote renderer cannot preserve that exact logo window.
- Restart recovery leaves an older Scene Plan alone after a newer audio-only run. Recovery records when each step was admitted and what triggered it, so unexpected work can be traced.


<!-- Older releases live in git log. This file keeps only what a customer can still be running,
     newest first, because What's New renders it; prose here must never read as a release entry. -->
