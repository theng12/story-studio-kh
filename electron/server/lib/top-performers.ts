/** Format a compact channel-performance block for LLM inspiration prompts. */
export function formatTopPerformersBlock(
  performers: Array<{ title: string; views: number; ctr_percentage?: number }>,
): string {
  if (!performers?.length) return ''
  const lines = performers.map((performer) => {
    const views = performer.views >= 1000
      ? `${Math.round(performer.views / 1000)}K views`
      : `${performer.views.toLocaleString()} views`
    const ctr = typeof performer.ctr_percentage === 'number'
      ? `, ${performer.ctr_percentage.toFixed(1)}% CTR`
      : ''
    return `  - "${performer.title}" (${views}${ctr})`
  }).join('\n')

  return `\n📈 TOP PERFORMERS ON THIS CHANNEL (recent):
${lines}

Use these as a vibe reference — match the angle, length, and emotional pull of these proven titles. Don't copy them verbatim, but the new output should feel at home alongside them.`
}
