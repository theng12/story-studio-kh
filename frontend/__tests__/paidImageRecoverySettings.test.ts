import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const settingsPath = '/app-settings/paid-image-replacement'
const subtitleSettingsPath = '/app-settings/paid-subtitle-replacement'
const audioSettingsPath = '/app-settings/paid-audio-replacement'
const writingSettingsPath = '/app-settings/paid-writing-replacement'

interface PaidImageReplacementSetting {
  enabled: boolean
  additional_credit_ceiling: number | null
}

interface SettingsApi {
  get<T>(path: string): Promise<T>
  put<T>(path: string, body: unknown): Promise<T>
  del(path: string): Promise<void>
  post(path: string, body: unknown): Promise<unknown>
}

const apiHost = globalThis as typeof globalThis & { __paidImageRecoverySettingsApi?: SettingsApi }

async function loadThisMacSettings(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/ThisMacSettings.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'paid-image-recovery-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'paid-image-recovery-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, reactive, onMounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__paidImageRecoverySettingsApi
    const useConfirm = () => ({ ask: async () => true })
    const useTheme = () => ({ mode: ref('system'), setMode: () => undefined })
    const useConnectionStatus = () => ({ connection: { value: { tone: 'online', label: 'Gateway connected', hint: '' } }, gatewayDown: { value: false }, refresh: async () => undefined })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountSettings(
  setting: PaidImageReplacementSetting,
  options: { paidSettingError?: Error; savedSetting?: PaidImageReplacementSetting } = {},
) {
  const saves: Array<{ path: string; body: unknown }> = []
  apiHost.__paidImageRecoverySettingsApi = {
    async get<T>(path: string): Promise<T> {
      if ([settingsPath, subtitleSettingsPath, audioSettingsPath, writingSettingsPath].includes(path)) {
        if (options.paidSettingError) throw options.paidSettingError
        return setting as T
      }
      if (path === '/app-settings/concurrency') return {
        subtitle_episode_concurrency: 2, llm_concurrency: 8, image_episode_concurrency: 2,
        image_fanout_per_episode: 'auto', thumbnail_episode_concurrency: 3, outline_chapter_headroom: 2,
        genstudio_language_timeout_minutes: 30, language_floor_tokens_per_second: 25,
        language_preferred_tokens_per_second: 50,
      } as T
      if (path === '/app-settings/genstudio') return { url: '', default_url: '' } as T
      if (path === '/app-settings/api-keys') return { providers: [] } as T
      if (path === '/app-settings/emoji') return { allow_emoji_in_generated_text: false } as T
      throw new Error(`unexpected GET ${path}`)
    },
    async put<T>(path: string, body: unknown): Promise<T> {
      saves.push({ path, body })
      if (![settingsPath, subtitleSettingsPath, audioSettingsPath, writingSettingsPath].includes(path)) throw new Error(`unexpected PUT ${path}`)
      return (options.savedSetting || { enabled: true, additional_credit_ceiling: 50 }) as T
    },
    async del(): Promise<void> {},
    async post(): Promise<unknown> { return undefined },
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadThisMacSettings())
  app.component('ServerModeSettingsPanel', defineComponent({ setup: () => () => h('div') }))
  app.mount(host)
  await flush()
  return { host, saves, unmount: () => app.unmount() }
}

test('This Mac keeps paid image replacement off until a positive whole-number ceiling is saved', async () => {
  const rendered = await mountSettings(
    { enabled: false, additional_credit_ceiling: null },
    { savedSetting: { enabled: true, additional_credit_ceiling: 37 } },
  )
  try {
    const section = rendered.host.querySelector<HTMLElement>('.paid-image-replacement')
    assert.ok(section, 'the dedicated paid image replacement setting is rendered')
    assert.match(section.textContent || '', /Automatically finish failed images/)
    // Same facts as before, in the owner's words (shell audit 2026-10-03): check first, never guess
    // from time, free retries until done or stopped, paid replacement after 30 min within the limit.
    assert.match(section.textContent || '', /first checks the original request really failed/i)
    assert.match(section.textContent || '', /never guesses from time alone/i)
    assert.match(section.textContent || '', /failure that cost nothing is retried, with a pause between tries, until the image finishes or you pause, cancel, or turn this off/i)
    assert.match(section.textContent || '', /failure that already used credits/i)
    assert.match(section.textContent || '', /waits 30 minutes/i)
    assert.match(section.textContent || '', /re-checks the price/i)
    assert.match(section.textContent || '', /within the credit limit you set here/i)
    assert.match(section.textContent || '', /maximum 1 per image/i)

    const enabled = section.querySelector<HTMLSelectElement>('select[name="paid-image-replacement-enabled"]')
    assert.ok(enabled, 'the setting has a native labeled Off/On control')
    assert.equal(enabled.value, 'false', 'an absent ceiling starts Off rather than guessing a budget')
    assert.equal(section.querySelector('input[name="paid-image-replacement-ceiling"]'), null, 'Off has no ceiling field')

    enabled.value = 'true'
    enabled.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const ceiling = section.querySelector<HTMLInputElement>('input[name="paid-image-replacement-ceiling"]')
    assert.ok(ceiling, 'enabling requires an explicit ceiling')
    assert.equal(ceiling.min, '1')
    assert.equal(ceiling.step, '1')
    section.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    assert.equal(rendered.saves.length, 0, 'an empty enabled ceiling cannot reach the spending endpoint')
    assert.match(section.textContent || '', /positive whole number/i)

    ceiling.value = '50'
    ceiling.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    section.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    assert.deepEqual(rendered.saves, [{
      path: settingsPath,
      body: { enabled: true, additional_credit_ceiling: 50 },
    }], 'the independent setting save sends only the flat approved body')
    assert.equal(ceiling.value, '37', 'the server echo replaces the submitted draft')
    assert.match(section.textContent || '', /saved/i)
  } finally {
    rendered.unmount()
    delete apiHost.__paidImageRecoverySettingsApi
  }
})

test('This Mac keeps paid image replacement disabled when its saved state is unknown', async () => {
  const rendered = await mountSettings(
    { enabled: false, additional_credit_ceiling: null },
    { paidSettingError: new Error('settings unavailable') },
  )
  try {
    const section = rendered.host.querySelector<HTMLElement>('.paid-image-replacement')
    assert.ok(section)
    const select = section.querySelector<HTMLSelectElement>('select')
    assert.equal(select?.disabled, true)
    assert.equal(select?.value, '__unknown')
    assert.match(select?.selectedOptions[0]?.textContent || '', /saved state unavailable/i)
    assert.equal(section.querySelector<HTMLButtonElement>('button')?.disabled, true)
    assert.match(section.textContent || '', /could not load.*paid image replacement/i)
    assert.equal(rendered.saves.length, 0)
  } finally {
    rendered.unmount()
    delete apiHost.__paidImageRecoverySettingsApi
  }
})

test('This Mac keeps paid subtitle replacement separately off until its own ceiling is saved', async () => {
  const rendered = await mountSettings(
    { enabled: false, additional_credit_ceiling: null },
    { savedSetting: { enabled: true, additional_credit_ceiling: 17 } },
  )
  try {
    const section = rendered.host.querySelector<HTMLElement>('.paid-subtitle-replacement')
    assert.ok(section, 'the subtitle policy must be separately visible')
    assert.match(section.textContent || '', /Automatically buy one replacement for a confirmed failed subtitle section/)
    const enabled = section.querySelector<HTMLSelectElement>('select[name="paid-subtitle-replacement-enabled"]')
    assert.equal(enabled?.value, 'false')
    enabled!.value = 'true'
    enabled!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    const ceiling = section.querySelector<HTMLInputElement>('input[name="paid-subtitle-replacement-ceiling"]')
    assert.ok(ceiling)
    ceiling.value = '17'
    ceiling.dispatchEvent(new Event('input', { bubbles: true }))
    section.querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    assert.deepEqual(rendered.saves, [{
      path: subtitleSettingsPath,
      body: { enabled: true, additional_credit_ceiling: 17 },
    }])
  } finally {
    rendered.unmount()
    delete apiHost.__paidImageRecoverySettingsApi
  }
})

test('This Mac keeps paid audio and writing replacement separately off until each hard ceiling is saved', async () => {
  const rendered = await mountSettings(
    { enabled: false, additional_credit_ceiling: null },
    { savedSetting: { enabled: true, additional_credit_ceiling: 23 } },
  )
  try {
    for (const replacement of [
      { className: '.paid-audio-replacement', path: audioSettingsPath, name: 'audio' },
      { className: '.paid-writing-replacement', path: writingSettingsPath, name: 'writing' },
    ]) {
      const section = rendered.host.querySelector<HTMLElement>(replacement.className)
      assert.ok(section, `${replacement.name} recovery is separately visible`)
      assert.match(section.textContent || '', new RegExp(`Automatically buy one replacement for a confirmed failed ${replacement.name}`, 'i'))
      assert.match(section.textContent || '', /first checks the original request really failed/i)
      assert.match(section.textContent || '', /only within the credit limit you set here/i)
      assert.match(section.textContent || '', /Maximum 1 replacement per confirmed failed/i)
      const enabled = section.querySelector<HTMLSelectElement>('select')
      assert.equal(enabled?.value, 'false')
      enabled!.value = 'true'
      enabled!.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      const ceiling = section.querySelector<HTMLInputElement>('input[type="number"]')
      assert.ok(ceiling, `${replacement.name} needs an explicit hard ceiling when enabled`)
      section.querySelector<HTMLButtonElement>('button')!.click()
      await flush()
      assert.equal(rendered.saves.filter(save => save.path === replacement.path).length, 0, 'a missing ceiling cannot submit')
      ceiling.value = '23'
      ceiling.dispatchEvent(new Event('input', { bubbles: true }))
      section.querySelector<HTMLButtonElement>('button')!.click()
      await flush()
    }
    assert.deepEqual(rendered.saves, [
      { path: audioSettingsPath, body: { enabled: true, additional_credit_ceiling: 23 } },
      { path: writingSettingsPath, body: { enabled: true, additional_credit_ceiling: 23 } },
    ])
  } finally {
    rendered.unmount()
    delete apiHost.__paidImageRecoverySettingsApi
  }
})

async function renderPublicPaidImageAttempt(job: Record<string, unknown>): Promise<string> {
  const jobs = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8')
  const formatterStart = jobs.indexOf('function paidImageReplacementAttemptText')
  const formatterEnd = jobs.indexOf('\nfunction genStudioNumeric', formatterStart)
  const templateStart = jobs.indexOf('<p v-if="paidImageReplacementAttemptText(job)" class="paid-image-replacement-attempt" role="status">')
  const templateEnd = jobs.indexOf('</p>', templateStart) + '</p>'.length
  assert.notEqual(formatterStart, -1)
  assert.notEqual(formatterEnd, -1)
  assert.notEqual(templateStart, -1)
  const template = compileTemplate({ source: jobs.slice(templateStart, templateEnd), filename: 'jobs-paid-image-attempt.vue', id: 'jobs-paid-image-attempt' })
  const vueUrl = await import.meta.resolve('vue')
  const source = `
    import { formatCredits } from ${JSON.stringify(new URL('../utils/genstudio-credit-cost.ts', import.meta.url).href)}
    const formatTime = (value: string) => 'at ' + value
    ${jobs.slice(formatterStart, formatterEnd)}
    ${template.code}
    const component = { props: ['job'], methods: { paidImageReplacementAttemptText }, render }
    export default component
  `
  const compiled = await transform(source, { loader: 'ts', format: 'esm' })
  const component = (await import(`data:text/javascript;base64,${Buffer.from(
    compiled.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default as Component
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, { job: { paid_image_replacement_attempt: job } })
  app.mount(host)
  await flush()
  const text = host.textContent || ''
  app.unmount()
  host.remove()
  return text
}

test('Jobs renders safe public Task5 replacement outcomes', async () => {
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'waiting', eligible_at: 'wait-at' }),
    'Paid image replacement is waiting until at wait-at.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'blocked', eligible_at: 'wait-at', reason: 'automatic_replacement_unavailable' }),
    'Paid image replacement was blocked: Automatic replacement was not available.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'committed', eligible_at: 'wait-at', replacement_committed_at: 'commit-at', quoted_credits: 4, price_version: 'mock-image-price-v1' }),
    'Paid image replacement was committed at commit-at. 4 credits at published price version mock-image-price-v1.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'submitted', eligible_at: 'wait-at', quoted_credits: 1, price_version: 'mock-image-price-v1' }),
    'Paid image replacement was submitted. 1 credit at published price version mock-image-price-v1.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'failed', eligible_at: 'wait-at', actual_settled_credits: 3 }),
    'Paid image replacement failed. Actual settled credits: 3 credits.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'succeeded', eligible_at: 'wait-at', actual_settled_credits: 4 }),
    'Paid image replacement succeeded. Actual settled credits: 4 credits.',
  )
})
