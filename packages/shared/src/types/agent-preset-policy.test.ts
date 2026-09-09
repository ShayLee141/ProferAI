import { describe, expect, test } from 'bun:test'
import {
  createEffectiveAgentPresetPolicy,
  getEffectiveDisabledToolNames,
  isEffectiveAgentPresetMcpServerAllowed,
  isEffectiveAgentPresetSkillAllowed,
  isEffectiveAgentPresetToolDisabled,
  isEffectiveAgentPresetToolGroupDisabled,
  withLoadedMcpServerNames,
  resolveEffectivePermissionMode,
} from './agent-preset-policy'
import type { AgentPreset } from './agent-preset'

const reference = { presetId: 'research', presetScope: 'workspace' as const, workspaceSlug: 'demo' }

function preset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'research',
    name: 'Research',
    description: 'test',
    isBuiltin: false,
    scope: 'workspace',
    workspaceSlug: 'demo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('EffectiveAgentPresetPolicy', () => {
  test('外部 override 只能保持或收紧预设权限，不能静默升级', () => {
    expect(resolveEffectivePermissionMode('plan', 'bypassPermissions')).toBe('plan')
    expect(resolveEffectivePermissionMode('auto', 'bypassPermissions')).toBe('auto')
    expect(resolveEffectivePermissionMode('bypassPermissions', 'plan')).toBe('plan')
    expect(resolveEffectivePermissionMode('bypassPermissions', 'auto')).toBe('auto')
    expect(resolveEffectivePermissionMode('plan', 'auto')).toBe('plan')
  })

  test('Goal 入口固定使用 bypassPermissions，不受预设 plan/auto 限制', () => {
    expect(createEffectiveAgentPresetPolicy(preset({ permissionMode: 'plan' }), reference, {
      permissionMode: 'bypassPermissions',
      triggeredBy: 'goal',
    }).permissionMode).toBe('bypassPermissions')
    expect(createEffectiveAgentPresetPolicy(preset({ permissionMode: 'auto' }), reference, {
      permissionMode: 'bypassPermissions',
      triggeredBy: 'goal',
    }).permissionMode).toBe('bypassPermissions')
  })

  test('normalizes group policy and maps allowSubagents=false to collaboration', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ disabledToolGroups: ['browser'], allowSubagents: false }),
      reference,
      { permissionMode: 'plan', pptCapabilityActive: true },
    )

    expect(policy.disabledToolGroups).toEqual(['browser', 'collaboration'])
    expect(policy.allowSubagents).toBe(false)
    expect(policy.runtimeSupportsSubagents).toBe(false)
    expect(policy.sessionCanUseSubagents).toBe(false)
    expect(policy.permissionMode).toBe('plan')
    expect(policy.pptCapabilityActive).toBe(true)
    expect(policy.source).toBe('workspace')
    expect(isEffectiveAgentPresetToolGroupDisabled(policy, 'browser')).toBe(true)
    expect(isEffectiveAgentPresetToolGroupDisabled(policy, 'memory')).toBe(false)
  })

  test('runtime 不支持子 Agent 时会同步禁用协作组，而静态能力字段保持可区分', () => {
    const policy = createEffectiveAgentPresetPolicy(preset(), reference, { runtimeSupportsSubagents: false })
    expect(policy.runtimeSupportsSubagents).toBe(false)
    expect(policy.sessionCanUseSubagents).toBe(false)
    expect(policy.disabledToolGroups).toContain('collaboration')
    expect(policy.allowSubagents).toBe(false)
  })

  test('preserves undefined and empty whitelist semantics while de-duplicating values', () => {
    const unrestricted = createEffectiveAgentPresetPolicy(preset(), reference, { runtimeSupportsSubagents: true })
    expect(unrestricted.runtimeSupportsSubagents).toBe(true)
    expect(unrestricted.sessionCanUseSubagents).toBe(true)
    expect(unrestricted.allowedSkillSlugs).toBeUndefined()
    expect(unrestricted.allowedMcpServerNames).toBeUndefined()
    expect(isEffectiveAgentPresetSkillAllowed(unrestricted, 'any')).toBe(true)
    expect(isEffectiveAgentPresetMcpServerAllowed(unrestricted, 'any')).toBe(true)

    const restricted = createEffectiveAgentPresetPolicy(
      preset({ skillSlugs: [], mcpServerNames: ['filesystem', 'filesystem'] }),
      reference,
    )
    expect(restricted.allowedSkillSlugs).toEqual([])
    expect(restricted.allowedMcpServerNames).toEqual(['filesystem'])
    expect(isEffectiveAgentPresetSkillAllowed(restricted, 'any')).toBe(false)
    expect(isEffectiveAgentPresetMcpServerAllowed(restricted, 'filesystem')).toBe(true)
    expect(isEffectiveAgentPresetMcpServerAllowed(restricted, 'other')).toBe(false)
  })

  test('combines group and single-tool deny rules for Claude and Pi names', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ disabledToolGroups: ['browser'], disabledTools: ['WebFetch', 'delegate_agent'] }),
      reference,
    )

    expect(isEffectiveAgentPresetToolDisabled(policy, 'WebFetch')).toBe(true)
    expect(isEffectiveAgentPresetToolDisabled(policy, 'mcp__collaboration__delegate_agent')).toBe(true)
    expect(isEffectiveAgentPresetToolDisabled(policy, 'BrowserObserve')).toBe(true)
    expect(getEffectiveDisabledToolNames(policy)).toEqual(expect.arrayContaining([
      'WebFetch',
      'delegate_agent',
      'BrowserObserve',
      'BrowserNavigate',
    ]))
  })

  test('freezes nested policy arrays and loaded MCP updates create a new snapshot', () => {
    const source = preset({ promptSections: ['a'], skillSlugs: ['s1'] })
    const policy = createEffectiveAgentPresetPolicy(source, reference)
    source.promptSections?.push('mutated')
    source.skillSlugs?.push('mutated')

    expect(policy.preset.promptSections).toEqual(['a'])
    expect(policy.allowedSkillSlugs).toEqual(['s1'])
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.preset)).toBe(true)
    expect(Object.isFrozen(policy.preset.promptSections)).toBe(true)

    const loaded = withLoadedMcpServerNames(policy, ['a', 'a', 'b'])
    expect(policy.loadedMcpServerNames).toBeUndefined()
    expect(loaded.loadedMcpServerNames).toEqual(['a', 'b'])
    expect(Object.isFrozen(loaded)).toBe(true)
  })

  test('maps explicit suppress sections and disabled groups without duplicates', () => {
    const policy = createEffectiveAgentPresetPolicy(
      preset({ suppressPromptSections: ['memory'], disabledToolGroups: ['task-graph', 'memory'] }),
      reference,
    )
    expect(policy.suppressPromptSections).toEqual(['memory', 'task-graph'])
  })
})
