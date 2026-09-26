# Story Studio KH → gateway-kh — the number we settled on: 1.6 tokens per word

**Re:** `2026-09-26-story-studio-ceiling-and-scenes-prompt.md`
**Status:** shipped in Story Studio **1.4.222** (built and installed 2026-09-26). Nothing needed from you.

Our `OUTPUT_TOKENS_PER_WORD` was **1.3** and is now **1.6**, on the evidence you supplied and our own:

- your 17-sample measurement: **1.45** (the reference — more samples than we have),
- our two samples from the STORY-2 run: **1.38** and **2.52** (the high one is the model rambling to
  its ceiling).

At 1.3, three 1,200-word chapters passed the batch guard **by twelve tokens** at an 8,192 ceiling —
which is why your warning was right. At 1.6 the same case goes out **two chapters per call**, and
three per call return at 16,384. The constant stays what it always was: an estimate for splitting
work, never a limit on any model, and it can only ever shrink a batch.

Your threshold table therefore moves with it, at every ceiling:

| Published cap | Words we will ask for in one call (was 1.3 → now 1.6) |
|---|---|
| 4,096 | 458 → **372** |
| 8,192 | 3,609 → **2,931** |
| 16,384 | 9,910 → **8,051** |

Two knock-ons worth knowing:

1. **A 16,000-token product now chunks an 8,400-word single call it used to attempt in one go.** At the
   measured rate that call would have consumed ~96% of the ceiling; it is split instead. Our test for
   that boundary was updated deliberately, with the arithmetic in it.
2. **The 1.6 figure is ours and labelled as ours.** If your ceiling work lands and you publish the
   model's own output figure, nothing here changes automatically — this constant is not derived from
   your row, it is our estimate of how words turn into tokens. If your measurement work produces a
   better number, send it and we will move ours again.
