/**
 * The status dot's palette, shared by everything that shows a run.
 *
 * The card and the session header's jump list are different surfaces describing
 * the same run, so a colour that means "running" in one of them has to mean the
 * same thing in the other. Keeping the table in one module is the only thing
 * that makes that true: two copies drift the first time one is tweaked, and the
 * reader then has to relearn the palette per surface.
 *
 * `delegated` and `refused` share the amber on purpose — both mean "handed off,
 * no verdict yet / not taken up" rather than success or failure.
 *
 * @module dsh-subagent-codebuddy/client/status
 */

import type { RunStatus } from './definition.ts'

/** The dot's colour for each state, in the order a run can reach them. */
export const STATUS_COLOR: Record<RunStatus, string> = {
  running: '#378ADD',
  delegated: '#C08A00',
  done: '#1D9E75',
  stopped: '#888780',
  refused: '#C08A00',
  failed: '#E24B4A',
}
