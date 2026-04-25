/**
 * Usage tracker — estimates API costs per session based on token usage.
 * Resets on app restart (session-only).
 */

// Pricing per 1M tokens (input/output)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
}

interface UsageEntry {
  model: string
  input_tokens: number
  output_tokens: number
  cost: number
  timestamp: string
}

const sessionUsage: UsageEntry[] = []

export function trackUsage(model: string, inputTokens: number, outputTokens: number): void {
  const pricing = MODEL_PRICING[model] || { input: 5.0, output: 15.0 }
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000

  sessionUsage.push({
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost,
    timestamp: new Date().toISOString(),
  })

  // Prevent unbounded growth in long sessions
  if (sessionUsage.length > 10000) {
    sessionUsage.splice(0, sessionUsage.length - 10000)
  }
}

// Estimate tokens from character count (~4 chars per token for English)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function trackFromText(model: string, inputText: string, outputText: string): void {
  trackUsage(model, estimateTokens(inputText), estimateTokens(outputText))
}

export function getSessionUsage(): {
  total_cost: number
  by_model: Record<string, { calls: number; cost: number }>
  entries: number
} {
  const byModel: Record<string, { calls: number; cost: number }> = {}
  let totalCost = 0

  for (const entry of sessionUsage) {
    totalCost += entry.cost
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, cost: 0 }
    byModel[entry.model].calls++
    byModel[entry.model].cost += entry.cost
  }

  return {
    total_cost: Math.round(totalCost * 10000) / 10000,
    by_model: byModel,
    entries: sessionUsage.length,
  }
}

export function getModelPricing(): Record<string, { input: number; output: number }> {
  return { ...MODEL_PRICING }
}
