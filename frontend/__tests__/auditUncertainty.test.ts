import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

async function loadDialog(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/MissingAssetsDialog.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'audit-uncertainty-dialog' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'audit-uncertainty-dialog',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `import { computed } from ${JSON.stringify(vueUrl)}`
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const url = `data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`
  return (await import(url)).default
}

const ModalStub = defineComponent({
  props: { visible: Boolean, labelledby: String },
  setup(props, { slots }) { return () => props.visible ? h('section', { role: 'dialog', 'aria-labelledby': props.labelledby }, slots.default?.()) : null },
})

const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
})

function report(stages: any[]) {
  return {
    project_slug: 'story', generated_at: '2026-09-20T00:00:00.000Z',
    episodes: [{ episode_code: 'EP0001', title: 'First episode', stages }],
    total_missing: stages.reduce((total, stage) => total + stage.missing.length, 0),
    episodes_with_missing: stages.some(stage => stage.missing.length) ? 1 : 0,
  }
}

async function mount(initialReport: any, busy = false) {
  document.body.innerHTML = ''
  const current = ref(initialReport)
  let rescans = 0
  const Dialog = await loadDialog()
  const app = createApp(defineComponent({
    setup: () => () => h(Dialog, {
      visible: true,
      busy,
      slug: 'story',
      report: current.value,
      onRescan: () => { rescans += 1 },
    }),
  }))
  app.component('Modal', ModalStub)
  app.component('NuxtLink', NuxtLinkStub)
  app.component('LoadingSpinner', defineComponent({ setup: () => () => null }))
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await nextTick()
  return { host, current, rescans: () => rescans, unmount: () => app.unmount() }
}

test('an unmeasurable stage stays uncertain until a re-scan measures it', async () => {
  const ui = await mount(report([{
    stage: 'audio', outcome: 'unmeasurable', started: false, expected: 0, present: 0,
    missing: [], extra: [], error: 'Could not measure audio assets. Check that project storage is connected and readable, then retry the audit.',
  }]))
  try {
    assert.match(ui.host.querySelector('h2')?.textContent || '', /Asset audit/)
    assert.equal(ui.host.querySelector('h2')?.id, 'mad-title')
    assert.equal(ui.host.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby'), 'mad-title')
    assert.match(ui.host.textContent || '', /Some audit checks could not be completed/)
    assert.match(ui.host.textContent || '', /Check that project storage is connected and readable, then retry the audit/)
    assert.doesNotMatch(ui.host.textContent || '', /All assets match the project manifest/)
    assert.equal(ui.host.querySelector('a'), null, 'an unknown audit result must not offer Repair')

    ;[...ui.host.querySelectorAll('button')].find(button => button.textContent === 'Re-scan audit')?.click()
    assert.equal(ui.rescans(), 1)

    ui.current.value = report([{
      stage: 'audio', outcome: 'measured', started: true, expected: 1, present: 1, missing: [], extra: [],
    }])
    await nextTick()
    assert.match(ui.host.textContent || '', /All assets match the project manifest/)
  } finally {
    ui.unmount()
  }
})

test('measured gaps remain repairable beside an unmeasurable stage', async () => {
  const ui = await mount(report([
    { stage: 'audio', outcome: 'unmeasurable', started: false, expected: 0, present: 0, missing: [], extra: [] },
    { stage: 'scenes', outcome: 'measured', started: true, expected: 2, present: 1, missing: ['EP0001_scene_002.png'], extra: [] },
  ]))
  try {
    assert.match(ui.host.textContent || '', /1 asset missing across 1 episode/)
    assert.match(ui.host.textContent || '', /Some audit checks could not be completed/)
    assert.equal(ui.host.querySelector('a')?.getAttribute('href'), '/projects/story/board?repair=1&episode=EP0001')
  } finally {
    ui.unmount()
  }
})

test('an active audit disables the dialog re-scan action', async () => {
  const ui = await mount(report([{
    stage: 'audio', outcome: 'unmeasurable', started: false, expected: 0, present: 0, missing: [], extra: [],
  }]), true)
  try {
    const rescan = [...ui.host.querySelectorAll('button')].find(button => button.textContent === 'Re-scan audit')
    assert.equal(rescan?.disabled, true)
    rescan?.click()
    assert.equal(ui.rescans(), 0)
  } finally {
    ui.unmount()
  }
})
