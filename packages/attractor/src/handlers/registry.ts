/**
 * HandlerRegistry — maps type strings to handler instances.
 */

import type { Node } from '../types/graph.js'
import { SHAPE_TO_HANDLER_TYPE } from '../types/graph.js'
import type { Handler } from './interface.js'

export class HandlerRegistry {
  private handlers: Map<string, Handler> = new Map()
  private _default: Handler | null = null

  register(typeString: string, handler: Handler): void {
    this.handlers.set(typeString, handler)
  }

  setDefault(handler: Handler): void {
    this._default = handler
  }

  resolve(node: Node): Handler {
    // 1. Explicit type attribute
    if (node.attrs.type) {
      const h = this.handlers.get(node.attrs.type)
      if (h) return h
    }

    // 2. Shape-based resolution
    const shape = node.attrs.shape ?? 'box'
    const handlerType = SHAPE_TO_HANDLER_TYPE[shape]
    if (handlerType) {
      const h = this.handlers.get(handlerType)
      if (h) return h
    }

    // 3. Default
    if (this._default) return this._default

    throw new Error(`No handler found for node '${node.id}' (shape=${shape}, type=${node.attrs.type ?? 'none'})`)
  }
}
