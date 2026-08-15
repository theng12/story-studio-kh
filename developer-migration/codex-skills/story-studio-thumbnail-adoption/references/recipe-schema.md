# Story Studio Thumbnail Recipe Contract

`ThumbnailTemplate` is the catalog object. Built-ins live in `electron/server/thumbnail-templates`; user copies live in the project-root `.thumbnail-templates` library.

Use these recipe fields:

- `layout`: `hero` or `annotated-collage`
- `conceptGuidance`, `compositionRules`, `requiredElements`, `avoid`
- `titleMode`: use `ai`; the selected image model produces the complete title
- `defaultTextStyle`, `defaultFontStyle`, `defaultTextPosition`
- `headlineFormats`: catalog-visible editorial shapes with `{SUBJECT}`
- `visualStyleGuidance`: a narrow visual-language hint, not a replacement for project art style
- `previewImages`: public paths to 2–3 original finished examples

Pipeline ownership:

1. `image-prompts.ts` resolves a selected/effective recipe and directs the image model to render the exact episode title.
2. `images.ts` saves the provider output directly; it does not composite headline text.
3. The catalog card displays `previewImages`; use the synthetic preview endpoint only as a legacy fallback.
