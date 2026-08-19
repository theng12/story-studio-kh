<template>
  <div class="welcome-page">
    <main class="welcome-main">
      <section class="welcome-intro">
        <span class="welcome-eyebrow">{{ repointing ? 'Library not found' : 'Welcome to Story Studio' }}</span>
        <h1>{{ repointing ? 'Where is your Library now?' : 'Where should Story Studio keep your work?' }}</h1>
        <p v-if="repointing">
          Story Studio looked for <code>{{ missingPath }}</code> and it is not there. If it is on a
          drive that is not plugged in, connect it and press the button below — nothing has been
          lost. If you moved the folder, point Story Studio at its new home.
        </p>
        <p v-else>
          Everything Story Studio makes lives in one folder — your <strong>Library</strong>. One
          folder per channel, plus a place for shared files and one for finished videos. Put it
          wherever suits you: Documents, Desktop, Downloads, or an external drive.
        </p>
      </section>

      <section class="welcome-card">
        <label class="welcome-label" for="library-path">Library folder</label>
        <div class="welcome-row">
          <input
            id="library-path"
            v-model="chosen"
            class="input welcome-input"
            spellcheck="false"
            :disabled="creating"
            @input="checked = null"
            @keyup.enter="confirm"
          />
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="creating || picking"
            @click="browse"
          >{{ picking ? 'Opening…' : '📂 Browse' }}</button>
        </div>

        <!-- The layout is stated up front rather than discovered afterwards:
             he is choosing a place for three folders, not one. -->
        <div class="welcome-layout" aria-hidden="true">
          <code>{{ leafName }}/</code>
          <ul>
            <li><code>&lt;your channels&gt;/</code> <span>one folder each</span></li>
            <li><code>_Project Assets/</code> <span>files shared between channels</span></li>
            <li><code>Exports/</code> <span>finished videos</span></li>
          </ul>
        </div>

        <p v-if="problem" class="welcome-problem" role="alert">{{ problem }}</p>
        <p v-else-if="checked?.will_create" class="welcome-note">
          This folder does not exist yet — Story Studio will create it.
        </p>
        <p v-else-if="checked?.caution" class="welcome-caution">{{ checked.caution }}</p>
        <p v-else-if="checked?.ok" class="welcome-note">
          This folder already exists. Any channels already inside it will simply appear.
        </p>

        <div class="welcome-actions">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!chosen.trim() || creating"
            @click="confirm"
          >
            <LoadingSpinner v-if="creating" size="sm" />
            {{ creating ? 'Setting up…' : (repointing ? 'Use this folder' : 'Use this folder') }}
          </button>
        </div>

        <p class="welcome-fineprint">
          Nothing is created until you press the button, and you can move your Library later in
          Settings → Storage.
        </p>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * First run: choose the Library.
 *
 * *"i don't want our app on a new computer to use the default location. i want
 * to have a location defining at the app's start or something so that the user
 * can save it anywhere they wanted as long as they have access. this way, it
 * also means that i don't have to hunt for the story studio folder inside of
 * /user sth. better for me as i personally like to save stuff in download, or
 * document or just in desktop."*
 *
 * Two rules this screen exists to keep:
 *
 *   - It SUGGESTS, it does not impose. `~/Documents/Story Studio KH` is
 *     pre-filled because it is findable, and every character of it is editable.
 *   - It creates NOTHING until "Use this folder" is pressed. Browsing around,
 *     typing a path and changing your mind all leave the disk untouched, so
 *     nobody ends up with three abandoned Story Studio folders.
 */
import { pickFolder as pickFolderShared } from '~/composables/usePathPicker'

definePageMeta({ layout: false })
useAppTitle()

const { load, check, choose } = useLibrary()
const { error: showError } = useToast()

const chosen = ref('')
/** True when a Library was already chosen but cannot be found right now. */
const repointing = ref(false)
const missingPath = ref('')
const picking = ref(false)
const creating = ref(false)
const problem = ref('')
const checked = ref<{ ok: boolean; will_create?: boolean; reason?: string; caution?: string } | null>(null)

/** The folder name, for the little layout preview. */
const leafName = computed(() => {
  const parts = chosen.value.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || 'Story Studio KH'
})

onMounted(async () => {
  const status = await load()
  // v1.4.6 — a CONFIGURED library sends you home, EXCEPT when it is not there.
  //
  // That exception closes a lockout. With the Library missing there are no
  // projects, so Settings — which lives under /projects/:slug — cannot be
  // opened, and this screen was bouncing him straight back to the error page.
  // The only two ways to change the location were both unreachable.
  if (status?.configured && status.exists) return navigateTo('/', { replace: true })
  repointing.value = !!status?.configured
  missingPath.value = status?.configured && !status.exists ? status.path : ''
  chosen.value = (repointing.value ? status?.path : status?.suggested) || ''
})

async function browse() {
  picking.value = true
  problem.value = ''
  try {
    const picked = await pickFolderShared({
      title: 'Choose where to keep your Story Studio Library',
      button_label: 'Use This Folder',
      initial_path: chosen.value || undefined,
    })
    if (picked) {
      chosen.value = picked
      await validate()
    }
  } catch (e: any) {
    problem.value = e?.data?.detail || e?.message || 'Could not open the folder picker.'
  } finally {
    picking.value = false
  }
}

/** Judge the candidate without creating it. */
async function validate(): Promise<boolean> {
  try {
    const r = await check(chosen.value)
    checked.value = r
    problem.value = r.ok ? '' : (r.reason || 'That folder cannot be used.')
    return r.ok
  } catch (e: any) {
    problem.value = e?.data?.detail || e?.message || 'Could not check that folder.'
    return false
  }
}

async function confirm() {
  creating.value = true
  problem.value = ''
  try {
    if (!await validate()) return
    await choose(chosen.value)
    await navigateTo('/', { replace: true })
  } catch (e: any) {
    problem.value = e?.data?.detail || e?.message || 'Could not set up that folder.'
    showError(problem.value)
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.welcome-page { min-height: 100vh; background: var(--bg-primary); color: var(--text-primary); }
.welcome-main { margin: 0 auto; max-width: 720px; padding: 64px 24px; }
.welcome-eyebrow {
  color: var(--accent);
  display: block;
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.welcome-intro h1 { margin: 8px 0 12px; }
.welcome-intro p { color: var(--text-secondary); max-width: 60ch; }
.welcome-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-top: 28px;
  padding: 24px;
}
.welcome-label { display: block; font-weight: 600; margin-bottom: 8px; }
.welcome-row { display: flex; gap: 8px; }
.welcome-input { flex: 1; font-family: ui-monospace, monospace; }
.welcome-layout {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-top: 16px;
  padding: 12px 16px;
}
.welcome-layout ul { list-style: none; margin: 6px 0 0; padding-left: 18px; }
.welcome-layout li { color: var(--text-secondary); padding: 2px 0; }
.welcome-layout li span { margin-left: 8px; }
.welcome-problem { color: var(--danger); margin-top: 14px; }
.welcome-note { color: var(--text-secondary); margin-top: 14px; }
.welcome-caution { color: var(--warning); margin-top: 14px; }
.welcome-actions { margin-top: 20px; }
.welcome-fineprint { color: var(--text-secondary); font-size: 13px; margin-top: 14px; }
</style>
