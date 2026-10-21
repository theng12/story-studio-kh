export type DescriptorPins = Readonly<{ profile_digest: string, tools_digest: string, compiler_digest: string }>
export type QualificationProvenance = Readonly<{ vector_id: string, qualification_digest: string, packet_digest: string, recipe_digest: string, manifest_digest: string }>
export type StoryRenderProvenance =
  | Readonly<{ format: 'studio.render.story-build-provenance.v1', mode: 'tool-only', descriptors: null, qualification: null }>
  | Readonly<{ format: 'studio.render.story-build-provenance.v1', mode: 'descriptor-only', descriptors: DescriptorPins, qualification: null }>
  | Readonly<{ format: 'studio.render.story-build-provenance.v1', mode: 'sealed-candidate', descriptors: DescriptorPins, qualification: QualificationProvenance }>

export declare class RenderProvenanceError extends Error {
  constructor(message: string, options?: ErrorOptions)
}

export declare function parseQualificationProvenance(value: unknown): QualificationProvenance
export declare function parseStoryRenderProvenance(value: unknown): StoryRenderProvenance
export declare function readStoryRenderProvenanceFromPackageBytes(bytes: string | Uint8Array): StoryRenderProvenance | null
export declare function sameDescriptorPins(left: DescriptorPins | null | undefined, right: DescriptorPins | null | undefined): boolean
export declare function sameQualificationProvenance(left: QualificationProvenance | null | undefined, right: QualificationProvenance | null | undefined): boolean
