/**
 * "Generate the script first to unlock this generator" was shown when a script existed but was
 * unfinished, which sent the owner to generate something he already had. Both gated pages now say
 * "No finished script yet" and give a one-click way to the Script Generator for that episode.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

for (const page of ['metadata', 'image-prompts']) {
  test(`${page}: the script gate says "No finished script yet" and links to Script Generator`, () => {
    const source = read(`pages/projects/[slug]/${page}.vue`)
    assert.doesNotMatch(source, /Generate the script first to unlock this generator/)
    assert.match(source, /const noScriptTooltip = "No finished script yet — finish this episode's script in Script Generator first\."/)
    assert.match(source, /No finished script yet for <strong>/)
    assert.match(source, /:to="`\/projects\/\$\{slug\}\/scripts\?episode_id=\$\{encodeURIComponent\([^)]+\)\}`"[^>]*>Open Script Generator<\/NuxtLink>/)
  })
}
