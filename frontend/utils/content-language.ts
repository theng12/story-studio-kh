/**
 * The audience languages Story Studio supports — the ONE list every language picker reads.
 *
 * The values mirror the backend's `ContentLanguage` ('en' | 'km'). This module exists so the channel
 * Settings picker, the New Channel wizard and the thumbnail text editor's language selector cannot
 * drift into three different lists; add a language here once and every picker gains it.
 */

export type ContentLanguage = 'en' | 'km'

export interface ContentLanguageOption {
  value: ContentLanguage
  label: string
}

export const CONTENT_LANGUAGE_OPTIONS: readonly ContentLanguageOption[] = [
  { value: 'en', label: 'English' },
  { value: 'km', label: 'Khmer' },
]

/** The human label for a language code, or '' when it is not one the app supports. */
export function contentLanguageLabel(value: string | null | undefined): string {
  return CONTENT_LANGUAGE_OPTIONS.find(option => option.value === value)?.label || ''
}
