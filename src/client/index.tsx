/**
 * Browser half of the CodeBuddy subagent plugin.
 *
 * Registers one conversation node definition, its keyed renderer, and one
 * session-header action. Loaded by the host's client module loader because
 * `package.json` declares `dsh.client`.
 *
 * The shape here is copied from the shipped packages that do the same thing
 * (`dsh-client-ui-goal` is the smallest example): a static `inject` naming the
 * services, then plain calls on them in `apply`. Two names have to be exact or
 * nothing happens at all:
 *
 * - the service that owns conversation Definitions is `uiConversation`, reached
 *   as `ctx.uiConversation.events` (there is no `conversationEvents` service —
 *   polling for one can only ever time out);
 * - the renderer slot is `conversation.chat.node`, keyed by the *node* kind the
 *   definition emits, so `kind: 'codebuddy-run'` and `key: 'codebuddy-run'` are
 *   two halves of the same lookup.
 *
 * The header action is a third, independent registration into a *list* slot:
 * entries there render side by side by ascending `order`, so this one sits after
 * the host's own subagent catalog (`order: 10`) instead of replacing it.
 *
 * A static `inject` makes this entry wait for those services instead of racing
 * them, which is what the loader expects; it stays pending (and the boot audit
 * fails) only if a listed service never activates.
 */

import { codebuddyRunDefinition, CODEBUDDY_NODE_KIND } from './definition.ts'
import { RunsHeaderAction } from './header.tsx'
import { CodebuddyRunPanel } from './panel.tsx'

/** Services the registration needs; the loader holds the entry until they exist. */
export const inject = ['slots', 'uiConversation', 'sessions']

/** The slot every chat node renderer registers into, keyed by node kind. */
const CHAT_NODE_SLOT = 'conversation.chat.node'

/**
 * The additive seat beside the session title. `order: 20` puts this entry to
 * the right of the host's own subagent catalog.
 */
const HEADER_SLOT = 'conversation.session.header.actions'

/** The slice of the conversation service this module uses. */
interface ConversationService {
  events: { register: (definition: unknown) => unknown }
}

/** The slice of the slot registry this module uses. */
interface SlotsService {
  inject: (name: string, factory: () => unknown) => unknown
  register: (declaration: Record<string, unknown>, component: unknown) => unknown
}

/**
 * The slice of the sessions service this module uses: one session's conversation
 * face, which is how a plugin pages history it does not own.
 */
interface SessionsService {
  scope?: (id: string) => { conversation?: { loadOlder?: () => Promise<void> } } | undefined
}

/** The part of the client context this module touches. */
interface ClientContext {
  slots: SlotsService
  uiConversation: ConversationService
  sessions?: SessionsService
}

/**
 * Plugin body: publish the Definition, then the renderer that draws it, then the
 * header entry that jumps to it.
 *
 * Every call is wrapped because a renderer is cosmetic: a duplicate `kind`
 * (a stale bundle still mounted) or a slot name the host no longer serves
 * should leave the plugin active and the failure legible in the console, not
 * turn the entry into a FAILED fiber.
 * @param ctx - client root context handed over by the module loader.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.uiConversation.events.register(codebuddyRunDefinition)
  } catch (error) {
    console.error('subagent-codebuddy: conversation definition not registered', error)
    return
  }
  try {
    ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({
      name: CHAT_NODE_SLOT,
      key: CODEBUDDY_NODE_KIND,
    }, CodebuddyRunPanel))
  } catch (error) {
    console.error(`subagent-codebuddy: "${CHAT_NODE_SLOT}" renderer not registered`, error)
  }
  try {
    const sessions = ctx.sessions
    ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
      name: HEADER_SLOT,
      id: 'codebuddy-runs',
      order: 20,
    }, (props: { sessionId?: string }) => (
      <RunsHeaderAction
        {...props.sessionId === undefined ? {} : { sessionId: props.sessionId }}
        // The card may sit in history the chat has not loaded; paging is a
        // session-scoped conversation op, and this closure is the only place
        // that can address it (`sessions.scope(id).conversation`).
        loadOlder={() => sessions?.scope?.(props.sessionId ?? '')?.conversation?.loadOlder?.() ?? Promise.resolve()}
      />
    )))
  } catch (error) {
    console.error(`subagent-codebuddy: "${HEADER_SLOT}" action not registered`, error)
  }
}
