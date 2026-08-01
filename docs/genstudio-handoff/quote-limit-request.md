# Request to GenStudio: make the quote text limit follow the model

**From:** Story Studio KH
**Status:** OPEN
**Urgency:** low — Story Studio has a correct workaround, but the contract is inconsistent.

## The inconsistency

`TTSQuoteRequest.text` is capped at a **fixed** `maxLength: 40000`.

`TTSModelResponse.maximum_input_characters` is **per model** — it is the whole reason Story
Studio stopped hardcoding its own 15,000-character split and now asks each model what it
accepts.

So the catalogue says "this limit belongs to the model" and the quote endpoint says "the limit
is 40,000 for everyone". Those cannot both be right.

## Two concrete consequences

**1. A model publishing more than 40,000 cannot be quoted at all.** If
`maximum_input_characters` exceeds 40,000, a single generation chunk is legitimately larger
than the quote endpoint will accept. Story Studio will not sub-split just to get a quote,
because that would quote units that are never billed — the customer would be shown a total
assembled from jobs that do not exist. We surface the model's rate and say the quote is
unavailable instead.

**2. The number is invisible.** It is enforced but not published, so Story Studio cannot show
it, cannot warn before submitting, and only discovers it by being rejected. That violates the
rule we now apply everywhere: a limit that is enforced must also be shown.

## The request

**Publish the quote text limit per model, and make it follow `maximum_input_characters`.**

The simplest version: add something like `maximum_quote_characters` to `TTSModelResponse`, or
state plainly that the quote limit **is** `maximum_input_characters` — in which case no new
field is needed, only alignment of the `maxLength` on `TTSQuoteRequest` and a line in the docs
confirming it.

The second option is our preference. A quote is a price for a job; if a job can be that long,
its quote should be quotable. One number governing both is easier for everyone to reason
about than two that usually agree.

## What Story Studio does either way

Long narration is already generated as **N separate jobs**, split at the model's published
`maximum_input_characters`, written out as `_part1`, `_part2` and so on. Each is billed
separately by GenStudio, including any per-job `minimum_credits`.

So Story Studio quotes each chunk that will actually be submitted and shows the parts and
their total. That total is a sum of your own exact figures for jobs that will really be sent —
not a Story Studio estimate, and not arithmetic on a rate. It is labelled as such to the
customer.

This is why the fixed 40,000 is awkward rather than fatal: chunking already matches billing.
Aligning the limits would simply remove a case where an otherwise valid model cannot be
quoted.

## Not requested

No change to how quotes are priced, and no bulk or multi-chunk quote endpoint. One quote per
job is the right granularity, because one job is the unit that gets charged. We are not asking
you to total anything for us.
