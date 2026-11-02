/**
 * The shipped browser bundle, loaded the way the page loads it.
 *
 * This is a guard against the failure that took the window down once already:
 * the bundle is only useful if it exports `inject` naming services that exist.
 * A missing export makes the loader activate the entry immediately, the
 * registration then waits for something that never arrives, and the boot audit
 * reports a pending entry. Reading it back out of `lib/client.js` also proves
 * the build wrapper still emits the CJS factory shape the loader expects.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const BUNDLE = 'lib/client.js'

/** Minimal React surface the panel and jsx runtime touch. */
const react = { useState: (initial: unknown) => [initial, () => {}], useMemo: (fn: () => unknown) => fn() }
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: Symbol('fragment') }

interface Registration {
  id: string
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}

/** Execute the bundle against a stub loader and return what it exported. */
function materialize(): Record<string, unknown> {
  const captured: Registration[] = []
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { __ModuleLoader__: { load: (registration: Registration) => captured.push(registration) } }
  try {
    new Function(readFileSync(BUNDLE, 'utf8'))()
  } finally {
    globals.window = previous
  }
  const registration = captured[0]
  if (registration === undefined) throw new Error('the bundle registered no factory')
  return registration.factory(spec => {
    if (spec === 'react') return react
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require("${spec}")`)
  })
}

describe('client bundle', () => {
  it.skipIf(!existsSync(BUNDLE))('exports the services the loader waits for', () => {
    const exports = materialize()
    // `sessions` joined the list when the header action started paging history
    // to reach a card that is not mounted yet.
    expect(exports.inject).toEqual(['slots', 'uiConversation', 'sessions'])
    expect(typeof exports.apply).toBe('function')
  })

  it.skipIf(!existsSync(BUNDLE))('registers the definition, the renderer, and the header jump entry', () => {
    const exports = materialize()
    const registered: unknown[] = []
    const slots: Record<string, unknown>[] = []
    const ctx = {
      uiConversation: { events: { register: (definition: unknown) => registered.push(definition) } },
      sessions: { scope: () => undefined },
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (declaration: Record<string, unknown>) => {
          slots.push(declaration)
          return () => {}
        },
      },
    }
    ;(exports.apply as (context: unknown) => void)(ctx)

    expect(registered).toHaveLength(1)
    expect((registered[0] as { kind: string }).kind).toBe('codebuddy-run')
    expect(slots).toEqual([
      { name: 'conversation.chat.node', key: 'codebuddy-run' },
      // Additive: an `id` and an `order` beside the host's own catalog entry
      // (`order: 10`), never a replacement for it.
      { name: 'conversation.session.header.actions', id: 'codebuddy-runs', order: 20 },
    ])
  })

  it.skipIf(!existsSync(BUNDLE))('stays active when a host surface is missing', () => {
    const exports = materialize()
    const ctx = { uiConversation: { events: { register: () => { throw new Error('duplicate kind') } } }, slots: {} }
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => (exports.apply as (context: unknown) => void)(ctx)).not.toThrow()
      expect(reported).toHaveBeenCalled()
    } finally {
      reported.mockRestore()
    }
  })
})
