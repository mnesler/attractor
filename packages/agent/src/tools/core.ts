import * as path from 'node:path'
import type { ExecutionEnvironment } from '../environment/interface.js'
import type { RegisteredTool } from './registry.js'

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileTool: RegisteredTool = {
  definition: {
    name: 'read_file',
    description:
      'Read a file from the filesystem. Returns line-numbered content in "  NNN | content" format.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file' },
        offset: { type: 'integer', description: '1-based line number to start reading from' },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to read (default: 2000)',
        },
      },
      required: ['file_path'],
    },
  },
  executor: async (args, env) => {
    const filePath = args['file_path'] as string
    const offset = (args['offset'] as number | undefined) ?? 1
    const limit = (args['limit'] as number | undefined) ?? 2000

    try {
      const content = await env.read_file(filePath, offset, limit)
      const lines = content.split('\n')
      const numbered = lines.map((line, i) => {
        const lineNum = String(offset + i).padStart(5)
        return `${lineNum} | ${line}`
      })
      return numbered.join('\n')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error reading ${filePath}: ${msg}`
    }
  },
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const writeFileTool: RegisteredTool = {
  definition: {
    name: 'write_file',
    description:
      'Write content to a file. Creates the file and parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path' },
        content: { type: 'string', description: 'The full file content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  executor: async (args, env) => {
    const filePath = args['file_path'] as string
    const content = args['content'] as string

    try {
      await env.write_file(filePath, content)
      const bytes = Buffer.byteLength(content, 'utf-8')
      return `Successfully wrote ${bytes} bytes to ${filePath}`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error writing ${filePath}: ${msg}`
    }
  },
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const editFileTool: RegisteredTool = {
  definition: {
    name: 'edit_file',
    description:
      'Replace an exact string occurrence in a file. The old_string must match exactly.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'Exact text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences instead of just the first (default: false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  executor: async (args, env) => {
    const filePath = args['file_path'] as string
    const oldString = args['old_string'] as string
    const newString = args['new_string'] as string
    const replaceAll = (args['replace_all'] as boolean | undefined) ?? false

    try {
      const content = await env.read_file(filePath)

      if (!content.includes(oldString)) {
        // Try fuzzy whitespace-normalized match
        const normalizedContent = normalizeWhitespace(content)
        const normalizedOld = normalizeWhitespace(oldString)
        if (!normalizedContent.includes(normalizedOld)) {
          return (
            `Error: old_string not found in ${filePath}.\n` +
            `The exact text was not present. Read the file first to see current content, ` +
            `then provide a matching string.`
          )
        }
        return (
          `Error: old_string not found exactly in ${filePath} (whitespace mismatch). ` +
          `Read the file to get the exact current content.`
        )
      }

      const occurrences = countOccurrences(content, oldString)
      if (!replaceAll && occurrences > 1) {
        return (
          `Error: old_string appears ${occurrences} times in ${filePath}. ` +
          `Provide more surrounding context to make it unique, or set replace_all=true ` +
          `to replace all occurrences.`
        )
      }

      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString)

      await env.write_file(filePath, newContent)
      const replaced = replaceAll ? occurrences : 1
      return `Successfully replaced ${replaced} occurrence(s) in ${filePath}`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error editing ${filePath}: ${msg}`
    }
  },
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

const shellTool: RegisteredTool = {
  definition: {
    name: 'shell',
    description: 'Execute a shell command. Returns stdout, stderr, exit code, and duration.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds (default: 10000)',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this command does',
        },
      },
      required: ['command'],
    },
  },
  executor: async (args, env) => {
    const command = args['command'] as string
    const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 10_000

    const result = await env.exec_command(command, timeoutMs)

    let output = ''
    if (result.stdout) output += result.stdout
    if (result.stderr) {
      if (output && !output.endsWith('\n')) output += '\n'
      output += result.stderr
    }

    if (result.timed_out) {
      output +=
        `\n[ERROR: Command timed out after ${timeoutMs}ms. Partial output is shown above. ` +
        `You can retry with a longer timeout by setting the timeout_ms parameter.]`
    }

    const summary = `[Exit code: ${result.exit_code}, Duration: ${result.duration_ms}ms]`
    return output ? `${output}\n${summary}` : summary
  },
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepTool: RegisteredTool = {
  definition: {
    name: 'grep',
    description: 'Search file contents using regex patterns. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory or file to search (default: working directory)',
        },
        glob_filter: {
          type: 'string',
          description: 'File pattern filter (e.g., "*.ts")',
        },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
        max_results: { type: 'integer', description: 'Maximum number of results (default: 100)' },
      },
      required: ['pattern'],
    },
  },
  executor: async (args, env) => {
    const pattern = args['pattern'] as string
    const searchPath = (args['path'] as string | undefined) ?? '.'
    const options = {
      glob_filter: args['glob_filter'] as string | undefined,
      case_insensitive: (args['case_insensitive'] as boolean | undefined) ?? false,
      max_results: (args['max_results'] as number | undefined) ?? 100,
    }

    try {
      const result = await env.grep(pattern, searchPath, options)
      return result || '(no matches)'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error searching: ${msg}`
    }
  },
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const globTool: RegisteredTool = {
  definition: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Returns paths sorted by modification time (newest first).',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.test.ts")',
        },
        path: {
          type: 'string',
          description: 'Base directory to search (default: working directory)',
        },
      },
      required: ['pattern'],
    },
  },
  executor: async (args, env) => {
    const pattern = args['pattern'] as string
    const searchPath = (args['path'] as string | undefined) ?? '.'

    try {
      const files = await env.glob(pattern, searchPath)
      if (files.length === 0) return '(no matches)'
      return files.join('\n')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error globbing: ${msg}`
    }
  },
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CORE_TOOLS: RegisteredTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
]

export { readFileTool, writeFileTool, editFileTool, shellTool, grepTool, globTool }
