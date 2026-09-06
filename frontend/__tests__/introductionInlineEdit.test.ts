import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'

type IntroPayload = {
  script: null
  introduction: { content: string; modifiedAt: string; wordCount: number } | null
}

async function loadComponent(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/IntroductionPreview.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'introduction-inline-editor' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'introduction-inline-editor',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, nextTick, ref, watch } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__introductionEditorApi
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function click(host: Element, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')]
    .find(candidate => candidate.textContent?.trim().includes(label))
  assert.ok(button, `button containing “${label}” must be rendered`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return button
}

describe('IntroductionPreview inline editor', () => {
  test('keeps episode drafts through refresh, switching, and a failed save', async () => {
    const payloads: Record<string, IntroPayload> = {
      EP0001: {
        script: null,
        introduction: { content: 'First saved introduction.', modifiedAt: '2026-09-06T08:00:00Z', wordCount: 3 },
      },
      EP0002: {
        script: null,
        introduction: { content: 'Second saved introduction.', modifiedAt: '2026-09-06T08:00:00Z', wordCount: 3 },
      },
    }
    const writes: Array<{ path: string; body: { text: string } }> = []
    let failNextSave = true
    let holdNextRefresh = false
    let resolveRefresh: ((value: IntroPayload) => void) | null = null
    ;(globalThis as any).__introductionEditorApi = {
      get: async (apiPath: string) => {
        const payload = structuredClone(payloads[apiPath.includes('EP0002') ? 'EP0002' : 'EP0001'])
        if (holdNextRefresh) {
          holdNextRefresh = false
          return new Promise<IntroPayload>((resolve) => { resolveRefresh = resolve })
        }
        return payload
      },
      put: async (apiPath: string, body: { text: string }) => {
        writes.push({ path: apiPath, body })
        if (failNextSave) {
          failNextSave = false
          throw Object.assign(new Error('disk full'), { data: { detail: 'Could not save the introduction.' } })
        }
        const introduction = {
          content: body.text,
          modifiedAt: '2026-09-06T09:00:00Z',
          wordCount: body.text.split(/\s+/).length,
        }
        payloads.EP0001 = { script: null, introduction }
        return { ok: true, introduction }
      },
    }

    const Preview = await loadComponent()
    const episodeId = ref('EP0001')
    const savingChanges: boolean[] = []
    const Root = defineComponent({
      setup: () => () => h(Preview, {
        projectSlug: 'demo',
        episodeId: episodeId.value,
        onSavingChange: (saving: boolean) => savingChanges.push(saving),
      }),
    })
    document.body.innerHTML = ''
    const host = document.body.appendChild(document.createElement('div'))
    const app = createApp(Root)
    app.component('LoadingSpinner', { render: () => h('span', 'Loading') })
    app.mount(host)
    await flush()

    click(host, 'Edit')
    await nextTick()
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(textarea)
    assert.equal(document.activeElement, textarea, 'Edit moves keyboard focus into the narration')
    textarea.value = 'My unsaved first-episode edit.'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    assert.match(host.textContent || '', /Unsaved edits/)

    holdNextRefresh = true
    click(host, 'Refresh')
    await nextTick()
    const saveWhileRefreshing = [...host.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'Save') as HTMLButtonElement
    assert.equal(saveWhileRefreshing.disabled, true,
      'Save waits for an older refresh so it cannot later overwrite the saved preview')
    assert.ok(resolveRefresh)
    resolveRefresh(structuredClone(payloads.EP0001))
    await flush()
    assert.equal((host.querySelector('textarea') as HTMLTextAreaElement).value,
      'My unsaved first-episode edit.', 'refresh must not overwrite a draft')

    episodeId.value = 'EP0002'
    await flush()
    assert.match(host.textContent || '', /Second saved introduction/)
    episodeId.value = 'EP0001'
    await flush()
    assert.equal((host.querySelector('textarea') as HTMLTextAreaElement).value,
      'My unsaved first-episode edit.', 'switching away and back must restore that episode draft')

    click(host, 'Save')
    await flush()
    assert.equal((host.querySelector('textarea') as HTMLTextAreaElement).value,
      'My unsaved first-episode edit.', 'a failed save must leave the draft editable')
    assert.match(host.textContent || '', /Could not save the introduction/)
    const saveAlert = host.querySelector('[role="alert"]') as HTMLElement
    assert.ok(saveAlert)
    assert.equal(saveAlert.closest('.preview-body'), null,
      'save errors stay visible below the scrolling editor rather than falling beneath its viewport')
    assert.deepEqual(savingChanges, [true, false], 'the parent action is held only while the PUT is active')

    click(host, 'Save')
    await flush()
    assert.deepEqual(writes.at(-1), {
      path: '/projects/demo/episodes/EP0001/introduction-content',
      body: { text: 'My unsaved first-episode edit.' },
    })
    assert.equal(host.querySelector('textarea'), null)
    assert.match(host.textContent || '', /My unsaved first-episode edit/)
    assert.deepEqual(savingChanges, [true, false, true, false])

    click(host, 'Edit')
    await nextTick()
    const cancelled = host.querySelector('textarea') as HTMLTextAreaElement
    cancelled.value = 'Discard this.'
    cancelled.dispatchEvent(new Event('input', { bubbles: true }))
    click(host, 'Cancel')
    await nextTick()
    assert.equal(host.querySelector('textarea'), null)
    assert.match(host.textContent || '', /My unsaved first-episode edit/)
    assert.equal(document.activeElement?.textContent?.trim(), 'Edit', 'Cancel returns focus to Edit')

    app.unmount()
    delete (globalThis as any).__introductionEditorApi
  })

  test('keys in-flight reads by project as well as episode and shows refresh failures', async () => {
    let resolveFirst: ((value: IntroPayload) => void) | null = null
    ;(globalThis as any).__introductionEditorApi = {
      get: (apiPath: string) => {
        if (apiPath.includes('/projects/first/')) {
          return new Promise<IntroPayload>((resolve) => { resolveFirst = resolve })
        }
        throw Object.assign(new Error('offline'), { data: { detail: 'Could not load this introduction.' } })
      },
      put: async () => { throw new Error('not used') },
    }

    const Preview = await loadComponent()
    const projectSlug = ref('first')
    const Root = defineComponent({
      setup: () => () => h(Preview, { projectSlug: projectSlug.value, episodeId: 'EP0001' }),
    })
    document.body.innerHTML = ''
    const host = document.body.appendChild(document.createElement('div'))
    const app = createApp(Root)
    app.component('LoadingSpinner', { render: () => h('span', 'Loading') })
    app.mount(host)
    await nextTick()

    projectSlug.value = 'second'
    await flush()
    assert.match(host.textContent || '', /Could not load this introduction/)

    assert.ok(resolveFirst)
    resolveFirst({
      script: null,
      introduction: { content: 'Wrong project content.', modifiedAt: '2026-09-06T08:00:00Z', wordCount: 3 },
    })
    await flush()
    assert.doesNotMatch(host.textContent || '', /Wrong project content/,
      'a late response for the previous project must not replace the active project')

    app.unmount()
    delete (globalThis as any).__introductionEditorApi
  })
})
