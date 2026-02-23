import { SDKError, AbortError } from './types/errors.js'

export interface RetryPolicy {
  max_retries: number
  base_delay: number
  max_delay: number
  backoff_multiplier: number
  jitter: boolean
  on_retry?: (error: SDKError, attempt: number, delay: number) => void
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 2,
  base_delay: 1.0,
  max_delay: 60.0,
  backoff_multiplier: 2.0,
  jitter: true,
}

function isRetryable(err: unknown): boolean {
  if (err instanceof AbortError) return false
  if (err instanceof SDKError && 'retryable' in err) {
    return (err as SDKError & { retryable: boolean }).retryable
  }
  // Unknown errors default to retryable
  return true
}

function getRetryAfter(err: unknown): number | undefined {
  if (err instanceof SDKError && 'retry_after' in err) {
    return (err as SDKError & { retry_after?: number }).retry_after
  }
  return undefined
}

function calculateDelay(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(
    policy.base_delay * Math.pow(policy.backoff_multiplier, attempt),
    policy.max_delay,
  )
  if (!policy.jitter) return base
  // +/- 50% jitter
  return base * (0.5 + Math.random())
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= policy.max_retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      const isLast = attempt >= policy.max_retries
      if (isLast || !isRetryable(err)) {
        throw err
      }

      const retryAfter = getRetryAfter(err)
      let delay: number

      if (retryAfter != null) {
        if (retryAfter > policy.max_delay) {
          // Provider retry-after exceeds max_delay — don't retry
          throw err
        }
        delay = retryAfter * 1000
      } else {
        delay = calculateDelay(attempt, policy) * 1000
      }

      if (policy.on_retry && err instanceof SDKError) {
        policy.on_retry(err, attempt, delay / 1000)
      }

      await sleep(delay)
    }
  }

  throw lastError
}
