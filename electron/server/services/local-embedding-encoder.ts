/**
 * The encoder — everything that actually runs EmbeddingGemma 2 on this Mac.
 *
 * Three small graph runs, driven directly, in the order the published ONNX
 * export expects:
 *
 *   1. `vision_encoder.onnx` turns a picture into patch features;
 *   2. `model_quantized.onnx` turns a token sequence — with those features in
 *      it — into a sentence embedding.
 *
 * Driving the graphs ourselves (instead of a model-loading library) is a
 * measured choice, not a preference: it removes 141 MB of WebAssembly runtime
 * and a second copy of onnxruntime from the download, and it removes the one
 * blocker that made the library unusable here — with the runtime fetched into
 * Story's own folder, the library refuses `device: 'webgpu'` and silently
 * falls back to a provider that is 6× slower.
 *
 * What is NOT re-implemented: the picture is resized and cut into patches here
 * because that is a documented preprocessing step, but the token sequence is
 * only three tokens wide and is spelled out below with the model ids it comes
 * from. Nothing here guesses at the model's own behaviour.
 *
 * **Precision.** Text is `q8`, vision is `fp32`. Measured against the
 * prototype's reference on this Mac: text 0.99983 worst cosine over 48 titles,
 * vision 0.99947 worst over 85 scene images. q8 vision scores 0.984 and is not
 * used; `float16` produces NaNs on this hardware and is refused.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

import sharp from 'sharp'

import { LOCAL_EMBEDDING_MODEL } from '../contracts/local-duplicate-screening.js'

/** The embedding size the model publishes. Matryoshka 512/256 exist and are not used. */
export const EMBEDDING_DIMENSIONS = 768

/** The picture is rescaled to 0..1; the model's processor publishes this. */
const RESCALE_FACTOR = 1 / 255

export interface EncoderSettings {
  modelDir: string
  runtimeDir: string
}

/**
 * The subset of the ONNX Runtime API this file uses.
 *
 * The runtime itself is fetched at opt-in time and therefore has no
 * compile-time types in the shipped app — importing the real package would put
 * 307 MB of platform binaries in the DMG for a feature that is off. Two small
 * dependency-free pieces ARE bundled: `onnxruntime-common` (616 KB, MIT) for
 * `Tensor`, and the binding is loaded by path.
 */
interface OrtTensor { data: Float32Array | BigInt64Array; dims: number[] }
interface OrtTensorCtor { new (type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]): OrtTensor }
interface OrtSession {
  loadModel(modelPath: string, options: { executionProviders: string[] }): Promise<void>
  inputMetadata: Array<{ name: string }>
  outputMetadata: Array<{ name: string }>
  run(
    feeds: Record<string, OrtTensor>,
    fetches: Record<string, OrtTensor | null>,
    options: Record<string, never>,
  ): Promise<Record<string, OrtTensor>>
  dispose(): void
}
interface OrtBinding {
  InferenceSession: new () => OrtSession
  initOrtOnce(logLevel: number, tensorConstructor: unknown, isMainThread: boolean): void
}

/**
 * Load the fetched runtime and return a session factory.
 *
 * `createRequire` on a path inside the runtime folder is what lets the binding
 * find its own `.dylib`: the addon links `@rpath/libonnxruntime.1.dylib`, which
 * the native loader resolves relative to the addon's own directory. The
 * binding is also not self-sufficient — it has to be handed a `Tensor`
 * constructor once (`initOrtOnce`) before any session will accept feeds.
 */
async function loadRuntime(runtimeDir: string): Promise<{
  Tensor: OrtTensorCtor
  createSession: (modelPath: string) => Promise<OrtSession>
}> {
  const bindingPath = path.join(runtimeDir, 'onnxruntime_binding.node')
  const requireFromRuntime = createRequire(path.join(runtimeDir, 'noop.cjs'))
  const binding = requireFromRuntime(bindingPath) as OrtBinding

  const common = await import('onnxruntime-common')
  const Tensor = (common as unknown as { Tensor: OrtTensorCtor }).Tensor
  if (typeof Tensor !== 'function') throw new Error('The bundled Tensor implementation could not be loaded.')

  // Level 2 is `warning`: the binding is chatty about node assignment at
  // levels below that, and this runs in the background.
  binding.initOrtOnce(2, Tensor, true)

  return {
    Tensor,
    async createSession(modelPath: string): Promise<OrtSession> {
      // A fresh session object per model: the binding's constructor builds one
      // session, and it cannot be re-pointed at a second model file.
      const session = new binding.InferenceSession()
      await session.loadModel(modelPath, { executionProviders: ['webgpu'] })
      return session
    },
  }
}

interface ModelConfig {
  image_token_id: number
  boi_token_id?: number
  eoi_token_id?: number
  text_config: { hidden_size: number }
}

interface ProcessorConfig {
  image_processor: {
    patch_size: number
    pooling_kernel_size: number
    max_soft_tokens: number
    image_seq_length: number
  }
}

export interface Encoder {
  embedText(text: string): Promise<number[]>
  embedImage(file: string): Promise<number[]>
  close(): Promise<void>
}

/**
 * Build an encoder over an installed model directory.
 *
 * Throws when the runtime or the weights are absent — callers turn that into
 * `not_checked` with the message, never a score.
 */
export async function createEncoder(settings: EncoderSettings): Promise<Encoder> {
  const fs = await import('node:fs/promises')
  const config = JSON.parse(await fs.readFile(path.join(settings.modelDir, 'config.json'), 'utf8')) as ModelConfig
  const processor = JSON.parse(
    await fs.readFile(path.join(settings.modelDir, 'processor_config.json'), 'utf8'),
  ) as ProcessorConfig

  const ort = await loadRuntime(settings.runtimeDir)
  // WebGPU is the only provider fast enough to run in the background: measured
  // on this Mac, vision takes ~480 ms on WebGPU against ~3,100 ms on CPU and
  // ~7,800 ms on WebAssembly. CoreML refuses these graphs outright (dynamic
  // shapes with zero-element inputs), so it is not an option to fall back to.
  //
  // If the SECOND session fails, the first one is disposed on the way out:
  // otherwise a Mac whose runtime is half-broken would leak a loaded text model
  // on every retry. Each session is several hundred MB.
  const textSession = await ort.createSession(path.join(settings.modelDir, 'onnx/model_quantized.onnx'))
  let visionSession: OrtSession
  try {
    visionSession = await ort.createSession(path.join(settings.modelDir, 'onnx/vision_encoder.onnx'))
  } catch (error) {
    try { textSession.dispose() } catch { /* already gone */ }
    throw error
  }

  /** The binding requires the outputs to be named; ask for all of them. */
  const fetchesFor = (session: OrtSession) =>
    Object.fromEntries(session.outputMetadata.map(meta => [meta.name, null])) as Record<string, null>

  const { Tokenizer } = await import('@huggingface/tokenizers')
  let tokenizer: { encode(text: string): { ids: number[]; attention_mask: number[] } }
  try {
    const tokenizerJson = await fs.readFile(path.join(settings.modelDir, 'tokenizer.json'), 'utf8')
    tokenizer = new Tokenizer(JSON.parse(tokenizerJson), {})
  } catch (error) {
    // Same rule for a tokenizer that will not load: both sessions go.
    try { textSession.dispose() } catch { /* already gone */ }
    try { visionSession.dispose() } catch { /* already gone */ }
    throw error
  }

  const hidden = config.text_config.hidden_size
  const imageTokenId = config.image_token_id
  const boiTokenId = config.boi_token_id ?? 255999
  const eoiTokenId = config.eoi_token_id ?? 258882

  /** Modalities this feature does not use, sent empty. The graph requires all three inputs. */
  const emptyModalities = () => ({
    image_features: new ort.Tensor('float32', new Float32Array(0), [0, hidden]),
    video_features: new ort.Tensor('float32', new Float32Array(0), [0, hidden]),
    audio_features: new ort.Tensor('float32', new Float32Array(0), [0, hidden]),
  })

  function int64(values: number[]): OrtTensor {
    return new ort.Tensor('int64', BigInt64Array.from(values.map(v => BigInt(v))), [1, values.length])
  }

  /**
   * Resize the way the published processor does, then cut the picture into
   * patches.
   *
   * The target size keeps the aspect ratio, snaps to whole pooling cells, and
   * never exceeds `max_soft_tokens`. The resize kernel matters: the model was
   * qualified with bicubic resampling, and `lanczos3` shifts every picture's
   * embedding (worst cosine 0.9978 against 0.9997 with cubic).
   */
  async function patchify(file: string): Promise<{ pixels: OrtTensor; positions: OrtTensor; softTokens: number }> {
    const image = processor.image_processor
    const patch = image.patch_size
    const pool = image.pooling_kernel_size
    const maxPatches = image.max_soft_tokens * pool ** 2
    const sideMultiple = pool * patch

    const metadata = await sharp(file).metadata()
    if (!metadata.width || !metadata.height) throw new Error(`${path.basename(file)} has no readable dimensions.`)
    const factor = Math.sqrt((maxPatches * patch ** 2) / (metadata.width * metadata.height))
    const height = Math.max(sideMultiple, Math.floor((factor * metadata.height) / sideMultiple) * sideMultiple)
    const width = Math.max(sideMultiple, Math.floor((factor * metadata.width) / sideMultiple) * sideMultiple)

    const { data, info } = await sharp(file)
      .resize(width, height, { kernel: 'cubic', fit: 'fill' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })

    const channels = info.channels
    const pixelData = Float32Array.from(data as Uint8Array, (value: number) => value * RESCALE_FACTOR)
    const patchesHigh = Math.floor(height / patch)
    const patchesWide = Math.floor(width / patch)
    const patchDimension = patch * patch * channels

    const patches = new Float32Array(maxPatches * patchDimension)
    let write = 0
    for (let row = 0; row < patchesHigh; row += 1) {
      for (let column = 0; column < patchesWide; column += 1) {
        for (let dy = 0; dy < patch; dy += 1) {
          const rowOffset = ((row * patch + dy) * width + column * patch) * channels
          for (let dx = 0; dx < patch; dx += 1) {
            const source = rowOffset + dx * channels
            for (let channel = 0; channel < channels; channel += 1) patches[write++] = pixelData[source + channel]!
          }
        }
      }
    }

    // Positions are (column, row) per patch; unused patches stay at -1 so the
    // graph can tell padding from a real patch.
    const positions = new BigInt64Array(maxPatches * 2).fill(-1n)
    let positionIndex = 0
    for (let row = 0; row < patchesHigh; row += 1) {
      for (let column = 0; column < patchesWide; column += 1) {
        positions[positionIndex++] = BigInt(column)
        positions[positionIndex++] = BigInt(row)
      }
    }

    return {
      pixels: new ort.Tensor('float32', patches, [1, maxPatches, patchDimension]),
      positions: new ort.Tensor('int64', positions, [1, maxPatches, 2]),
      softTokens: Math.floor((patchesHigh * patchesWide) / pool ** 2),
    }
  }

  function l2Normalize(vector: number[]): number[] {
    let sum = 0
    for (const value of vector) sum += value * value
    const norm = Math.sqrt(sum)
    return norm > 0 ? vector.map(value => value / norm) : vector
  }

  return {
    /**
     * The token sequence the processor builds for one picture: BOS, the
     * beginning-of-image marker, one token per visual patch, the
     * end-of-image marker, EOS. Verified against the published processor's own
     * output for every scene image in this repo.
     */
    async embedImage(file: string): Promise<number[]> {
      const { pixels, positions, softTokens } = await patchify(file)
      const vision = await visionSession.run(
        { pixel_values: pixels, pixel_position_ids: positions },
        fetchesFor(visionSession),
        {},
      )
      const features = vision.image_features
      if (!features) throw new Error('The vision encoder returned no features for this picture.')
      const tokenCount = features.dims[0]!
      if (tokenCount !== softTokens) {
        throw new Error(`The vision encoder produced ${tokenCount} patches but the sequence expects ${softTokens}.`)
      }
      const tokenIds = [
        2, // BOS
        boiTokenId,
        ...Array<number>(tokenCount).fill(imageTokenId),
        eoiTokenId,
        1, // EOS
      ]
      const output = await textSession.run(
        {
          input_ids: int64(tokenIds),
          attention_mask: int64(tokenIds.map(() => 1)),
          image_features: new ort.Tensor('float32', features.data as Float32Array, [tokenCount, hidden]),
          video_features: emptyModalities().video_features,
          audio_features: emptyModalities().audio_features,
        },
        fetchesFor(textSession),
        {},
      )
      return l2Normalize(Array.from(output.sentence_embedding!.data as Float32Array))
    },

    /** A title, prompt or idea string. The tokenizer adds BOS and EOS itself. */
    async embedText(text: string): Promise<number[]> {
      const encoded = tokenizer.encode(text)
      const ids: number[] = encoded.ids
      if (!ids.length) throw new Error('That text produced no tokens.')
      const output = await textSession.run(
        {
          input_ids: int64(ids),
          attention_mask: int64(encoded.attention_mask.map((flag: number) => flag)),
          ...emptyModalities(),
        },
        fetchesFor(textSession),
        {},
      )
      return l2Normalize(Array.from(output.sentence_embedding!.data as Float32Array))
    },

    async close(): Promise<void> {
      // `dispose` is synchronous and safe to call once per session; a failure
      // here must not mask whatever the caller was doing.
      try { textSession.dispose() } catch { /* already gone */ }
      try { visionSession.dispose() } catch { /* already gone */ }
    },
  }
}

/** The model identity, for a log line that says what actually ran. */
export function describeEncoder(): string {
  return `${LOCAL_EMBEDDING_MODEL.model_id} (${LOCAL_EMBEDDING_MODEL.onnx_repo} @ ${LOCAL_EMBEDDING_MODEL.revision.slice(0, 8)})`
}

/** Cosine similarity of two embeddings. Both are already unit-length, so this is a dot product. */
export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[index]!
  return sum
}
