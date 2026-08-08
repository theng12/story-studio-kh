export function formatMetadataTxt(meta: { title: string; description: string; tags: string[] }): string {
  const tags = (meta.tags || []).join(', ')
  return [
    '=== TITLE ===',
    meta.title || '',
    '',
    '=== DESCRIPTION ===',
    meta.description || '',
    '',
    '=== TAGS ===',
    tags,
    '',
  ].join('\n')
}

export function parseMetadataTxt(text: string): { title: string; description: string; tags: string[] } {
  const sections: Record<string, string> = {}
  let current = ''
  let buf: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^=== (TITLE|DESCRIPTION|TAGS) ===$/)
    if (match?.[1]) {
      if (current) sections[current] = buf.join('\n').trim()
      current = match[1].toLowerCase()
      buf = []
    } else {
      buf.push(line)
    }
  }
  if (current) sections[current] = buf.join('\n').trim()
  return {
    title: sections.title || '',
    description: sections.description || '',
    tags: sections.tags ? sections.tags.split(',').map(tag => tag.trim()).filter(Boolean) : [],
  }
}
