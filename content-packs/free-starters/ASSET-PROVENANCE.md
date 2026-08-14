# Free Starter Channel Kits — Asset Provenance

This is the immutable provenance ledger for preview bytes that may be copied
into a Free Starter Channel Kit source pack. `migrated-approved-built-in`
means the checked-in Story Studio built-in preview is the approved migration
source. `owner-supplied-original` means an owner must provide the original
raster and its SHA-256 before that Kit can be authored.
Each approved record's `ownerId` is the exact legacy Style or Recipe
declaration authorized to select those bytes.

Prehistoric Discovery, Dreamscape Story Window, Centered Hero Headline, and
Portrait Block Right are deliberately blocked:
there is no raster path, no SHA-256, and no substitute preview. The First
Humans and Sleep Journeys kits must remain blocked until the corresponding
owner-supplied originals are added to this ledger.

<!-- free-starter-preview-provenance
[
  {"id":"builtin-waxy-outline-cartoon","ownerId":"builtin-waxy-outline-cartoon","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/waxy-outline-cartoon.webp","sha256":"d3597964cecae335b8f9b18dd6f589b9891cf5e07a84bd1015ca10c5d0a94010"},
  {"id":"builtin-prehistoric-stick-cartoon","ownerId":"builtin-prehistoric-stick-cartoon","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/prehistoric-stick-cartoon.webp","sha256":"332f2620384aabf367f76380cd991a33f3abd44efc63abe3ea3a3e06bb68f096"},
  {"id":"builtin-paleo-documentary-tableau","ownerId":"builtin-paleo-documentary-tableau","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/paleo-documentary-tableau.webp","sha256":"5d2daa07445802fcd32d953ce79627d1d305d17a200c98de24be4c59bed68a64"},
  {"id":"builtin-hand-drawn-editorial-diagram","ownerId":"builtin-hand-drawn-editorial-diagram","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/hand-drawn-editorial-diagram.webp","sha256":"f77e53d89e1278f107b9f81483de4e422444b6c2221ea3fc248d7dd96e73b1fe"},
  {"id":"builtin-minimal-stick-figure-explainer","ownerId":"builtin-minimal-stick-figure-explainer","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/minimal-stick-figure-explainer.webp","sha256":"9a6c9d494566a2a6e053595004f973776bde9886beab135feb00ded7426d8a88"},
  {"id":"builtin-sepia-ink-wash","ownerId":"builtin-sepia-ink-wash","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/sepia-ink-wash.webp","sha256":"eb45b547bd057a05579fc9d140158dcfa0309b5b96d87ce8cbf366053fa4a3ae"},
  {"id":"builtin-cinematic-photoreal","ownerId":"builtin-cinematic-photoreal","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/cinematic-photoreal.webp","sha256":"667b99a21264de8f6c2738b739df3ed77034a6cc3357458191a6a0cd569feeb0"},
  {"id":"builtin-watercolor-storybook","ownerId":"builtin-watercolor-storybook","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/watercolor-storybook.webp","sha256":"9c65c85f58f714941a9181b87ee6f5cecb4f21814272775d6c32282ed3ac1534"},
  {"id":"builtin-flat-vector-explainer","ownerId":"builtin-flat-vector-explainer","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/builtin-style-previews/flat-vector-explainer.webp","sha256":"2c6cd5d6d9a90fb3f8e8557b6ac6477e1d74d0316cb34544afdc286f7ac55bce"},
  {"id":"curiosity-question-cartoon-poison-or-cure","ownerId":"curiosity-question-cartoon","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-poison-or-cure.webp","sha256":"7db7035bf150ff038dd66e09ee1b64bb5dd9c25e6a0e5bf5dd07693887a9d331"},
  {"id":"curiosity-question-cartoon-too-smart","ownerId":"curiosity-question-cartoon","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-too-smart.webp","sha256":"63a39f11109f0ca2eb2c5f4281f29e24b9f9b6a417cb398c1832d356ed5a15a0"},
  {"id":"curiosity-question-cartoon-silent-killer","ownerId":"curiosity-question-cartoon","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/curiosity-question-cartoon-silent-killer.webp","sha256":"23104abd2f2b670b6f891f1dd4d3f024c82a7ad2ef4db22859461b4344bd5820"},
  {"id":"documentary-label-tableau-sleep","ownerId":"documentary-label-tableau","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/documentary-label-tableau-sleep.webp","sha256":"5e3a64298145f243dfea3a6687440962fc298d8b3290a8ff29bac3447b1cf491"},
  {"id":"documentary-label-tableau-giants","ownerId":"documentary-label-tableau","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/documentary-label-tableau-giants.webp","sha256":"46ba43a45b2c14ac15364af2fab5ff50798f6335baee3beeadef7727aa51de27"},
  {"id":"documentary-label-tableau-rift","ownerId":"documentary-label-tableau","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/documentary-label-tableau-rift.webp","sha256":"a7ea66ddb743ccc93ed3536ecddca248fa9187d4fa9eeced0377970536a0e4a2"},
  {"id":"annotated-business-board-coffee","ownerId":"annotated-business-board","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/annotated-business-board-coffee.webp","sha256":"7b0a222dcf0ca1d558d5ebfa28300ec9be201d8ddcbe70259c0fb05fc57da1e8"},
  {"id":"annotated-business-board-workshop","ownerId":"annotated-business-board","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/annotated-business-board-workshop.webp","sha256":"ee08f477759b2dbc1ddc1df4a3560e3c030523858f23f396b67730c3b7240328"},
  {"id":"annotated-business-board-hotel","ownerId":"annotated-business-board","provenance":"migrated-approved-built-in","status":"approved","sourcePath":"frontend/public/thumbnail-recipe-previews/annotated-business-board-hotel.webp","sha256":"29064f0bd0b38e59883db2ee8f1c66f428c10a3afbca02ca488c9adaf758c2fe"},
  {"id":"centered-hero-headline","ownerId":"centered-hero-headline","provenance":"owner-supplied-original","status":"blocked-missing-owner-original","sourcePath":null,"sha256":null},
  {"id":"portrait-block-right","ownerId":"portrait-block-right","provenance":"owner-supplied-original","status":"blocked-missing-owner-original","sourcePath":null,"sha256":null},
  {"id":"prehistoric-discovery","provenance":"owner-supplied-original","status":"blocked-missing-owner-original","sourcePath":null,"sha256":null},
  {"id":"dreamscape-story-window","provenance":"owner-supplied-original","status":"blocked-missing-owner-original","sourcePath":null,"sha256":null}
]
-->
