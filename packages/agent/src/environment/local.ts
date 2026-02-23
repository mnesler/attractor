import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import type { ExecutionEnvironment, ExecResult, DirEntry, GrepOptions } from './interface.js'

// ---------------------------------------------------------------------------
// Shell quoting (single-quote POSIX style)
// ---------------------------------------------------------------------------

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// ---------------------------------------------------------------------------
// Glob pattern → RegExp
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  let p = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        p += '(?:[^/]+/)*'
        i += 3
      } else {
        p += '.*'
        i += 2
      }
    } else if (c === '*') {
      p += '[^/]*'
      i++
    } else if (c === '?') {
      p += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      p += '\\' + c
      i++
    } else {
      p += c
      i++
    }
  }
  return new RegExp('^' + p + '$')
}

// ---------------------------------------------------------------------------
// Sensitive env var patterns to exclude
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERN = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/i
const ALWAYS_INCLUDE = /^(PATH|HOME|USER|SHELL|LANG|TERM|TMPDIR|GOPATH|CARGO_HOME|NVM_DIR|PYENV_ROOT|JAVA_HOME|ANDROID_HOME|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|LOGNAME|USERNAME)$/i

// ---------------------------------------------------------------------------
// LocalExecutionEnvironment
// ---------------------------------------------------------------------------

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private readonly _working_directory: string

  constructor(workingDirectory?: string) {
    this._working_directory = workingDirectory ?? process.cwd()
  }

  // --------------------------------------------------------------------------
  // File operations
  // --------------------------------------------------------------------------

  async read_file(filePath: string, offset?: number, limit?: number): Promise<string> {
    const resolved = path.resolve(this._working_directory, filePath)
    const raw = await fs.readFile(resolved, 'utf-8')
    const lines = raw.split('\n')

    const start = (offset ?? 1) - 1  // 1-based → 0-based
    const end = limit !== undefined ? start + limit : undefined
    const slice = end !== undefined ? lines.slice(start, end) : lines.slice(start)
    return slice.join('\n')
  }

  async write_file(filePath: string, content: string): Promise<void> {
    const resolved = path.resolve(this._working_directory, filePath)
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, content, 'utf-8')
  }

  async file_exists(filePath: string): Promise<boolean> {
    const resolved = path.resolve(this._working_directory, filePath)
    try {
      await fs.access(resolved)
      return true
    } catch {
      return false
    }
  }

  async list_directory(dirPath: string, depth: number): Promise<DirEntry[]> {
    const resolved = path.resolve(this._working_directory, dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const result: DirEntry[] = []

    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name)
      let size: number | undefined
      if (!entry.isDirectory()) {
        try {
          const stat = await fs.stat(fullPath)
          size = stat.size
        } catch { /* ignore */ }
      }
      result.push({ name: entry.name, is_dir: entry.isDirectory(), size })

      if (entry.isDirectory() && depth > 1) {
        const subEntries = await this.list_directory(
          path.join(dirPath, entry.name),
          depth - 1,
        )
        result.push(...subEntries.map(e => ({ ...e, name: path.join(entry.name, e.name) })))
      }
    }
    return result
  }

  // --------------------------------------------------------------------------
  // Command execution
  // --------------------------------------------------------------------------

  async exec_command(
    command: string,
    timeout_ms: number,
    working_dir?: string,
    env_vars?: Record<string, string>,
  ): Promise<ExecResult> {
    const cwd = working_dir ?? this._working_directory
    const env = this.buildEnv(env_vars)
    const start = Date.now()

    return new Promise<ExecResult>((resolve) => {
      const isWindows = process.platform === 'win32'
      const shell = isWindows ? 'cmd.exe' : '/bin/bash'
      const shellArgs = isWindows ? ['/c', command] : ['-c', command]

      const child = spawn(shell, shellArgs, {
        cwd,
        env,
        detached: !isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      const killTimer = setTimeout(() => {
        timedOut = true
        try {
          if (isWindows) {
            child.kill('SIGTERM')
          } else {
            process.kill(-child.pid!, 'SIGTERM')
          }
        } catch { /* process already exited */ }

        setTimeout(() => {
          try {
            if (isWindows) {
              child.kill('SIGKILL')
            } else {
              process.kill(-child.pid!, 'SIGKILL')
            }
          } catch { /* ignore */ }
        }, 2000)
      }, timeout_ms)

      child.on('close', (code) => {
        clearTimeout(killTimer)
        resolve({
          stdout,
          stderr,
          exit_code: code ?? 0,
          timed_out: timedOut,
          duration_ms: Date.now() - start,
        })
      })

      child.on('error', (err) => {
        clearTimeout(killTimer)
        resolve({
          stdout,
          stderr: stderr + '\n' + String(err),
          exit_code: 1,
          timed_out: false,
          duration_ms: Date.now() - start,
        })
      })
    })
  }

  // --------------------------------------------------------------------------
  // Search operations
  // --------------------------------------------------------------------------

  async grep(pattern: string, searchPath: string, options?: GrepOptions): Promise<string> {
    const resolved = path.resolve(this._working_directory, searchPath)

    // Build rg command
    let cmd = `rg --line-number --with-filename`
    if (options?.case_insensitive) cmd += ' -i'
    if (options?.glob_filter) cmd += ` -g ${shellQuote(options.glob_filter)}`
    if (options?.max_results) cmd += ` -m ${options.max_results}`
    cmd += ` -- ${shellQuote(pattern)} ${shellQuote(resolved)}`

    const rgResult = await this.exec_command(cmd, 30_000)
    // rg exit 0 = matches found, 1 = no matches, 2 = error
    if (rgResult.exit_code === 0 || rgResult.exit_code === 1) {
      return rgResult.stdout
    }

    // Fallback to grep
    let grepCmd = `grep -rn`
    if (options?.case_insensitive) grepCmd += 'i'
    if (options?.glob_filter) grepCmd += ` --include=${shellQuote(options.glob_filter)}`
    grepCmd += ` -- ${shellQuote(pattern)} ${shellQuote(resolved)}`

    const grepResult = await this.exec_command(grepCmd, 30_000)
    return grepResult.stdout
  }

  async glob(pattern: string, searchPath: string): Promise<string[]> {
    const resolved = path.resolve(this._working_directory, searchPath)
    const regex = globToRegex(pattern)

    interface FileEntry { filePath: string; mtime: Date }
    const allFiles: FileEntry[] = []

    const walk = async (dir: string) => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        // Skip common non-project directories
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else {
          try {
            const stat = await fs.stat(full)
            allFiles.push({ filePath: full, mtime: stat.mtime })
          } catch { /* ignore */ }
        }
      }
    }

    await walk(resolved)

    // Sort by mtime descending (newest first)
    allFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    return allFiles
      .map(f => path.relative(resolved, f.filePath))
      .filter(rel => regex.test(rel))
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> { /* no-op for local */ }
  async cleanup(): Promise<void> { /* no-op for local */ }

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  working_directory(): string {
    return this._working_directory
  }

  platform(): string {
    switch (process.platform) {
      case 'darwin': return 'darwin'
      case 'win32': return 'windows'
      default: return 'linux'
    }
  }

  os_version(): string {
    return `${os.type()} ${os.release()}`
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private buildEnv(extra?: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (ALWAYS_INCLUDE.test(key)) {
        filtered[key] = value
      } else if (!SENSITIVE_PATTERN.test(key)) {
        filtered[key] = value
      }
    }
    if (extra) Object.assign(filtered, extra)
    return filtered
  }
}
