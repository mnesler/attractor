import { Message, Role, ContentKind } from './types/message.js'
import type { Request } from './types/request.js'
import { Response, addUsage, zeroUsage } from './types/response.js'
import type { GenerateResult, StepResult } from './types/response.js'
import { StreamEventType, StreamResult } from './types/stream.js'
import type { StreamEvent } from './types/stream.js'
import type { Tool, ToolCall, ToolResult, ResponseFormat } from './types/tool.js'
import type { ToolChoice } from './types/tool.js'
import { NoObjectGeneratedError, InvalidRequestError, ConfigurationError } from './types/errors.js'
import { Client, getDefaultClient } from './client.js'
import { withRetry, DEFAULT_RETRY_POLICY } from './retry.js'
import type { RetryPolicy } from './retry.js'

// ---------------------------------------------------------------------------
// Shared parameter types
// ---------------------------------------------------------------------------

export interface GenerateParams {
  model: string
  prompt?: string
  messages?: Message[]
  system?: string
  tools?: Tool[]
  tool_choice?: ToolChoice
  max_tool_rounds?: number
  response_format?: ResponseFormat
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop_sequences?: string[]
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high'
  provider?: string
  provider_options?: Record<string, unknown>
  max_retries?: number
  abort_signal?: AbortSignal
  client?: Client
}

export interface StreamParams extends GenerateParams {
  // same as generate
}

export interface GenerateObjectParams extends GenerateParams {
  schema: Record<string, unknown>
}

type StopCondition = (steps: StepResult[]) => boolean

// ---------------------------------------------------------------------------
// generate()
// ---------------------------------------------------------------------------

export async function generate(params: GenerateParams): Promise<GenerateResult> {
  const { client: explicitClient, max_retries = 2, ...rest } = params
  const client = explicitClient ?? getDefaultClient()

  validateParams(params)

  const messages = buildMessages(params)
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, max_retries }

  return runToolLoop(client, messages, rest, policy, params.tools, params.max_tool_rounds ?? 1)
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

export function streamGenerate(params: StreamParams): StreamResult {
  validateParams(params)

  const source = streamGeneratorInternal(params)
  return new StreamResult(source)
}

async function* streamGeneratorInternal(params: StreamParams): AsyncGenerator<StreamEvent> {
  const { client: explicitClient, max_retries = 2 } = params
  const client = explicitClient ?? getDefaultClient()

  const messages = buildMessages(params)
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, max_retries }

  const request = buildRequest(params, messages)

  yield { type: StreamEventType.STREAM_START }

  const eventStream = await withRetry(() => {
    // stream() returns AsyncGenerator immediately; we need to start it
    return Promise.resolve(client.stream(request))
  }, policy)

  let hasToolCalls = false
  const toolCallAccum = new Map<string, { id: string; name: string; args: string }>()

  for await (const event of eventStream) {
    yield event

    if (event.type === StreamEventType.TOOL_CALL_START && event.tool_call?.id) {
      hasToolCalls = true
      toolCallAccum.set(event.tool_call.id, {
        id: event.tool_call.id,
        name: event.tool_call.name ?? '',
        args: '',
      })
    }
    if (event.type === StreamEventType.TOOL_CALL_DELTA && event.tool_call?.id) {
      const tc = toolCallAccum.get(event.tool_call.id)
      if (tc && event.tool_call.raw_arguments) tc.args += event.tool_call.raw_arguments
    }
    if (event.type === StreamEventType.FINISH && event.response) {
      if (hasToolCalls && params.tools && params.max_tool_rounds !== 0) {
        // Execute tools and continue
        const toolCalls = event.response.toolCalls
        const toolResults = await executeAllTools(params.tools, toolCalls, params.abort_signal)

        // Yield step finish event
        yield {
          type: 'step_finish',
          raw: {
            tool_calls: toolCalls,
            tool_results: toolResults,
          },
        }

        // Build continuation messages
        const nextMessages = [
          ...messages,
          event.response.message,
          ...toolResults.map(tr =>
            Message.toolResult({
              tool_call_id: tr.tool_call_id,
              content: tr.content as string,
              is_error: tr.is_error,
            }),
          ),
        ]

        // Stream next step
        const nextRequest = buildRequest(params, nextMessages)
        const nextStream = client.stream(nextRequest)
        for await (const nextEvent of nextStream) {
          yield nextEvent
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// generate_object()
// ---------------------------------------------------------------------------

export async function generateObject(params: GenerateObjectParams): Promise<GenerateResult> {
  const { schema, provider } = params

  // Choose strategy based on provider
  const useJsonSchema = provider === 'openrouter' || !provider

  let adjustedParams: GenerateParams
  if (useJsonSchema) {
    adjustedParams = {
      ...params,
      response_format: {
        type: 'json_schema',
        json_schema: schema,
        strict: false,
      },
    }
  } else {
    // Anthropic: inject schema into system prompt
    const schemaStr = JSON.stringify(schema, null, 2)
    const injectedSystem = [
      params.system ?? '',
      `\nRespond with a JSON object that conforms to this schema:\n\`\`\`json\n${schemaStr}\n\`\`\`\nOutput only valid JSON, no markdown code blocks.`,
    ]
      .filter(Boolean)
      .join('\n')

    adjustedParams = { ...params, system: injectedSystem }
  }

  const result = await generate(adjustedParams)

  // Parse the output
  const rawText = result.text.trim()
  let parsed: unknown

  try {
    // Strip markdown code blocks if present
    const jsonText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(jsonText)
  } catch {
    throw new NoObjectGeneratedError(
      `Failed to parse structured output as JSON`,
      rawText,
    )
  }

  return { ...result, output: parsed }
}

// ---------------------------------------------------------------------------
// Tool execution loop
// ---------------------------------------------------------------------------

async function runToolLoop(
  client: Client,
  initialMessages: Message[],
  params: Omit<GenerateParams, 'client' | 'max_retries'>,
  policy: RetryPolicy,
  tools?: Tool[],
  maxToolRounds = 1,
): Promise<GenerateResult> {
  const steps: StepResult[] = []
  let conversation = [...initialMessages]
  let totalUsage = zeroUsage()

  for (let round = 0; round <= maxToolRounds; round++) {
    const request = buildRequest(params, conversation)

    const response = await withRetry(() => client.complete(request), policy)

    const toolCalls = response.toolCalls
    const isToolCall = response.finish_reason.reason === 'tool_calls' && toolCalls.length > 0
    const hasActiveTools = tools && tools.some(t => t.execute != null)
    // Execute tools only if there are rounds remaining AFTER this one (round < maxToolRounds)
    // max_tool_rounds = 0: never execute; max_tool_rounds = 1: execute on round 0 only
    const canExecute = round < maxToolRounds

    let toolResults: ToolResult[] = []

    if (isToolCall && hasActiveTools && canExecute) {
      toolResults = await executeAllTools(tools!, toolCalls, params.abort_signal)
    }

    const step: StepResult = {
      text: response.text,
      reasoning: response.reasoning,
      tool_calls: toolCalls,
      tool_results: toolResults,
      finish_reason: response.finish_reason,
      usage: response.usage,
      response,
      warnings: response.warnings,
    }
    steps.push(step)
    totalUsage = addUsage(totalUsage, response.usage)

    // Stop conditions: no tool calls, no active tools, nothing executed, or budget exhausted
    const isDone = !isToolCall || !hasActiveTools || !canExecute || toolResults.length === 0
    if (isDone) break

    // Append assistant message + tool results to conversation
    conversation.push(response.message)
    for (const tr of toolResults) {
      conversation.push(
        Message.toolResult({
          tool_call_id: tr.tool_call_id,
          content: tr.content as string,
          is_error: tr.is_error,
        }),
      )
    }
  }

  const lastStep = steps[steps.length - 1]!
  return {
    text: lastStep.text,
    reasoning: lastStep.reasoning,
    tool_calls: lastStep.tool_calls,
    tool_results: lastStep.tool_results,
    finish_reason: lastStep.finish_reason,
    usage: lastStep.usage,
    total_usage: totalUsage,
    steps,
    response: lastStep.response,
  }
}

// ---------------------------------------------------------------------------
// executeAllTools — concurrent execution
// ---------------------------------------------------------------------------

export async function executeAllTools(
  tools: Tool[],
  toolCalls: ToolCall[],
  abortSignal?: AbortSignal,
): Promise<ToolResult[]> {
  const results = await Promise.allSettled(
    toolCalls.map(async call => {
      const tool = tools.find(t => t.name === call.name)

      if (!tool) {
        return {
          tool_call_id: call.id,
          content: `Unknown tool: ${call.name}`,
          is_error: true,
        } satisfies ToolResult
      }

      if (!tool.execute) {
        return {
          tool_call_id: call.id,
          content: '',
          is_error: false,
        } satisfies ToolResult
      }

      try {
        const output = await tool.execute(call.arguments)
        const content =
          typeof output === 'string' ? output : JSON.stringify(output)
        return {
          tool_call_id: call.id,
          content,
          is_error: false,
        } satisfies ToolResult
      } catch (err) {
        return {
          tool_call_id: call.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        } satisfies ToolResult
      }
    }),
  )

  // Preserve ordering; convert rejections to error results (shouldn't happen with allSettled)
  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value
    return {
      tool_call_id: toolCalls[i]!.id,
      content: String(result.reason),
      is_error: true,
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateParams(params: GenerateParams): void {
  if (params.prompt != null && params.messages != null) {
    throw new InvalidRequestError({
      message: 'Provide either "prompt" or "messages", not both.',
      provider: params.provider ?? 'unknown',
    })
  }
  if (params.prompt == null && params.messages == null) {
    throw new InvalidRequestError({
      message: 'Either "prompt" or "messages" must be provided.',
      provider: params.provider ?? 'unknown',
    })
  }
}

function buildMessages(params: GenerateParams): Message[] {
  const messages: Message[] = []

  if (params.system) {
    messages.push(Message.system(params.system))
  }

  if (params.prompt != null) {
    messages.push(Message.user(params.prompt))
  } else if (params.messages != null) {
    messages.push(...params.messages)
  }

  return messages
}

function buildRequest(
  params: Omit<GenerateParams, 'client' | 'max_retries'>,
  messages: Message[],
): Request {
  return {
    model: params.model,
    messages,
    provider: params.provider,
    tools: params.tools,
    tool_choice: params.tool_choice,
    response_format: params.response_format,
    temperature: params.temperature,
    top_p: params.top_p,
    max_tokens: params.max_tokens,
    stop_sequences: params.stop_sequences,
    reasoning_effort: params.reasoning_effort,
    provider_options: params.provider_options,
  }
}
