import type { AgentPreset, AgentPresetScope, PresetReference } from '@profer/shared'

export function getSelectablePresetScope(preset: AgentPreset): AgentPresetScope {
  return preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'workspace')
}

export function referenceForSelectablePreset(preset: AgentPreset, workspaceSlug?: string): PresetReference {
  const presetScope = getSelectablePresetScope(preset)
  return {
    presetId: preset.id,
    presetScope,
    ...(presetScope === 'workspace' && workspaceSlug ? { workspaceSlug } : {}),
    ...(preset.version ? { presetVersion: preset.version } : {}),
  }
}

export function selectablePresetMatchesReference(
  preset: AgentPreset,
  reference: PresetReference | undefined,
): boolean {
  return Boolean(
    reference
      && preset.id === reference.presetId
      && getSelectablePresetScope(preset) === reference.presetScope,
  )
}
