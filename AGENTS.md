# AGENTS.md

This file provides guidance to coding agents working in the Attractor repository.

## Repository Structure

This is a TypeScript monorepo containing:
- **Specs** in `attractor-spec/` — Natural Language Specs (NLSpecs) for agent implementation
- **Implementation** in `packages/` — Four npm workspaces: `llm`, `agent`, `attractor`, `attractor-mcp`
- **Pipelines** in `pipelines/` — Runnable `.mts` files executed with `npx tsx`

Architecture stack: `Attractor` → `Coding Agent Loop` → `Unified LLM Client`

## Build, Test & Lint Commands

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build --workspaces --if-present

# Run full test suite
npx vitest run

# Run tests for a single package
npx vitest run --project packages/attractor
npx vitest run --project packages/agent
npx vitest run --project packages/llm

# Run a specific test file
npx vitest run packages/attractor/tests/engine.test.ts

# Watch mode for development
npx vitest --project packages/attractor

# Run integration tests (excluded by default)
npm run test:integration --workspace=packages/attractor
```

**No linter configured** — rely on TypeScript strict mode for quality control.

## Code Style Guidelines

### Imports

**Always use `.js` extensions** for TypeScript imports (ES modules convention):
```typescript
import { Session } from './session.js'
import type { Request } from './types/request.js'
```

**Use `node:` protocol** for Node.js built-ins:
```typescript
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
```

**Import organization** (group by source, separate with blank lines):
```typescript
// 1. Node built-ins
import { randomUUID } from 'node:crypto'

// 2. External packages (workspace-scoped)
import { Message, Role } from '@attractor/llm'

// 3. Internal types (with 'type' keyword)
import type { ProviderProfile } from './profiles/base.js'

// 4. Internal implementations
import { defaultConfig } from './config.js'
```

**Type-only imports** use explicit `type` keyword:
```typescript
import type { Request, Response } from './types/index.js'
import { Message, type ContentPart } from './message.js'  // Mixed style OK
```

### Types

**Always explicit types** for function parameters and public API return types:
```typescript
// Public API: explicit return type
export async function execute(node: Node, ctx: Context): Promise<Outcome> { ... }

// Internal/private: inferred return OK
private buildRequest(req: Request, stream: boolean) { ... }
```

**Prefer `interface` for contracts**, `type` for unions/intersections:
```typescript
// Interface for extensible contracts
export interface ProviderAdapter {
  readonly name: string
  complete(request: Request): Promise<Response>
}

// Type for unions
export type MiddlewareFn = (req: Request, next: NextFn) => Promise<Response>
```

**Avoid `any`** — use `unknown` for type-safe handling:
```typescript
// ✅ Good
const data = JSON.parse(text) as Record<string, unknown>

// ❌ Avoid
const data: any = JSON.parse(text)
```

### Naming Conventions

- **Functions**: `camelCase` with verb prefixes: `executeNode`, `buildRequest`, `selectEdge`
- **Variables**: `camelCase`: `httpResponse`, `assistantTurn`, `completedNodes`
- **Classes**: `PascalCase`: `Client`, `Session`, `Runner`, `AnthropicAdapter`
- **Interfaces**: `PascalCase`: `ProviderAdapter`, `ExecutionEnvironment`
- **Constants**: `SCREAMING_SNAKE_CASE`: `ANTHROPIC_API_URL`, `DEFAULT_RETRY_POLICY`
- **Enums**: `PascalCase` name, `SCREAMING_SNAKE_CASE` members:
  ```typescript
  export enum SessionState {
    IDLE = 'IDLE',
    PROCESSING = 'PROCESSING',
  }
  ```

### Error Handling

**Custom error hierarchy** extending base `SDKError` class:
```typescript
export class SDKError extends Error {
  override readonly cause?: Error
  constructor(message: string, cause?: Error) {
    super(message)
    this.name = this.constructor.name
    this.cause = cause
    Object.setPrototypeOf(this, new.target.prototype)  // Restore prototype
  }
}

export class ProviderError extends SDKError {
  readonly provider: string
  readonly status_code?: number
  readonly retryable: boolean
}
```

**Include context in error messages**:
```typescript
try {
  const content = await env.read_file(filePath)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  throw new Error(`Error reading ${filePath}: ${msg}`)
}
```

**Use guard clauses** instead of nested conditions:
```typescript
if (!providerName) {
  throw new ConfigurationError('No provider specified')
}
if (!apiKey) {
  throw new AuthenticationError('Missing API key')
}
// Happy path continues...
```

### Async/Promise Patterns

**Use `async/await` everywhere** (no raw Promise constructors except utilities):
```typescript
async function process(): Promise<Result> {
  const data = await fetch()
  return transform(data)
}
```

**Async generators for streaming**:
```typescript
async *stream(request: Request): AsyncGenerator<StreamEvent> {
  yield* adapter.stream(request)
}
```

**Parallel execution with `Promise.all`**:
```typescript
const results = await Promise.all(
  toolCalls.map(tc => this.execute_single_tool(tc))
)
```

### Comments

**Minimal JSDoc** — use only for complex APIs or internal notes.

**Section separators** for logical blocks:
```typescript
// ---------------------------------------------------------------------------
// Edge selection
// ---------------------------------------------------------------------------
```

**Inline comments explain "why", not "what"**:
```typescript
// +/- 50% jitter to prevent thundering herd
const delay = base * (0.5 + Math.random())

// Restore prototype chain (required for extends Error in TypeScript)
Object.setPrototypeOf(this, new.target.prototype)
```

### Exports

**Named exports only** (no default exports):
```typescript
export class Client { ... }
export interface ClientConfig { ... }
export function getDefaultClient(): Client { ... }
```

**Barrel exports** in `index.ts` re-export from modules:
```typescript
// index.ts
export * from './types/index.js'
export { Client, getDefaultClient } from './client.js'
export type { ClientConfig, MiddlewareFn } from './client.js'
```

## Testing Patterns

**Use vitest globals** (configured in `vitest.config.ts`):
```typescript
import { describe, it, expect, vi } from 'vitest'
```

**Mock factory pattern** for complex objects:
```typescript
function mockResponse(text: string, toolCalls: ToolCall[] = []): Response {
  return {
    id: 'resp-1',
    model: 'test-model',
    text,
    toolCalls,
    usage: { input_tokens: 10, output_tokens: 5 },
    // ...
  }
}
```

**Temporary directory helper** for filesystem tests:
```typescript
async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
```

## Auto-Commit After Tasks

After completing any code modification task, automatically create a single git commit:

1. **When**: After each logical task is complete (bug fix, feature, refactor, test suite, etc.)
2. **Format**: Conventional commits - `type(scope): short description`
   - Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`
   - Scope: relevant module/file/feature (optional but preferred)
   - Description: imperative mood, lowercase, no period, max 50 chars
3. **Behavior**: Commit silently without prompting. State what is being committed.
4. **Granularity**: One commit per task, even if multiple files changed
5. **Push** to remote after committing

Example: `refactor(agent): extract session state management`
