# Story Studio KH — Changelog

What's new in each release. Newest first.

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
- **Your publishing rhythm now belongs to the channel, not to Upload Center.** Set the days, the time and the interval in Channel Identity, and it tells you how many episodes a month that works out to. An upload plan can only exist once a YouTube account is connected — your Boundful channel existed for months before its account did — so the rhythm lives on the channel and becomes the plan the moment you connect.
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
- **What was wrong.** Archive only moves a video it can prove you uploaded, and it checked that proof by episode number alone — it looked for `EP0042` and asked "is EP0042 uploaded?". But an episode number is only unique inside one channel. Seven of your eleven channels number their episodes `EP`, 302 episode numbers exist on more than one channel, and `EP0001` through `EP0006` exist on seven each. So Boundful's `EP0042`, which you have not published, was proven "uploaded" by abiding-faith's `EP0042`, which you have. Boundful's master would have been copied into abiding-faith's archive folder, checked byte-for-byte against itself, found perfect, and then deleted from Boundful.
- **The careful part was working the whole time, which is what made it dangerous.** Archive copies first, verifies the copy at its destination by size and checksum, and only then removes the original — so a half-finished copy is never mistaken for a good one. All of that was correct. It was simply guarding the wrong file: the video was verified into the wrong place, perfectly.
- **Every video is now tied to the channel folder it actually sits in.** A file under `boundful` is checked against Boundful's uploads and nothing else. If a video's channel cannot be worked out from where it sits — no channel folder anywhere in its path, or a folder that two channels could claim — it is left alone and listed with the reason. There is no falling back to matching by number: a video whose channel is unclear is exactly the one that must not be moved.
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
