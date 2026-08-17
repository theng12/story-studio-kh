<template>
  <div v-if="findings" class="subtitle-quality">
    <WorkspaceNotice tone="warning" :title="title">
      {{ summary }}
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
    </WorkspaceNotice>
    <ul class="sq-findings">
      <li v-for="(f, i) in quality!.findings" :key="`${f.rule}-${f.cue}-${i}`" class="sq-finding">
        <span class="sq-cue">#{{ f.cue }}</span>
        <span class="sq-at">{{ formatClock(f.start_sec) }}</span>
        <span class="sq-rule">{{ f.label }}</span>
        <span class="sq-text" dir="ltr">{{ f.text }}</span>
      </li>
      <li v-if="quality!.truncated" class="sq-finding sq-more">
        Showing the first {{ quality!.findings.length }} — more cues are affected.
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * Shows likely transcript corruption for one subtitle file, wherever a person
 * is about to act on that transcript.
 *
 * Deliberately advisory: it renders a warning and an optional action, and never
 * disables or gates anything around it. A person may knowingly ship a caption
 * with an odd character in it, and turning this into a blocker is a decision
 * the owner has not made.
 *
 * It also shows the offending cues rather than a count, because a count cannot
 * be judged. Seeing "#37 · 马 West outside The gust," settles the question in a
 * second; "3 issues found" starts an investigation.
 */
import type { SubtitleQualityReport } from '~/types/subtitle-quality'
import { hasQualityFindings } from '~/types/subtitle-quality'

const props = withDefaults(defineProps<{
  quality: SubtitleQualityReport | null | undefined
  /** What is being reported on, e.g. "Chapter 04" or "This transcript". */
  subject?: string
  /**
   * Why it matters here. Each surface says something different: a caption is
   * cosmetic, a transcript feeding Scene Plan buys wrong pictures.
   */
  consequence?: string
}>(), {
  subject: 'This transcript',
  consequence: '',
})

const findings = computed(() => hasQualityFindings(props.quality))

const title = computed(() => `${props.subject} may contain garbled text`)

const summary = computed(() => {
  const q = props.quality!
  const cues = q.affected_cues === 1 ? '1 cue' : `${q.affected_cues} cues`
  const of = q.cues ? ` of ${q.cues}` : ''
  const base = `${cues}${of} look like transcription errors rather than speech.`
  const tail = 'Nothing has been changed — re-transcribe if the lines below look wrong.'
  return props.consequence ? `${base} ${props.consequence} ${tail}` : `${base} ${tail}`
})

function formatClock(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
</script>

<style scoped>
.subtitle-quality {
  margin-top: var(--space-3);
}

/* The notice owns the top margin for the pair; the list continues it as one
   block rather than reading as a second, unrelated panel. */
.subtitle-quality :deep(.workspace-notice) {
  margin-top: 0;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.sq-findings {
  margin: 0;
  padding: 8px 16px;
  border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--border));
  border-top: 0;
  border-bottom-left-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
  background: var(--bg-secondary);
  list-style: none;
}

.sq-finding {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  font-size: var(--font-sm);
  line-height: 1.45;
}

.sq-finding + .sq-finding {
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}

.sq-cue,
.sq-at {
  flex: none;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.sq-cue {
  font-weight: 600;
}

.sq-rule {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--text-primary);
  font-size: var(--font-xs);
}

/* The offending text is the evidence, so it gets the readable treatment: a
   mono face makes a stray combining mark or zero-width space visible instead
   of letting it hide inside proportional spacing. */
.sq-text {
  flex: 1 1 240px;
  min-width: 0;
  color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow-wrap: anywhere;
}

.sq-more {
  color: var(--text-secondary);
  font-style: italic;
}
</style>
