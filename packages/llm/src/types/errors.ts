export class SDKError extends Error {
  override readonly cause?: Error

  constructor(message: string, cause?: Error) {
    super(message)
    this.name = this.constructor.name
    this.cause = cause
    // Restore prototype chain (required for extends Error in TypeScript)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export interface ProviderErrorParams {
  message: string
  provider: string
  status_code?: number
  error_code?: string
  retryable?: boolean
  retry_after?: number
  raw?: Record<string, unknown>
  cause?: Error
}

export class ProviderError extends SDKError {
  readonly provider: string
  readonly status_code?: number
  readonly error_code?: string
  readonly retryable: boolean
  readonly retry_after?: number
  readonly raw?: Record<string, unknown>

  constructor(params: ProviderErrorParams) {
    super(params.message, params.cause)
    this.provider = params.provider
    this.status_code = params.status_code
    this.error_code = params.error_code
    this.retryable = params.retryable ?? false
    this.retry_after = params.retry_after
    this.raw = params.raw
  }
}

export class AuthenticationError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class AccessDeniedError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class NotFoundError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class InvalidRequestError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class RateLimitError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: true })
  }
}

export class ServerError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: true })
  }
}

export class ContentFilterError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class ContextLengthError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class QuotaExceededError extends ProviderError {
  constructor(params: Omit<ProviderErrorParams, 'retryable'>) {
    super({ ...params, retryable: false })
  }
}

export class RequestTimeoutError extends SDKError {
  readonly retryable = true
  readonly retry_after?: number

  constructor(message: string, cause?: Error) {
    super(message, cause)
  }
}

export class AbortError extends SDKError {
  readonly retryable = false

  constructor(message = 'Request was aborted', cause?: Error) {
    super(message, cause)
  }
}

export class NetworkError extends SDKError {
  readonly retryable = true

  constructor(message: string, cause?: Error) {
    super(message, cause)
  }
}

export class StreamError extends SDKError {
  readonly retryable = true

  constructor(message: string, cause?: Error) {
    super(message, cause)
  }
}

export class InvalidToolCallError extends SDKError {
  readonly retryable = false
  readonly tool_name: string

  constructor(message: string, tool_name: string, cause?: Error) {
    super(message, cause)
    this.tool_name = tool_name
  }
}

export class NoObjectGeneratedError extends SDKError {
  readonly retryable = false
  readonly raw_output?: string

  constructor(message: string, raw_output?: string, cause?: Error) {
    super(message, cause)
    this.raw_output = raw_output
  }
}

export class ConfigurationError extends SDKError {
  readonly retryable = false

  constructor(message: string, cause?: Error) {
    super(message, cause)
  }
}

export function errorFromStatus(params: {
  status: number
  message: string
  provider: string
  error_code?: string
  retry_after?: number
  raw?: Record<string, unknown>
}): SDKError {
  const base: Omit<ProviderErrorParams, 'retryable'> = {
    message: params.message || `HTTP ${params.status}`,
    provider: params.provider,
    status_code: params.status,
    error_code: params.error_code,
    retry_after: params.retry_after,
    raw: params.raw,
  }

  // Message-based classification
  const msg = (params.message ?? '').toLowerCase()
  if (msg.includes('content filter') || msg.includes('safety')) {
    return new ContentFilterError(base)
  }
  if (msg.includes('context length') || msg.includes('too many tokens')) {
    return new ContextLengthError(base)
  }
  if (msg.includes('unauthorized') || msg.includes('invalid key')) {
    return new AuthenticationError(base)
  }
  if (msg.includes('not found') || msg.includes('does not exist')) {
    return new NotFoundError(base)
  }

  switch (params.status) {
    case 400:
    case 422:
      return new InvalidRequestError(base)
    case 401:
      return new AuthenticationError(base)
    case 403:
      return new AccessDeniedError(base)
    case 404:
      return new NotFoundError(base)
    case 408:
      return new RequestTimeoutError(base.message)
    case 413:
      return new ContextLengthError(base)
    case 429:
      return new RateLimitError(base)
    case 500:
    case 502:
    case 503:
    case 504:
      return new ServerError(base)
    default:
      // Unknown errors default to retryable (conservative choice per spec)
      return new ServerError({ ...base, retryable: true } as ProviderErrorParams)
  }
}
