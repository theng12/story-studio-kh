# Follow-up to GenStudio: what does a web-search citation actually look like coming back?

**From:** Story Studio KH
**Follows:** `docs/genstudio-web-search-request.md`
**Status:** Story Studio is building the Research web-search mode now. The catalogue
fields and request shape you sent are enough to build the UI, the capability filtering,
the depth control and the cost estimate. The one thing still missing is the **response**
side — what comes back, and where.

Please answer the questions below, including "we are not building that" where true. A
clear no is genuinely useful: Story Studio will just not render the field, rather than
leaving a placeholder for something that never arrives.

---

## Q1. Where do citations arrive — your envelope, or the model's JSON?

Story Studio asks the model for a JSON object, and separately you now perform web search.
So a citation could plausibly come back in either place:

- **(a) In your response envelope** — a top-level `citations` field alongside the answer,
  produced by the search layer.
- **(b) Inside the model's JSON** — the model writes its own `citations` array as part of
  the object it was asked to produce.

`citation_format: "structured"` reads like (a), but we do not want to guess field names
and build a mapping against something imaginary. **Which is it?**

If (a), please include the exact JSON shape.

## Q2. What fields does each citation carry?

Story Studio already stores citations in this shape and can consume it today
(`ResearchCitation`), so anything matching these names maps with no translation:

| Story Studio field | What it is | Why it matters here |
|---|---|---|
| `title` | source headline / page title | shown on the source card |
| `url` | link the user opens | the whole point — a claim you can check |
| `snippet` | the passage actually cited | lets a user spot-check without opening every link |
| *(requested)* `publisher` | site or organisation | "Nature" vs a random blog is most of the trust signal |
| *(requested)* `published_at` | when the source was published | a 2011 page and a 2026 page are not equal evidence |
| *(requested)* `retrieved_at` | when **you** fetched it | see Q3 |

Which of these will you return? Optional is fine — Story Studio treats every one as
optional and simply omits what is absent. It never errors on a missing field.

## Q3. `retrieved_at` specifically — will you provide it?

This is the one field Story Studio **cannot** obtain any other way.

`publisher` and `published_at` are properties of the source, so if you do not supply them
the model can often state them and we can ask for them in the prompt schema.

`retrieved_at` is different: only the search layer knows when the page was actually
fetched. If the model were asked for it, it would be inventing a timestamp — which is
worse than not having one, because it looks like provenance while being fabricated.

Why Story Studio wants it: the user is moving into science and history content, where a
claim is checked by opening the source. Pages change and get edited. "Fetched 2026-07-31"
tells a reader that the quoted passage was on the page on that date; without it, a source
that has since been rewritten silently makes a correct claim look wrong, or a wrong claim
look sourced.

**If you will not provide it, that is a fine answer** — Story Studio will fall back to
stamping its own "research run at" time on the whole run, and will not imply per-source
retrieval accuracy it does not have.

## Q4. How is a claim tied to its citations?

Story Studio's model is: a research run produces N claims, each reviewed individually,
and each claim points at the sources backing it (`ResearchClaim.citation_indices` →
offsets into the citations array).

So we need some join. Either:
- the model emits per-claim citation references in its JSON (ids or indices), or
- your envelope provides the mapping.

**What is the intended mechanism?** If the answer is "the model is told to reference them
and usually does", say so — Story Studio will handle a claim that references nothing by
showing it as uncited, which it already does today.

A citation list with no claim linkage is still usable (we can show the sources for the run
as a whole), but per-claim linkage is what makes verification meaningful: the user reviews
claim by claim and needs to know *which* source backs *this* sentence.

## Q5. Does the citation count interact with `max_web_searches`?

Story Studio will show a depth selector capped at `max_web_searches`. Is that a cap on
**searches performed**, or on **sources returned**? They are not the same — one search can
yield several sources. The label the user sees should be accurate, so we would rather ask
than assume.

## Q6. Are search costs reported separately in the job response?

Story Studio will show an estimated extra cost before the run, from
`web_search_credits_per_search`. Afterwards it displays what you report as actually
charged — it never computes customer charges locally. If retrieval is billed separately
from tokens, is that visible in the job response, or folded into the existing credit
fields?

---

## What Story Studio does while this is open

Everything except the citation mapping is being built now and does not depend on these
answers: the mode selector, capability filtering (`available && supports_web_search &&
returns_citations && citation_format === "structured" && research_qualified`), the depth
control, domain filters, cost estimate, preset and pipeline persistence, and per-mode
provenance wording.

Since every model currently reports `research_qualified: false`, the web mode ships
visibly unavailable with an explanation, and turns itself on when you flip that flag —
no Story Studio release required.

The citation mapping is the last piece, and it is small once the shape is known. Send the
response shape whenever it settles and Story Studio will wire it in.
