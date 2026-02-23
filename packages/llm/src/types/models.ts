export interface ModelInfo {
  id: string
  provider: string
  display_name: string
  context_window: number
  max_output?: number
  supports_tools: boolean
  supports_vision: boolean
  supports_reasoning: boolean
  input_cost_per_million?: number
  output_cost_per_million?: number
  aliases: string[]
}

export const MODELS: ModelInfo[] = [
  // ==========================================================
  // Anthropic — prefer Claude Opus 4.6 for top quality
  // ==========================================================
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    display_name: 'Claude Opus 4.6',
    context_window: 200000,
    max_output: 32000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 15.0,
    output_cost_per_million: 75.0,
    aliases: ['opus', 'claude-opus'],
  },
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
    context_window: 200000,
    max_output: 16000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    input_cost_per_million: 3.0,
    output_cost_per_million: 15.0,
    aliases: ['sonnet', 'claude-sonnet'],
  },
  // ==========================================================
  // OpenRouter — routes to many underlying providers
  // Model IDs use "provider/model" format
  // ==========================================================
  {
    id: 'anthropic/claude-opus-4-6',
    provider: 'openrouter',
    display_name: 'Claude Opus 4.6 (via OpenRouter)',
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: [],
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    provider: 'openrouter',
    display_name: 'Claude Sonnet 4.5 (via OpenRouter)',
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: [],
  },
  {
    id: 'openai/gpt-4.5',
    provider: 'openrouter',
    display_name: 'GPT-4.5 (via OpenRouter)',
    context_window: 128000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    aliases: [],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    provider: 'openrouter',
    display_name: 'Llama 3.1 70B (via OpenRouter)',
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_reasoning: false,
    aliases: [],
  },
  {
    id: 'google/gemini-2.0-flash-001',
    provider: 'openrouter',
    display_name: 'Gemini 2.0 Flash (via OpenRouter)',
    context_window: 1048576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: false,
    aliases: [],
  },
]

export function getModelInfo(model_id: string): ModelInfo | undefined {
  return MODELS.find(m => m.id === model_id || m.aliases.includes(model_id))
}

export function listModels(provider?: string): ModelInfo[] {
  if (provider == null) return [...MODELS]
  return MODELS.filter(m => m.provider === provider)
}

export function getLatestModel(
  provider: string,
  capability?: string,
): ModelInfo | undefined {
  let candidates = MODELS.filter(m => m.provider === provider)

  if (capability === 'reasoning') {
    candidates = candidates.filter(m => m.supports_reasoning)
  } else if (capability === 'vision') {
    candidates = candidates.filter(m => m.supports_vision)
  } else if (capability === 'tools') {
    candidates = candidates.filter(m => m.supports_tools)
  }

  // Return first match (catalog is ordered newest/best first per provider)
  return candidates[0]
}
