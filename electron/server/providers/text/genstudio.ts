/** GenStudio KH durable text-generation boundary. */

import { registry } from '../registry.js'
import { callChatWithGenStudio } from '../../lib/genstudio-client.js'
import type { TextGenerationRequest, TextProvider } from '../types.js'

export const GENSTUDIO_CHAT_MODEL_PREFIX = 'genstudio-chat:'

const genstudioProvider: TextProvider = {
  meta: {
    id: 'genstudio',
    name: 'GenStudio KH',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  supportsModel(modelId: string): boolean {
    return typeof modelId === 'string' && modelId.startsWith(GENSTUDIO_CHAT_MODEL_PREFIX)
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    if (!request.apiKey) {
      throw new Error('No GenStudio KH API key configured. Add one in Settings -> API Keys.')
    }
    if (request.images?.length) {
      throw new Error('The selected GenStudio KH text model does not publish image-input support.')
    }
    const modelId = request.model.slice(GENSTUDIO_CHAT_MODEL_PREFIX.length).trim()
    if (!modelId) throw new Error(`Invalid GenStudio KH chat model id: ${request.model}`)

    const result = await callChatWithGenStudio(request.apiKey, {
      modelId,
      system: request.system,
      userMessage: request.userMessage,
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      outputBudget: request.outputBudget,
      requestIdentity: request.requestIdentity,
      recoverByIdempotencyKey: request.recoverByIdempotencyKey === true,
      idempotencyKey: request.idempotencyKey,
      allowedRecoveryKeys: request.allowedRecoveryKeys,
      outputContract: request.outputContract,
      jsonObject: !request.outputContract && request.jsonMode === true,
      signal: request.signal,
      onState: async (state, jobId) => {
        request.onDiagnostics?.({
          requestId: jobId,
          model: modelId,
          provider: 'genstudio',
          finishReason: state,
        })
      },
      onJobAccepted: request.onJobAccepted,
      onRequestPrepared: request.onRequestPrepared,
    })
    request.onDiagnostics?.({
      requestId: result.jobId,
      model: result.modelId,
      provider: 'genstudio',
      finishReason: 'stop',
    })
    return result.text
  },
}

registry.registerText(genstudioProvider)
