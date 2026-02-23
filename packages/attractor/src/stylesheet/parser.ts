/**
 * Model stylesheet parser.
 *
 * Grammar:
 *   Stylesheet    ::= Rule+
 *   Rule          ::= Selector '{' Declaration ( ';' Declaration )* ';'? '}'
 *   Selector      ::= '*' | '#' Identifier | '.' ClassName
 *   ClassName     ::= [a-z0-9-]+
 *   Declaration   ::= Property ':' PropertyValue
 *   Property      ::= 'llm_model' | 'llm_provider' | 'reasoning_effort'
 *   PropertyValue ::= String | identifier
 */

export type StylesheetSelectorKind = 'universal' | 'class' | 'id'

export interface StylesheetSelector {
  kind: StylesheetSelectorKind
  value: string   // empty for universal, class name or node id otherwise
  specificity: number  // 0=universal, 1=class, 2=id
}

export interface StylesheetDeclaration {
  property: string
  value: string
}

export interface StylesheetRule {
  selector: StylesheetSelector
  declarations: StylesheetDeclaration[]
}

export type Stylesheet = StylesheetRule[]

export function parseStylesheet(src: string): Stylesheet {
  if (!src || !src.trim()) return []

  const rules: StylesheetRule[] = []
  let i = 0

  function skipWs(): void {
    while (i < src.length && /\s/.test(src[i]!)) i++
  }

  function readIdent(): string {
    let s = ''
    while (i < src.length && /[A-Za-z0-9_.-]/.test(src[i]!)) {
      s += src[i++]
    }
    return s
  }

  function readClassOrId(): string {
    let s = ''
    while (i < src.length && /[a-z0-9_-]/.test(src[i]!)) {
      s += src[i++]
    }
    return s
  }

  function readValue(): string {
    skipWs()
    if (src[i] === '"') {
      let s = ''
      i++ // skip opening "
      while (i < src.length && src[i] !== '"') {
        s += src[i++]
      }
      i++ // skip closing "
      return s
    }
    // unquoted value: read until ; or }
    let s = ''
    while (i < src.length && src[i] !== ';' && src[i] !== '}') {
      s += src[i++]
    }
    return s.trim()
  }

  while (i < src.length) {
    skipWs()
    if (i >= src.length) break

    // Skip comments
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    let selector: StylesheetSelector

    // Universal selector
    if (src[i] === '*') {
      i++
      selector = { kind: 'universal', value: '', specificity: 0 }
    }
    // ID selector
    else if (src[i] === '#') {
      i++
      const id = readIdent()
      selector = { kind: 'id', value: id, specificity: 2 }
    }
    // Class selector
    else if (src[i] === '.') {
      i++
      const cls = readClassOrId()
      selector = { kind: 'class', value: cls, specificity: 1 }
    }
    // Unknown — skip to next {
    else {
      while (i < src.length && src[i] !== '{') i++
      if (i < src.length) {
        let depth = 1; i++
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++
          else if (src[i] === '}') depth--
          i++
        }
      }
      continue
    }

    skipWs()
    if (i >= src.length || src[i] !== '{') continue
    i++ // skip {

    const declarations: StylesheetDeclaration[] = []

    while (i < src.length && src[i] !== '}') {
      skipWs()
      if (i >= src.length || src[i] === '}') break

      const prop = readIdent()
      skipWs()
      if (src[i] !== ':') {
        // skip to ; or }
        while (i < src.length && src[i] !== ';' && src[i] !== '}') i++
        if (src[i] === ';') i++
        continue
      }
      i++ // skip :
      const val = readValue()

      if (prop && val) {
        declarations.push({ property: prop, value: val })
      }

      skipWs()
      if (src[i] === ';') i++
    }

    if (i < src.length && src[i] === '}') i++

    rules.push({ selector, declarations })
  }

  return rules
}

/** Apply a stylesheet to a node's attributes. Only sets attrs that are not already set. */
export function applyStylesheetToNode(
  nodeId: string,
  nodeClass: string | undefined,
  nodeAttrs: Record<string, unknown>,
  stylesheet: Stylesheet,
): void {
  const nodeClasses = nodeClass ? nodeClass.split(',').map(s => s.trim()) : []

  // For each property, find the declaration with highest specificity (then highest order = last wins)
  const bestDecl = new Map<string, { specificity: number; order: number; value: string }>()

  for (let idx = 0; idx < stylesheet.length; idx++) {
    const rule = stylesheet[idx]!
    let matches = false
    if (rule.selector.kind === 'universal') {
      matches = true
    } else if (rule.selector.kind === 'id') {
      matches = rule.selector.value === nodeId
    } else if (rule.selector.kind === 'class') {
      matches = nodeClasses.includes(rule.selector.value)
    }
    if (!matches) continue

    for (const decl of rule.declarations) {
      const current = bestDecl.get(decl.property)
      if (
        !current ||
        rule.selector.specificity > current.specificity ||
        (rule.selector.specificity === current.specificity && idx >= current.order)
      ) {
        bestDecl.set(decl.property, { specificity: rule.selector.specificity, order: idx, value: decl.value })
      }
    }
  }

  // Apply best values only if not already explicitly set on the node
  for (const [prop, { value }] of bestDecl) {
    if (nodeAttrs[prop] === undefined) {
      nodeAttrs[prop] = value
    }
  }
}
