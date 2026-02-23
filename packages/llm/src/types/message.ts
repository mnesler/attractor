export enum Role {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
  DEVELOPER = 'developer',
}

export enum ContentKind {
  TEXT = 'text',
  IMAGE = 'image',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  THINKING = 'thinking',
  REDACTED_THINKING = 'redacted_thinking',
}

export interface ImageData {
  url?: string
  data?: Uint8Array
  media_type?: string
  detail?: 'auto' | 'low' | 'high'
}

export interface AudioData {
  url?: string
  data?: Uint8Array
  media_type?: string
}

export interface DocumentData {
  url?: string
  data?: Uint8Array
  media_type?: string
  file_name?: string
}

export interface ToolCallData {
  id: string
  name: string
  arguments: Record<string, unknown> | string
  type?: string
}

export interface ToolResultData {
  tool_call_id: string
  content: string | Record<string, unknown>
  is_error: boolean
  image_data?: Uint8Array
  image_media_type?: string
}

export interface ThinkingData {
  text: string
  signature?: string
  redacted: boolean
}

export interface ContentPart {
  kind: ContentKind | string
  text?: string
  image?: ImageData
  audio?: AudioData
  document?: DocumentData
  tool_call?: ToolCallData
  tool_result?: ToolResultData
  thinking?: ThinkingData
}

export class Message {
  readonly role: Role
  readonly content: ContentPart[]
  readonly name?: string
  readonly tool_call_id?: string

  constructor(params: {
    role: Role
    content: ContentPart[]
    name?: string
    tool_call_id?: string
  }) {
    this.role = params.role
    this.content = params.content
    this.name = params.name
    this.tool_call_id = params.tool_call_id
  }

  get text(): string {
    return this.content
      .filter(p => p.kind === ContentKind.TEXT)
      .map(p => p.text ?? '')
      .join('')
  }

  static system(text: string): Message {
    return new Message({
      role: Role.SYSTEM,
      content: [{ kind: ContentKind.TEXT, text }],
    })
  }

  static user(text: string): Message {
    return new Message({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text }],
    })
  }

  static assistant(text: string): Message {
    return new Message({
      role: Role.ASSISTANT,
      content: [{ kind: ContentKind.TEXT, text }],
    })
  }

  static developer(text: string): Message {
    return new Message({
      role: Role.DEVELOPER,
      content: [{ kind: ContentKind.TEXT, text }],
    })
  }

  static toolResult(params: {
    tool_call_id: string
    content: string | Record<string, unknown>
    is_error?: boolean
  }): Message {
    return new Message({
      role: Role.TOOL,
      tool_call_id: params.tool_call_id,
      content: [
        {
          kind: ContentKind.TOOL_RESULT,
          tool_result: {
            tool_call_id: params.tool_call_id,
            content: params.content,
            is_error: params.is_error ?? false,
          },
        },
      ],
    })
  }
}
