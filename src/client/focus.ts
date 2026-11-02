/**
 * "Take me to that run's card": the link between the header's jump list and the
 * card itself.
 *
 * The two live in different parts of the tree — the header is rendered by the
 * conversation skeleton, the card by a chat-node renderer — so they cannot pass
 * props. They can share a module, though, and that is all this is: a registry of
 * mounted cards plus the paging loop that finds one that is not mounted yet.
 *
 * The loop is the honest part. The chat only mounts the pages it has loaded, so
 * a card from forty turns ago does not exist in the DOM until history is pulled
 * in. `loadOlder()` never rejects and silently does nothing when there is
 * nothing left, so "stop" cannot be an exception — it is a measurement: if a
 * page pull does not change the scroll height, there was no page.
 *
 * @module dsh-subagent-codebuddy/client/focus
 */

/** What a mounted card lets the header do to it. */
export interface CardHandle {
  /** Open the card's body, if it is collapsed. */
  expand(): void
  /** Bring it into the middle of the viewport. */
  reveal(): void
  /** Mark it briefly, so the eye can land on the right card after a jump. */
  flash(): void
}

/** Cards currently mounted, keyed by run id. */
const cards = new Map<string, CardHandle>()

/**
 * Advertise one mounted card.
 * @param childId - the run the card renders.
 * @param handle - what the header may do to it.
 * @returns the disposer a React effect returns on unmount.
 */
export function registerCard(childId: string, handle: CardHandle): () => void {
  cards.set(childId, handle)
  return () => {
    // Identity-guarded: a remount registers the replacement before the old
    // effect's cleanup runs, and deleting by id alone would drop the new one.
    if (cards.get(childId) === handle) cards.delete(childId)
  }
}

/**
 * Expand, scroll to, and mark one run's card.
 * @param childId - the run to focus.
 * @returns true when a mounted card handled it.
 */
export function focusCard(childId: string): boolean {
  const card = cards.get(childId)
  if (card === undefined) return false
  try {
    card.expand()
    card.reveal()
    card.flash()
    return true
  } catch {
    // A card mid-unmount is not a failure worth surfacing: the caller treats it
    // as "not mounted" and pages on.
    return false
  }
}

/**
 * Is this run's card on screen right now?
 * @param childId - the run to look for.
 * @returns true when a mounted card advertises it.
 */
export function isCardMounted(childId: string): boolean {
  return cards.has(childId)
}

/** Pages of history the finder will pull before giving up. */
export const MAX_PAGES = 12

/** How long one page pull is given to render before the next look. */
export const PAGE_SETTLE_MS = 140

/** What happened when the header asked to be taken to a card. */
export type RevealOutcome = 'found' | 'exhausted' | 'failed'

/**
 * What {@link revealCard} needs from the page. Injected rather than imported so
 * the loop can be asserted without a browser: the three interesting outcomes
 * are "mounted already", "came back in a page", and "not in this conversation".
 */
export interface RevealPorts {
  /** Attempt to focus the card; false means it is not mounted. */
  focus: (childId: string) => boolean
  /** Pull one older page of history. Never rejects in the real runtime. */
  loadOlder: () => Promise<unknown> | unknown
  /** Current scroll height of the conversation, or null when it cannot be read. */
  measure: () => number | null
  /** Wait long enough for one page to render. */
  wait: (ms: number) => Promise<void>
}

/**
 * Find a run's card, pulling history until it appears.
 *
 * Bounded on purpose: this runs from a click, so it must end. The scroll-height
 * check is what keeps the bound from being reached in the common case of a card
 * that simply is not in this conversation at all.
 * @param childId - the run to find.
 * @param ports - page access, injected.
 * @param pages - page budget.
 * @returns how the search ended.
 */
export async function revealCard(
  childId: string,
  ports: RevealPorts,
  pages: number = MAX_PAGES,
): Promise<RevealOutcome> {
  if (ports.focus(childId)) return 'found'
  for (let pulled = 0; pulled < pages; pulled += 1) {
    const before = ports.measure()
    try {
      await ports.loadOlder()
    } catch {
      // The real runtime swallows its own failures, so a throw here means the
      // page state is not what this assumes; stop rather than spin.
      return 'failed'
    }
    await ports.wait(PAGE_SETTLE_MS)
    if (ports.focus(childId)) return 'found'
    const after = ports.measure()
    if (before !== null && after !== null && after === before) return 'exhausted'
  }
  return 'exhausted'
}
