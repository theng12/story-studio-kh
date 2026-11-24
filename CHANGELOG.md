# Story Studio KH — Changelog

What's new in each release. Newest first. The ten most recent are here; older releases are in [`docs/changelog-archive.md`](docs/changelog-archive.md).

---

## v1.4.419 — 2026-11-23

- **The update hold now answers only the updater, and says so when it can't.** Pausing Story before the Launcher replaces it is how an update never cuts off work — but anything else on the Mac could pause it too, and an answer of "not now" was being read as "go ahead". The hold now needs the updater's private token, a file only you can read: without it Story refuses, nothing is paused, it keeps doing its work, and the refusal names the file to fix. Any other kind of request is answered as unsupported instead of quietly doing nothing.

## v1.4.418 — 2026-11-23

- **An upload saved with a blank description now says so where you can fix it.** An approval made before this fix could sit in the queue with no description and fail hours later with one line in its job. Approval now checks the exact details it will send, a queued row that was already saved blank is refused by name with the reason kept beside the episode, and Retry refuses that row instead of queueing the same failure again — it names the one fix: preview, write the description, confirm again.

## v1.4.417 — 2026-11-21

- **An upload now refuses the details hash where the video's revision belongs.** The preview answers with two similarly named values — one for the details, one for the rendered file. A script sent the details hash as the video's revision: the upload was accepted, queued, and failed hours later with "the rendered video changed" while the video sat untouched. That value is now refused at the moment of approval, by name, and a retry of an upload already queued with it is refused instead of carried forward.
- **A blank description is refused where it can still be fixed.** Approving blank details queued an upload that could only fail at dispatch, with the reason left in one queue row. Approval now refuses it by name before anything is queued, saving an empty description is refused the same way (Reset still restores the generated text), and the last refusal stays on disk beside the episode's own upload record and is shown on the preview.
- **The Metadata step proves what it wrote.** If it reports saved while the folder holds no package, the run now fails and names the folder — and the preview says whether an episode has no metadata at all or has metadata with an empty description, which are fixed differently.
- **A queued upload states its place and how long it has waited.** Rows carry the position in the upload lane and the seconds waited, and a row that was held and woken goes back to its first-come place instead of the back of the lane, which is how one upload sat behind later ones for 29 hours.
- **A live "public" answer clears a stale local date.** When YouTube reports a video public (or past its publish time) and the episode still holds a future date, that date is cleared, using the record the readers actually read — so an episode already public stops counting as still scheduled. A private video, a missing answer or a stale one leaves the date alone.

## v1.4.416 — 2026-11-21

- **A step that hangs can no longer hold the queue for ever.** Each kind of work now has its own time limit — hours for a big render, minutes for a small local step — instead of no limit at all. When a step passes its own limit, its row ends with a sentence saying which kind of work ran too long and that it can be retried, the files it already saved stay on disk, any program it started is stopped, and the work waiting behind it starts. The limit follows the kind of work, so a long render is never cut by a small step's clock.
- **A job stopped by a crash or a freeze now says why on the row itself.** When the app had to kill itself because it froze, the row that was running said only that the app restarted. It now says a wedged app was killed by its watchdog, keeps its job id so the restart can follow it, and is retried the same way as before.
- **The wedge note in the code now matches the code.** The comment described pausing the queue for good; the code takes the in-memory, expiring hold — which is what keeps an aborted install from leaving an app that has stopped taking work.

## v1.4.415 — 2026-11-20

- **A video that uploaded later no longer leaves its episode marked as failed.** When an upload failed and a later upload of the same episode to the same channel succeeded, the old failed row kept saying the episode needed attention — so an episode already on YouTube read as blocked. That row now settles and names the upload that superseded it. A retry that also failed, a different episode or a different channel still keeps it.
- **A big final render can finish importing.** The download and the phase limit were both set to five minutes, so a transfer that needed longer was cut off and reported as stuck — a transfer over 300 s can never import. The download is now judged on whether bytes are still arriving, not on how long it has been running, and a transfer that genuinely stops is the only one that is ended.
- **Deleting a hidden channel for good now needs the owner, and needs the size confirmed.** The route that erases a hidden channel's folder had no owner check at all while the Trash's own permanent delete did — anything on this Mac could call it. It now refuses without the app's own window or a signed-in browser, refuses automation keys, and deletes only when the size you confirmed is the size it measures.

## v1.4.414 — 2026-11-19

- **An episode with text can no longer preview as empty.** When the saved metadata was being written at the same moment the preview read it, the preview could come back with a blank description — and a blank field is exactly what a save would then write back. The preview now says the file could not be read and names it, instead of showing an empty box. Measured on the same file while it was being written: 48 of 50 reads came back empty before, none after.
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
