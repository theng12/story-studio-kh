# Story Studio KH — Changelog

What's new in each release. Newest first.

---

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


Older entries are in `git log` — this file keeps the releases a customer can still be
running, newest first, because it is the source of in-app **What's New**.
