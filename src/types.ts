/**
 * Type re-exports from the installed harness packages. The authoritative
 * contracts live in `@deepseek-ai/dsh-subagent` and `@deepseek-ai/dsh-subprocess`;
 * this module exists only so sibling files import from one place.
 *
 * @module dsh-subagent-codebuddy/types
 */

export type { ContentBlock } from '@deepseek-ai/dsh-llm'
export type {
  ResolvedSubagentStartRequest as SubagentStartRequest,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
export type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
