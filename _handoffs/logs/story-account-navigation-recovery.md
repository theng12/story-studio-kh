# Account navigation recovery

Started from `3b598be1` on `codex/account-navigation-recovery`.

## Delivered

- Unconfigured GenStudio standing strips are buttons that open the Connections
  settings section. Configured strips remain links to `/usage`.
- Usage and recoverable Content Store key/scope refusals expose a real
  connection-settings action. Network, payment, ownership, and signing-key
  failures retain their distinct recovery copy and do not offer credentials as
  a false cure.
- The project dashboard offers **Start with ideas** only when it has neither
  accepted ideas nor episode artifacts. Imported production continues to use
  its actual stage focus.
- The missing-channel prompt now names a Series Formula and reaches the
  Channel settings anchor.
- Content Store and project Settings live in the fixed sidebar footer. Settings
  remains the project settings route when a project is open; the global app
  modal is only used outside a project.
- An empty LLM catalog remains a search-miss-free empty catalog. After a
  successful settings read proves that the GenStudio key is missing, it offers
  the Connections action. A configured or indeterminate empty catalog uses
  neutral wording.

## Verification

The focused frontend lane passed: 160 tests, 0 failures.

```sh
npx tsx --import ./__tests__/setup.ts --test \
  ./__tests__/accountRecoveryNavigation.test.ts \
  ./__tests__/contentStore.test.ts \
  ./__tests__/contentStoreDetail.test.ts \
  ./__tests__/dashboardFooter.test.ts \
  ./__tests__/dashboardWorkspace.test.ts \
  ./__tests__/genStudioStandingStrip.test.ts \
  ./__tests__/modelMenus.test.ts \
  ./__tests__/modelSelectionGapVisible.test.ts
```

`git diff --check` passed. The Impeccable detector only reported pre-existing
side-border warnings in `ModelMenu.vue` and lower existing notices in
`ModelSelector.vue`; this change adds none.

Rendered against the isolated no-key backend at `127.0.0.1:63994` using Nuxt
on `3109` and `STORY_STUDIO_API_PROXY=http://127.0.0.1:63994/api`. The Ideas
screen rendered a **Set up GenStudio** button (not a usage link), footer utility
links, the Series Formula anchor, and the LLM picker’s **0 available** state
with the key-setup action.

## Integration note

This branch’s standalone `nuxi typecheck` currently reports only the four
expected `open('connections')` argument errors until the Settings implementation
lands its section-aware `useAppSettingsModal().open(section?)` API. Re-run it
after integrating that commit.
