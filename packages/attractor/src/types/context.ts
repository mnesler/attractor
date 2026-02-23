/**
 * Context — thread-safe (in Node.js: simply mutual exclusion is not needed
 * because execution is single-threaded at top level; parallel branches clone
 * the context) key-value store for a pipeline run.
 */

export class Context {
  private _values: Map<string, unknown> = new Map()
  private _logs: string[] = []

  set(key: string, value: unknown): void {
    this._values.set(key, value)
  }

  get(key: string, defaultValue: unknown = undefined): unknown {
    if (this._values.has(key)) return this._values.get(key)
    return defaultValue
  }

  getString(key: string, defaultValue = ''): string {
    const v = this.get(key)
    if (v === undefined || v === null) return defaultValue
    return String(v)
  }

  has(key: string): boolean {
    return this._values.has(key)
  }

  delete(key: string): void {
    this._values.delete(key)
  }

  applyUpdates(updates: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(updates)) {
      this._values.set(k, v)
    }
  }

  appendLog(entry: string): void {
    this._logs.push(entry)
  }

  get logs(): readonly string[] {
    return this._logs
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [k, v] of this._values) {
      result[k] = v
    }
    return result
  }

  clone(): Context {
    const c = new Context()
    for (const [k, v] of this._values) {
      c._values.set(k, v)
    }
    c._logs.push(...this._logs)
    return c
  }

  static fromSnapshot(snap: Record<string, unknown>): Context {
    const c = new Context()
    for (const [k, v] of Object.entries(snap)) {
      c._values.set(k, v)
    }
    return c
  }
}
