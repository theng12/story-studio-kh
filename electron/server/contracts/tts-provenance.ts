/**
 * The TTS facts Story Studio records for narration it paid for.
 *
 * A LEAF module on purpose (no imports at all): `services/task-manifest.ts`,
 * `services/audio-quality-store.ts` and `services/audio-take-provenance.ts` all
 * describe these facts, and a type imported across those modules in a cycle
 * made TypeScript degrade unrelated zod-inferred types elsewhere in the server
 * tree (282 bogus errors, 2026-10-26). One interface, no imports, no cycle.
 *
 * Every field is an optional PUBLISHED catalogue fact — except
 * `delivery_instruction`, which is the direction the customer gave and is
 * labelled as such. Absent means the Gateway did not publish it (or the part
 * predates this record) — never `false`, never a substituted value
 * (AGENTS.md §1/§2).
 */
export interface TtsProvenanceFacts {
  model_id?: string
  model_display_name?: string
  voice_id?: string
  voice_display_name?: string
  /** The model row's serving provider, as published. */
  provider?: string
  /** The voice row's own provider, when the catalogue publishes a different one. */
  voice_provider?: string
  engine_id?: string
  engine_name?: string
  model_revision_id?: string
  model_family?: string
  voice_revision?: string
  /**
   * How this take was DIRECTED — the model's own delivery/emotion instruction,
   * exactly as it was sent (owner, 2026-10-29). The one field here that is not
   * a catalogue fact: it is what the customer asked for, recorded beside the
   * engine and voice so a take can answer "how was this read?". Absent means no
   * instruction was sent — never an empty string and never a default.
   */
  delivery_instruction?: string
}
