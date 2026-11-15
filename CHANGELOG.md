# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.4.402 — 2026-11-15

- **One Timeline for the whole episode.** Every second of the episode belongs to one segment, and each segment picks its own media: a generated still, a sketch, a chart, stock footage, text-to-video or image-to-video. Charts are drawn locally and cost nothing. Segments must join exactly — a gap or an overlap is refused with the second it happens at — and a segment that asks for a video model the Gateway is not publishing right now says so instead of waiting. **Preflight** prices the whole timeline from the Gateway's live figures before anything renders, and says "price not published" rather than quoting a number of its own. This release builds and prices the timeline; turning it into a finished video is the next step and is not in it.
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
