<template>
  <Modal
    :visible="visible"
    size="sm"
    :z-index="1000"
    labelledby="ffmpeg-dialog-title"
    :close-on-backdrop="!installing"
    :close-on-escape="!installing"
    @close="dismiss"
  >
    <h3 id="ffmpeg-dialog-title">FFmpeg Required</h3>
    <p class="text-muted mt-1">
      FFmpeg is needed for audio merging and video generation.
      It was not detected on your system.
    </p>

    <div class="ffmpeg-options mt-2">
      <!-- Auto-download option -->
      <div class="ffmpeg-option" v-if="!installing && !installed">
        <button class="btn btn-primary" @click="installFFmpeg" style="width: 100%;">
          Download & Install FFmpeg Automatically
        </button>
        <p class="text-muted mt-1" style="font-size: var(--font-xs); text-align: center;">
          Downloads pre-built FFmpeg binaries (~80MB). Stored in app data folder.
        </p>
      </div>

      <!-- Manual install option -->
      <div class="ffmpeg-option mt-2" v-if="!installing && !installed">
        <p class="text-muted" style="font-size: 12px;">Or install manually:</p>
        <div class="manual-commands mt-1">
          <code v-if="isMac">brew install ffmpeg</code>
          <code v-else-if="isLinux">sudo apt install ffmpeg</code>
          <code v-else>Download from ffmpeg.org/download.html</code>
        </div>
        <button class="btn btn-secondary btn-sm mt-1" @click="recheckFFmpeg">
          I've installed it — check again
        </button>
      </div>

      <!-- Installing progress -->
      <div v-if="installing" class="ffmpeg-progress mt-2">
        <div class="progress-text">{{ progressMessage }}</div>
        <div class="progress-bar mt-1">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
        </div>
      </div>

      <!-- Installed success -->
      <div v-if="installed" class="ffmpeg-success mt-2">
        <span style="font-size: 24px;">&#10003;</span>
        <p>FFmpeg installed successfully!</p>
        <p class="text-muted" style="font-size: 12px;">Version: {{ installedVersion }}</p>
        <button class="btn btn-primary mt-2" @click="visible = false">Continue</button>
      </div>

      <!-- Error -->
      <div v-if="error" class="ffmpeg-error mt-2">
        <p style="color: var(--error);">{{ error }}</p>
        <button class="btn btn-secondary btn-sm mt-1" @click="error = ''; installing = false">Try Again</button>
      </div>
    </div>

    <div v-if="!installing && !installed" class="mt-2" style="text-align: right;">
      <button class="btn btn-secondary btn-sm" @click="dismiss">Skip for now</button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
const { get, post } = useApi()

const visible = ref(false)
const installing = ref(false)
const installed = ref(false)
const installedVersion = ref('')
const error = ref('')
const progressMessage = ref('Preparing...')
const progressPercent = ref(0)

const isMac = ref(false)
const isLinux = ref(false)

onMounted(async () => {
  // Detect platform (rough)
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = ua.includes('mac')
  isLinux.value = ua.includes('linux')

  // Check FFmpeg status
  try {
    const status = await get<any>('/ffmpeg/status')
    if (!status.installed) {
      visible.value = true
    }
  } catch {
    // Can't check — don't show dialog
  }
})

async function installFFmpeg() {
  installing.value = true
  error.value = ''
  progressMessage.value = 'Starting download…'
  progressPercent.value = 0

  // Poll backend install state every second so the bar reflects real
  // download / extract progress instead of sitting frozen for 1-5 min.
  const poll = setInterval(async () => {
    try {
      const p = await get<any>('/ffmpeg/install-progress')
      if (typeof p.percent === 'number') progressPercent.value = p.percent
      if (p.message) progressMessage.value = p.message
      if (p.status === 'done' || p.status === 'error' || p.status === 'idle') {
        clearInterval(poll)
      }
    } catch { /* best-effort */ }
  }, 1000)

  try {
    const result = await post<any>('/ffmpeg/install', {})

    if (result.ok && result.status?.installed) {
      installed.value = true
      installedVersion.value = result.status.version || 'unknown'
      progressPercent.value = 100
      progressMessage.value = 'Done!'
    } else {
      error.value = 'Installation completed but FFmpeg verification failed. Try manual install.'
    }
  } catch (e: any) {
    error.value = e.data?.detail || 'Download failed. Please try manual installation.'
  } finally {
    clearInterval(poll)
    installing.value = false
  }
}

async function recheckFFmpeg() {
  try {
    const status = await get<any>('/ffmpeg/status')
    if (status.installed) {
      installed.value = true
      installedVersion.value = status.version || 'unknown'
    } else {
      error.value = 'FFmpeg still not detected. Make sure it\'s in your system PATH.'
    }
  } catch (e: any) {
    error.value = 'Check failed.'
  }
}

function dismiss() {
  visible.value = false
}
</script>

<style scoped>
/* Overlay / container / focus-trap are owned by the shared Modal primitive.
   Only the inner progress/success/error affordances live here. */
.manual-commands {
  background: var(--bg-primary);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.manual-commands code {
  font-size: 13px;
  color: var(--accent);
}
.ffmpeg-progress .progress-text {
  font-size: 13px;
  color: var(--text-secondary);
}
.progress-bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}
.ffmpeg-success {
  text-align: center;
  color: var(--success);
}
.ffmpeg-error {
  text-align: center;
}
</style>
