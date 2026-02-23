/**
 * DOT parser for the Attractor pipeline definition language.
 *
 * Accepts a strict subset: one digraph per file, directed edges only,
 * typed attributes, commas between attributes.
 */

import { createGraph, addEdge, parseDuration } from '../types/graph.js'
import type { Graph, Node, Edge, NodeAttrs, EdgeAttrs } from '../types/graph.js'

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'IDENT'     // bare identifier
  | 'STRING'    // "quoted string"
  | 'NUMBER'    // integer or float
  | 'DURATION'  // 900s, 15m, 2h, 250ms, 1d
  | 'BOOL'      // true | false
  | 'ARROW'     // ->
  | 'LBRACE'    // {
  | 'RBRACE'    // }
  | 'LBRACKET'  // [
  | 'RBRACKET'  // ]
  | 'EQ'        // =
  | 'COMMA'     // ,
  | 'SEMI'      // ;
  | 'EOF'

interface Token {
  kind: TokenKind
  value: string
  line: number
}

function tokenize(src: string): Token[] {
  // Strip comments
  src = src.replace(/\/\/[^\n]*/g, '')
  src = src.replace(/\/\*[\s\S]*?\*\//g, '')

  const tokens: Token[] = []
  let i = 0
  let line = 1

  while (i < src.length) {
    const c = src[i]!

    // Whitespace
    if (/\s/.test(c)) {
      if (c === '\n') line++
      i++
      continue
    }

    // Arrow
    if (c === '-' && src[i + 1] === '>') {
      tokens.push({ kind: 'ARROW', value: '->', line })
      i += 2
      continue
    }

    // Single-char tokens
    if (c === '{') { tokens.push({ kind: 'LBRACE', value: '{', line }); i++; continue }
    if (c === '}') { tokens.push({ kind: 'RBRACE', value: '}', line }); i++; continue }
    if (c === '[') { tokens.push({ kind: 'LBRACKET', value: '[', line }); i++; continue }
    if (c === ']') { tokens.push({ kind: 'RBRACKET', value: ']', line }); i++; continue }
    if (c === '=') { tokens.push({ kind: 'EQ', value: '=', line }); i++; continue }
    if (c === ',') { tokens.push({ kind: 'COMMA', value: ',', line }); i++; continue }
    if (c === ';') { tokens.push({ kind: 'SEMI', value: ';', line }); i++; continue }

    // String
    if (c === '"') {
      let s = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          i++
          const esc = src[i]
          if (esc === '"') s += '"'
          else if (esc === 'n') s += '\n'
          else if (esc === 't') s += '\t'
          else if (esc === '\\') s += '\\'
          else s += esc ?? ''
        } else {
          s += src[i]
        }
        i++
      }
      i++ // closing "
      tokens.push({ kind: 'STRING', value: s, line })
      continue
    }

    // Number (integer or float, optional sign already stripped) or Duration
    if (/[0-9]/.test(c)) {
      let s = ''
      while (i < src.length && /[0-9.]/.test(src[i]!)) {
        s += src[i]; i++
      }
      // Duration suffix?
      const durSuffix = src.slice(i, i + 2)
      if (/^ms$/.test(durSuffix)) {
        s += 'ms'; i += 2
        tokens.push({ kind: 'DURATION', value: s, line })
      } else {
        const singleSuffix = src[i] ?? ''
        if (/[smhd]/.test(singleSuffix)) {
          s += singleSuffix; i++
          tokens.push({ kind: 'DURATION', value: s, line })
        } else {
          tokens.push({ kind: 'NUMBER', value: s, line })
        }
      }
      continue
    }

    // Identifier or keyword
    if (/[A-Za-z_]/.test(c)) {
      let s = ''
      while (i < src.length && /[A-Za-z0-9_.@-]/.test(src[i]!)) {
        s += src[i]; i++
      }
      if (s === 'true' || s === 'false') {
        tokens.push({ kind: 'BOOL', value: s, line })
      } else {
        tokens.push({ kind: 'IDENT', value: s, line })
      }
      continue
    }

    // Skip unknown
    i++
  }

  tokens.push({ kind: 'EOF', value: '', line })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'EOF', value: '', line: 0 }
  }

  private advance(): Token {
    const t = this.tokens[this.pos]!
    this.pos++
    return t
  }

  private expect(kind: TokenKind): Token {
    const t = this.peek()
    if (t.kind !== kind) {
      throw new Error(`Parse error at line ${t.line}: expected ${kind}, got ${t.kind} (${JSON.stringify(t.value)})`)
    }
    return this.advance()
  }

  private match(...kinds: TokenKind[]): boolean {
    return kinds.includes(this.peek().kind)
  }

  parse(): Graph {
    // Optional: 'strict' modifier — reject it
    if (this.match('IDENT') && this.peek().value === 'strict') {
      throw new Error('Attractor does not support strict digraphs')
    }

    const kw = this.expect('IDENT')
    if (kw.value !== 'digraph') {
      throw new Error(`Expected 'digraph', got '${kw.value}'`)
    }

    // Optional graph name
    let graphId = 'unnamed'
    if (this.match('IDENT')) {
      graphId = this.advance().value
    }

    this.expect('LBRACE')

    const g = createGraph(graphId)

    // Track default node/edge attrs from global + subgraph scopes
    const nodeDefaults: NodeAttrs[] = [{}]
    const edgeDefaults: EdgeAttrs[] = [{}]

    this.parseStatements(g, nodeDefaults, edgeDefaults)

    this.expect('RBRACE')
    return g
  }

  private parseStatements(g: Graph, nodeDefaults: NodeAttrs[], edgeDefaults: EdgeAttrs[]): void {
    while (!this.match('RBRACE', 'EOF')) {
      this.parseStatement(g, nodeDefaults, edgeDefaults)
    }
  }

  private parseStatement(g: Graph, nodeDefaults: NodeAttrs[], edgeDefaults: EdgeAttrs[]): void {
    const t = this.peek()

    // graph [ ... ] block
    if (t.kind === 'IDENT' && t.value === 'graph' && this.tokens[this.pos + 1]?.kind === 'LBRACKET') {
      this.advance() // consume 'graph'
      const attrs = this.parseAttrBlock()
      applyGraphAttrs(g, attrs)
      this.consumeOptionalSemi()
      return
    }

    // node [ ... ] defaults
    if (t.kind === 'IDENT' && t.value === 'node' && this.tokens[this.pos + 1]?.kind === 'LBRACKET') {
      this.advance()
      const attrs = this.parseAttrBlock()
      nodeDefaults[nodeDefaults.length - 1] = { ...nodeDefaults[nodeDefaults.length - 1], ...parseNodeAttrs(attrs) }
      this.consumeOptionalSemi()
      return
    }

    // edge [ ... ] defaults
    if (t.kind === 'IDENT' && t.value === 'edge' && this.tokens[this.pos + 1]?.kind === 'LBRACKET') {
      this.advance()
      const attrs = this.parseAttrBlock()
      edgeDefaults[edgeDefaults.length - 1] = { ...edgeDefaults[edgeDefaults.length - 1], ...parseEdgeAttrs(attrs) }
      this.consumeOptionalSemi()
      return
    }

    // subgraph { ... }
    if (t.kind === 'IDENT' && t.value === 'subgraph') {
      this.advance()
      // Optional subgraph name
      let subId: string | undefined
      if (this.match('IDENT')) {
        subId = this.advance().value
      }
      this.expect('LBRACE')

      // Push new defaults scope
      const mergedNodeDef = { ...nodeDefaults[nodeDefaults.length - 1] }
      const mergedEdgeDef = { ...edgeDefaults[edgeDefaults.length - 1] }

      // Optional label inside subgraph for class derivation
      let subgraphLabel: string | undefined
      // We need to peek for label= ... before parsing statements
      // We'll handle this inline: scan for a label=value at the start
      if (this.peek().kind === 'IDENT' && this.peek().value === 'label') {
        this.advance()
        this.expect('EQ')
        subgraphLabel = this.parseValue()
        this.consumeOptionalSemi()
      }

      const derivedClass = subId ? deriveClassFromId(subId, subgraphLabel) : undefined

      // Track nodes added in this subgraph for class assignment
      const nodesBefore = new Set(g.nodes.keys())

      nodeDefaults.push({ ...mergedNodeDef })
      edgeDefaults.push({ ...mergedEdgeDef })

      this.parseStatements(g, nodeDefaults, edgeDefaults)

      nodeDefaults.pop()
      edgeDefaults.pop()

      // Apply derived class to new nodes
      if (derivedClass) {
        for (const [id, node] of g.nodes) {
          if (!nodesBefore.has(id)) {
            const existing = node.attrs.class
            if (!existing) {
              node.attrs.class = derivedClass
            } else if (!existing.split(',').map(s => s.trim()).includes(derivedClass)) {
              node.attrs.class = existing + ',' + derivedClass
            }
          }
        }
      }

      this.expect('RBRACE')
      return
    }

    // rankdir=LR and other top-level key=value graph attributes
    if (t.kind === 'IDENT' && this.tokens[this.pos + 1]?.kind === 'EQ') {
      // Disambiguate: could be a node named "something" vs a graph attr
      // Actually in our grammar: Identifier '=' Value ';'? is a graph attr
      const key = this.advance().value
      this.expect('EQ')
      const value = this.parseValue()
      this.consumeOptionalSemi()
      // Apply to graph if recognized
      applyGraphAttr(g, key, value)
      return
    }

    // Node or edge statement — starts with an identifier
    if (t.kind === 'IDENT') {
      const id = this.advance().value

      // Edge: id -> ...
      if (this.match('ARROW')) {
        const ids = [id]
        while (this.match('ARROW')) {
          this.advance()
          const next = this.expect('IDENT')
          ids.push(next.value)
        }

        // Optional attributes
        let rawAttrs: Record<string, string> = {}
        if (this.match('LBRACKET')) {
          rawAttrs = this.parseAttrBlock()
        }
        this.consumeOptionalSemi()

        const edgeAttrParsed = parseEdgeAttrs(rawAttrs)
        const mergedEdgeDefaults = { ...edgeDefaults[edgeDefaults.length - 1] }

        // Ensure referenced nodes exist
        for (const nodeId of ids) {
          if (!g.nodes.has(nodeId)) {
            const defaults = { ...nodeDefaults[nodeDefaults.length - 1] }
            g.nodes.set(nodeId, { id: nodeId, attrs: defaults })
          }
        }

        // Create edges for each pair
        for (let i = 0; i < ids.length - 1; i++) {
          const edge: Edge = {
            from: ids[i]!,
            to: ids[i + 1]!,
            attrs: { ...mergedEdgeDefaults, ...edgeAttrParsed },
          }
          addEdge(g, edge)
        }
        return
      }

      // Node statement: id [ ... ]? ;?
      let rawAttrs: Record<string, string> = {}
      if (this.match('LBRACKET')) {
        rawAttrs = this.parseAttrBlock()
      }
      this.consumeOptionalSemi()

      const defaults = { ...nodeDefaults[nodeDefaults.length - 1] }
      const nodeAttrs = { ...defaults, ...parseNodeAttrs(rawAttrs) }

      if (g.nodes.has(id)) {
        // Merge into existing node
        Object.assign(g.nodes.get(id)!.attrs, nodeAttrs)
      } else {
        g.nodes.set(id, { id, attrs: nodeAttrs })
      }
      return
    }

    // Unknown token — skip
    this.advance()
  }

  private parseAttrBlock(): Record<string, string> {
    this.expect('LBRACKET')
    const attrs: Record<string, string> = {}

    while (!this.match('RBRACKET', 'EOF')) {
      const key = this.parseKey()
      this.expect('EQ')
      const value = this.parseValue()
      attrs[key] = value

      // Comma is required per spec, but tolerate missing
      if (this.match('COMMA')) this.advance()
    }

    this.expect('RBRACKET')
    return attrs
  }

  private parseKey(): string {
    // Key can be identifier or qualified (identifier.identifier...)
    let key = this.expect('IDENT').value
    while (this.match('IDENT') && this.tokens[this.pos - 1]?.value.endsWith('.')) {
      key += this.advance().value
    }
    // Also handle foo.bar directly via peek: key already consumed, now check if next is part of qualified id
    // Actually, tokenizer includes dots in identifiers (see /[A-Za-z0-9_.@-]/) so foo.bar is one token
    return key
  }

  private parseValue(): string {
    const t = this.peek()
    if (t.kind === 'STRING') { this.advance(); return t.value }
    if (t.kind === 'IDENT' || t.kind === 'BOOL') { this.advance(); return t.value }
    if (t.kind === 'NUMBER') { this.advance(); return t.value }
    if (t.kind === 'DURATION') { this.advance(); return t.value }
    throw new Error(`Parse error at line ${t.line}: expected a value, got ${t.kind} (${JSON.stringify(t.value)})`)
  }

  private consumeOptionalSemi(): void {
    if (this.match('SEMI')) this.advance()
  }
}

// ---------------------------------------------------------------------------
// Attribute parsing helpers
// ---------------------------------------------------------------------------

function applyGraphAttrs(g: Graph, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs)) {
    applyGraphAttr(g, k, v)
  }
}

function applyGraphAttr(g: Graph, key: string, value: string): void {
  switch (key) {
    case 'goal':                  g.goal = value; break
    case 'label':                 g.label = value; break
    case 'model_stylesheet':      g.model_stylesheet = value; break
    case 'default_max_retry':     g.default_max_retry = parseInt(value, 10); break
    case 'retry_target':          g.retry_target = value; break
    case 'fallback_retry_target': g.fallback_retry_target = value; break
    case 'default_fidelity':      g.default_fidelity = value; break
    // Ignore known Graphviz display attrs like rankdir
  }
}

function parseNodeAttrs(raw: Record<string, string>): NodeAttrs {
  const attrs: NodeAttrs = {}
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'label':                  attrs.label = v; break
      case 'shape':                  attrs.shape = v; break
      case 'type':                   attrs.type = v; break
      case 'prompt':                 attrs.prompt = v; break
      case 'max_retries':            attrs.max_retries = parseInt(v, 10); break
      case 'goal_gate':              attrs.goal_gate = v === 'true'; break
      case 'retry_target':           attrs.retry_target = v; break
      case 'fallback_retry_target':  attrs.fallback_retry_target = v; break
      case 'fidelity':               attrs.fidelity = v; break
      case 'thread_id':              attrs.thread_id = v; break
      case 'class':                  attrs.class = v; break
      case 'timeout':                attrs.timeout = parseDuration(v); break
      case 'llm_model':              attrs.llm_model = v; break
      case 'llm_provider':           attrs.llm_provider = v; break
      case 'reasoning_effort':       attrs.reasoning_effort = v; break
      case 'auto_status':            attrs.auto_status = v === 'true'; break
      case 'allow_partial':          attrs.allow_partial = v === 'true'; break
      default:                       attrs[k] = v; break
    }
  }
  return attrs
}

function parseEdgeAttrs(raw: Record<string, string>): EdgeAttrs {
  const attrs: EdgeAttrs = {}
  for (const [k, v] of Object.entries(raw)) {
    switch (k) {
      case 'label':        attrs.label = v; break
      case 'condition':    attrs.condition = v; break
      case 'weight':       attrs.weight = parseInt(v, 10); break
      case 'fidelity':     attrs.fidelity = v; break
      case 'thread_id':    attrs.thread_id = v; break
      case 'loop_restart': attrs.loop_restart = v === 'true'; break
    }
  }
  return attrs
}

function deriveClassFromId(subId: string, label?: string): string {
  const src = label ?? subId
  return src.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseDot(source: string): Graph {
  const tokens = tokenize(source)
  const parser = new Parser(tokens)
  return parser.parse()
}
