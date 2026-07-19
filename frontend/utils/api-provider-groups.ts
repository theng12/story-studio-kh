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
  { id: 'llm', label: 'LLM', description: 'Writing, planning, metadata, and research.' },
  { id: 'audio', label: 'Audio', description: 'Narration, voice synthesis, and cloned voices.' },
  { id: 'image', label: 'Image', description: 'Still-image generation and image workflows.' },
  { id: 'video', label: 'Video', description: 'Video generation and licensed stock footage.' },
  { id: 'mix', label: 'Mix', description: 'Providers that serve several media types.' },
]

export const API_PROVIDER_META: ApiProviderMeta[] = [
  { id: 'openai', name: 'OpenAI', category: 'llm', helpText: 'Scripts, metadata, GPT models, and vision fallback.', placeholder: 'sk-proj-…' },
  { id: 'deepseek', name: 'DeepSeek', category: 'llm', helpText: 'Official DeepSeek text-generation API.', placeholder: 'sk-…', affiliateUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', category: 'llm', helpText: 'OpenAI-compatible gateway for multiple text models.', placeholder: 'sk-or-…', affiliateUrl: 'https://openrouter.ai/keys' },
  { id: 'perplexity', name: 'Perplexity', category: 'llm', helpText: 'Optional live-web research source.', placeholder: 'pplx-…', affiliateUrl: 'https://www.perplexity.ai/settings/api' },
  { id: 'elevenlabs', name: 'ElevenLabs', category: 'audio', helpText: 'Cloud voice synthesis for narration.', placeholder: 'xi-…' },
  { id: 'genstudio', name: 'GenStudio KH', category: 'audio', helpText: 'Qwen3 voice and transcription boundary. Include audio:transcribe; this never exposes your Studio Hub token.', placeholder: 'gsk_…' },
  { id: 'fishaudio', name: 'Fish Audio', category: 'audio', helpText: 'Cloud voice synthesis and cloned voices.', placeholder: '…', affiliateUrl: 'https://fish.audio/go-api/' },
  { id: 'fal', name: 'Fal.ai', category: 'image', helpText: 'Flux image generation, LoRA, and voice-cloning tools.', placeholder: 'fal-…' },
  { id: 'genaipro', name: 'GenAI Pro', category: 'video', helpText: 'Veo video generation with additional audio services.', placeholder: '…' },
  { id: 'pexels', name: 'Pexels', category: 'video', helpText: 'Free licensed stock-video search.', placeholder: '…', affiliateUrl: 'https://www.pexels.com/api/new/' },
  { id: 'pixabay', name: 'Pixabay', category: 'video', helpText: 'Free licensed stock-video search.', placeholder: '…', affiliateUrl: 'https://pixabay.com/api/docs/' },
  { id: 'kie', name: 'Kie.ai', category: 'mix', helpText: 'Text, image, and image-to-video generation gateway.', placeholder: 'kie-…' },
  { id: 'google', name: 'Google', category: 'mix', helpText: 'Selected Google AI Studio endpoints across media.', placeholder: '…' },
]

export function apiProvidersFor(category: ApiProviderCategory): ApiProviderMeta[] {
  return API_PROVIDER_META.filter(provider => provider.category === category)
}
