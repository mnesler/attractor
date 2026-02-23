import type { Request } from './types/request.js'
import type { Response } from './types/response.js'
import type { StreamEvent } from './types/stream.js'
import { ConfigurationError } from './types/errors.js'
import { AnthropicAdapter } from './adapters/anthropic.js'
import { OpenRouterAdapter } from './adapters/openrouter.js'

export type MiddlewareFn = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>

export type StreamMiddlewareFn = (
  request: Request,
  next: (request: Request) => AsyncGenerator<StreamEvent>,
) => AsyncGenerator<StreamEvent>

export interface ProviderAdapter {
  readonly name: string
  complete(request: Request): Promise<Response>
  stream(request: Request): AsyncGenerator<StreamEvent>
  close?(): void
  initialize?(): void
  supports_tool_choice?(mode: string): boolean
}

export interface ClientConfig {
  providers: Record<string, ProviderAdapter>
  default_provider?: string
  middleware?: MiddlewareFn[]
}

export class Client {
  private adapters: Map<string, ProviderAdapter>
  private defaultProvider: string | undefined
  private middlewares: MiddlewareFn[]

  constructor(config: ClientConfig) {
    this.adapters = new Map(Object.entries(config.providers))
    this.defaultProvider = config.default_provider
    this.middlewares = config.middleware ?? []

    // Initialize adapters
    for (const adapter of this.adapters.values()) {
      adapter.initialize?.()
    }
  }

  static fromEnv(): Client {
    const providers: Record<string, ProviderAdapter> = {}
    let firstProvider: string | undefined

    const anthropicKey = process.env['ANTHROPIC_API_KEY']
    if (anthropicKey) {
      providers['anthropic'] = new AnthropicAdapter({
        api_key: anthropicKey,
        base_url: process.env['ANTHROPIC_BASE_URL'],
      })
      firstProvider ??= 'anthropic'
    }

    const openrouterKey = process.env['OPENROUTER_API_KEY']
    if (openrouterKey) {
      providers['openrouter'] = new OpenRouterAdapter({
        api_key: openrouterKey,
        base_url: process.env['OPENROUTER_BASE_URL'],
      })
      firstProvider ??= 'openrouter'
    }

    return new Client({
      providers,
      default_provider: firstProvider,
    })
  }

  async complete(request: Request): Promise<Response> {
    const adapter = this.resolveAdapter(request)
    const resolved = { ...request, provider: adapter.name }

    const handler = (req: Request) => adapter.complete(req)

    if (this.middlewares.length === 0) {
      return handler(resolved)
    }

    // Build middleware chain (request: registration order, response: reverse)
    let chain = handler
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i]!
      const next = chain
      chain = (req: Request) => mw(req, next)
    }

    return chain(resolved)
  }

  async *stream(request: Request): AsyncGenerator<StreamEvent> {
    const adapter = this.resolveAdapter(request)
    const resolved = { ...request, provider: adapter.name }
    yield* adapter.stream(resolved)
  }

  close(): void {
    for (const adapter of this.adapters.values()) {
      adapter.close?.()
    }
  }

  private resolveAdapter(request: Request): ProviderAdapter {
    const providerName = request.provider ?? this.defaultProvider
    if (!providerName) {
      throw new ConfigurationError(
        'No provider specified and no default provider configured. ' +
          'Set a provider on the request or configure a default_provider.',
      )
    }
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new ConfigurationError(
        `Provider "${providerName}" is not registered. ` +
          `Registered providers: ${[...this.adapters.keys()].join(', ')}`,
      )
    }
    return adapter
  }
}

// ---------------------------------------------------------------------------
// Module-level default client
// ---------------------------------------------------------------------------

let _defaultClient: Client | undefined

export function getDefaultClient(): Client {
  if (!_defaultClient) {
    _defaultClient = Client.fromEnv()
  }
  return _defaultClient
}

export function setDefaultClient(client: Client): void {
  _defaultClient = client
}
