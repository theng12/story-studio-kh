/**
 * One "↻ Regenerate" for a chapter, wherever it is shown (Outline tab and
 * Script tab). Same confirm, same request, same wording, and the button stays
 * busy for as long as the chapter's job is queued or running — not just while
 * the request is being sent.
 */
import { ref } from 'vue'
import { useApi } from './useApi.js'
import { useConfirm } from './useConfirm.js'
import { useToast } from './useToast.js'
import { useJobs } from './useJobs.js'
import { useFreshGenerationAction, UNCONFIRMED_SUBMISSION } from './useFreshGenerationAction.js'

export interface ChapterRegenerateInput {
  projectSlug: string
  episodeId: string
  title?: string
  /** The script form: model, style, length, chapters, total_words, words_per_chapter. */
  form?: Record<string, any> | null
  chapter: number
  /** A per-row word target; blank uses the form default. */
  words?: number | null
  /** e.g. save pending outline edits so the rewrite sees them. */
  beforeSend?: () => Promise<void>
}

export const REGENERATE_LABEL = '↻ Regenerate'
export const REGENERATING_LABEL = 'Regenerating…'
export const REGENERATE_HINT = 'Write this chapter again from its outline entry (asks first)'

export function useChapterRegenerate() {
  const { post } = useApi()
  const { ask } = useConfirm()
  const { success, error: showError, showAction } = useToast()
  const { jobs } = useJobs()
  const action = useFreshGenerationAction()
  const sending = ref<Set<string>>(new Set())
  const key = (episodeId: string, chapter: number) => `${episodeId}:${chapter}`

  function isRegenerating(episodeId: string, chapter: number): boolean {
    if (sending.value.has(key(episodeId, chapter))) return true
    return jobs.value.some(job => job.type === 'chapter-only'
      && job.episode_id === episodeId
      && Number(job.params?.chapter_number) === chapter
      && (job.status === 'queued' || job.status === 'running' || job.status === 'paused'))
  }

  async function regenerate(input: ChapterRegenerateInput, confirmed = false): Promise<void> {
    const { chapter, episodeId } = input
    if (isRegenerating(episodeId, chapter)) return
    if (!confirmed && !await ask({
      title: `Regenerate chapter ${chapter}?`,
      message: `Chapter ${chapter} is written again from its outline entry and replaces the current text. `
        + 'Narration made from the old text will need regenerating on the Audio page.',
      confirmLabel: 'Regenerate chapter',
    })) return
    const id = key(episodeId, chapter)
    sending.value = new Set([...sending.value, id])
    try {
      await input.beforeSend?.()
      const words = typeof input.words === 'number' && Number.isFinite(input.words) && input.words > 0
        ? Math.round(input.words) : null
      const payload = {
        episode_id: episodeId,
        title: input.title || '',
        chapter_number: chapter,
        model: input.form?.model,
        style: input.form?.style,
        length: input.form?.length,
        chapters: input.form?.chapters,
        total_words: input.form?.total_words,
        words_per_chapter: words ?? input.form?.words_per_chapter,
      }
      const operationId = action.begin(payload, `chapter:${chapter}`)
      await post(`/projects/${input.projectSlug}/generate/chapter-only`, { ...payload, operation_id: operationId })
      action.complete(operationId)
      success(words ? `Chapter ${chapter} regenerate queued at ${words} words` : `Chapter ${chapter} regenerate queued`)
    } catch (e: any) {
      if (e?.data?.detail) showError(e.data.detail)
      else showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => regenerate(input, true), 'error')
    } finally {
      const next = new Set(sending.value)
      next.delete(id)
      sending.value = next
    }
  }

  return { regenerate, isRegenerating }
}
