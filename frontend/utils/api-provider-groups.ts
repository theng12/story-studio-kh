export type ApiProviderCategory = 'llm' | 'audio' | 'image' | 'video' | 'mix'

export interface ApiProviderGroup {
  id: ApiProviderCategory
  label: string
  description: string
}

export interface ApiProviderMeta {
  id: string
  name: string
  category: ApiProviderCategory
  helpText?: string
  placeholder?: string
  affiliateUrl?: string
}

export const API_PROVIDER_GROUPS: ApiProviderGroup[] = [
  { id: 'mix', label: 'Gateway', description: 'The sole catalog, job, and credit boundary.' },
]

export const API_PROVIDER_META: ApiProviderMeta[] = [
  {
    id: 'genstudio',
    name: 'Gateway',
    category: 'mix',
    helpText: 'Sole LLM, image, voice/TTS, transcription, video, job, and credit boundary.',
    placeholder: 'gsk_…',
  },
]

export function apiProvidersFor(category: ApiProviderCategory): ApiProviderMeta[] {
  return API_PROVIDER_META.filter(provider => provider.category === category)
}
