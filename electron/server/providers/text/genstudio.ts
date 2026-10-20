/** GenStudio KH durable text-generation boundary. */

import { registry } from '../registry.js'
import { callChatWithGenStudio } from '../../lib/genstudio-client.js'
import type { TextGenerationRequest, TextProvider } from '../types.js'

export const GENSTUDIO_CHAT_MODEL_PREFIX = 'genstudio-chat:'

const genstudioProvider: TextProvider = {
  meta: {
    id: 'genstudio',
    name: 'Gateway',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  supportsModel(modelId: string): boolean {
    return typeof modelId === 'string' && modelId.startsWith(GENSTUDIO_CHAT_MODEL_PREFIX)
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    if (!request.apiKey) {
      throw new Error('No Gateway API Key configured. Add one in Settings → This Mac.')
    }
    if (request.images?.length) {
      throw new Error('The selected Gateway text model does not publish image-input support.')
    }
    const modelId = request.model.slice(GENSTUDIO_CHAT_MODEL_PREFIX.length).trim()
    if (!modelId) throw new Error(`Invalid Gateway chat model id: ${request.model}`)

    const result = await callChatWithGenStudio(request.apiKey, {
      modelId,
      system: request.system,
      userMessage: request.userMessage,
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      outputBudget: request.outputBudget,
      // The caller's own expectation, forwarded so the Gateway can hand it to the Hub lane that
      // sizes this job's chat deadline. A hint only: it changes no allowance.
      expectedOutputTokens: request.expectedOutputTokens,
      requestIdentity: request.requestIdentity,
      recoverByIdempotencyKey: request.recoverByIdempotencyKey === true,
      deferLostResend: request.deferLostResend === true,
      allowUncreatedRecovery: request.allowUncreatedRecovery === true,
      recoveryRequestPreview: request.recoveryRequestPreview,
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
