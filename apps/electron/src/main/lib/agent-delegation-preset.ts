import type { AgentPreset, AgentSessionMeta, PresetReference } from '@profer/shared'
import {
  getAgentPresetByReference,
  normalizePresetReference,
  presetReferenceForId,
} from './agent-preset-manager'

export interface DelegationPresetResolution {
  reference: PresetReference
  preset: AgentPreset
}

export interface ResolveDelegationPresetInput {
  parent?: Pick<AgentSessionMeta, 'presetId' | 'presetReference'>
  target?: PresetReference
  workspaceSlug?: string
}

/**
 * Resolve the preset that a delegated child session will persist and run with.
 *
 * The parent session's persisted workspace is supplied by the caller. A target
 * workspace reference is never allowed to escape that workspace; global and
 * builtin references are still resolved with the same workspace context so the
 * manager can enforce disabled/scope/version checks in one place.
 */
export function resolveDelegationPreset(
  input: ResolveDelegationPresetInput,
): DelegationPresetResolution | undefined {
  const candidate = input.target
    ?? input.parent?.presetReference
    ?? (input.parent?.presetId ? presetReferenceForId(input.workspaceSlug, input.parent.presetId) : undefined)

  if (!candidate) return undefined

  if (input.target?.presetScope === 'workspace' && !input.target.workspaceSlug) {
    throw new Error('目标工作区预设必须提供 workspaceSlug')
  }
  if (candidate.presetScope === 'workspace'
    && input.workspaceSlug
    && candidate.workspaceSlug !== undefined
    && candidate.workspaceSlug !== input.workspaceSlug) {
    throw new Error(`目标工作区预设不属于父会话工作区: ${candidate.workspaceSlug}`)
  }

  const reference = normalizePresetReference(candidate, input.workspaceSlug)
  if (reference.presetScope === 'workspace'
    && reference.workspaceSlug !== input.workspaceSlug) {
    throw new Error(`目标工作区预设不属于父会话工作区: ${reference.workspaceSlug}`)
  }

  const preset = getAgentPresetByReference(reference, input.workspaceSlug)
  return { reference, preset }
}
