/**
 * The jump from the header to a card.
 *
 * Two behaviours carry the feature: a mounted card is focused directly, and a
 * card that is not mounted yet is found by pulling history — bounded, and able
 * to tell "not in this conversation" apart from "took a few pages".
 *
 * @module client-focus.spec
 */

import { describe, expect, it, vi } from 'vitest'
import {
  focusCard,
  isCardMounted,
  MAX_PAGES,
  PAGE_SETTLE_MS,
  registerCard,
  revealCard,
} from '../src/client/focus.ts'

const CHILD = 'b084f8d4-0915'

/** A card that records what was done to it. */
function handle(): { expand: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn>; flash: ReturnType<typeof vi.fn> } {
  return { expand: vi.fn(), reveal: vi.fn(), flash: vi.fn() }
}

describe('the card registry', () => {
  it('focuses a mounted card: expand, scroll, mark', () => {
    const card = handle()
    const dispose = registerCard(CHILD, card)
    try {
      expect(isCardMounted(CHILD)).toBe(true)
      expect(focusCard(CHILD)).toBe(true)
      expect(card.expand).toHaveBeenCalledOnce()
      expect(card.reveal).toHaveBeenCalledOnce()
      expect(card.flash).toHaveBeenCalledOnce()
    } finally {
      dispose()
    }
  })

  it('withdraws the card on unmount, and focusing it then is not an error', () => {
    const dispose = registerCard(CHILD, handle())
    dispose()
    expect(isCardMounted(CHILD)).toBe(false)
    expect(focusCard(CHILD)).toBe(false)
  })

  it('keeps the replacement when a remount outruns the old cleanup', () => {
    // React registers the new effect before running the old cleanup when a key
    // changes; deleting by id alone would drop the live card.
    const stale = registerCard(CHILD, handle())
    const fresh = handle()
    const disposeFresh = registerCard(CHILD, fresh)
    stale()
    try {
      expect(focusCard(CHILD)).toBe(true)
      expect(fresh.expand).toHaveBeenCalledOnce()
    } finally {
      disposeFresh()
    }
  })

  it('reports a card that throws while focusing as not mounted', () => {
    const card = handle()
    card.expand.mockImplementation(() => {
      throw new Error('unmounted mid-flight')
    })
    const dispose = registerCard(CHILD, card)
    try {
      expect(focusCard(CHILD)).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe('revealCard', () => {
  /** Ports that answer from a script: each pull may reveal the card. */
  function ports(script: { revealOn?: number; pageHeight?: number; throwOnPull?: boolean }): {
    focus: ReturnType<typeof vi.fn>
    loadOlder: ReturnType<typeof vi.fn>
    measure: ReturnType<typeof vi.fn>
    wait: ReturnType<typeof vi.fn>
  } {
    let mounted = false
    let height = 100
    let pulls = 0
    return {
      focus: vi.fn(() => mounted),
      loadOlder: vi.fn(() => {
        pulls += 1
        if (script.throwOnPull === true) return Promise.reject(new Error('nope'))
        // A page arrives: it either brings the card or only more height.
        if (script.revealOn === pulls) mounted = true
        else height += script.pageHeight ?? 50
        return Promise.resolve()
      }),
      measure: vi.fn(() => height),
      wait: vi.fn(() => Promise.resolve()),
    }
  }

  it('answers immediately when the card is already mounted, without paging', async () => {
    const scripted = ports({})
    scripted.focus.mockReturnValue(true)
    expect(await revealCard(CHILD, scripted)).toBe('found')
    expect(scripted.loadOlder).not.toHaveBeenCalled()
  })

  it('pulls history until the card appears', async () => {
    const scripted = ports({ revealOn: 3 })
    expect(await revealCard(CHILD, scripted)).toBe('found')
    expect(scripted.loadOlder).toHaveBeenCalledTimes(3)
    expect(scripted.wait).toHaveBeenCalledWith(PAGE_SETTLE_MS)
  })

  it('gives up as soon as a pull adds nothing, without spending the budget', async () => {
    const scripted = ports({ pageHeight: 0 })
    expect(await revealCard(CHILD, scripted)).toBe('exhausted')
    expect(scripted.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('stops at the page budget when every pull adds content', async () => {
    const scripted = ports({})
    expect(await revealCard(CHILD, scripted)).toBe('exhausted')
    expect(scripted.loadOlder).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it('reports a throwing page pull as a failure instead of spinning', async () => {
    const scripted = ports({ throwOnPull: true })
    expect(await revealCard(CHILD, scripted)).toBe('failed')
    expect(scripted.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('still finds the card when the scroll height cannot be read', async () => {
    const scripted = ports({ revealOn: 2 })
    scripted.measure.mockReturnValue(null)
    expect(await revealCard(CHILD, scripted)).toBe('found')
  })
})
