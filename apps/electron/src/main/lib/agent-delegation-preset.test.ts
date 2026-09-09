import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, PresetReference } from '@profer/shared'
import {
  __resetAgentPresetsBaseDirForTest,
  __setAgentPresetsBaseDirForTest,
  createAgentPreset,
  createGlobalAgentPreset,
  disableGlobalPresetInWorkspace,
} from './agent-preset-manager'
import { resolveDelegationPreset } from './agent-delegation-preset'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'delegation-preset-test-'))
  __setAgentPresetsBaseDirForTest(tmpDir)
})

afterEach(() => {
  __resetAgentPresetsBaseDirForTest()
  rmSync(tmpDir, { recursive: true, force: true })
})

function parent(overrides: Partial<AgentSessionMeta>): AgentSessionMeta {
  return {
    id: 'parent',
    title: 'Parent',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('resolveDelegationPreset', () => {
  test('未指定目标时继承父会话稳定引用', () => {
    const reference: PresetReference = {
      presetId: 'code',
      presetScope: 'builtin-meta',
    }
    const result = resolveDelegationPreset({
      parent: parent({ presetId: 'standard', presetReference: reference }),
      workspaceSlug: 'workspace-a',
    })

    expect(result?.reference).toEqual(reference)
    expect(result?.preset.id).toBe('code')
  })

  test('旧父会话只有 presetId 时转换为稳定引用', () => {
    const result = resolveDelegationPreset({
      parent: parent({ presetId: 'minimal' }),
      workspaceSlug: 'workspace-a',
    })

    expect(result?.reference).toMatchObject({
      presetId: 'minimal',
      presetScope: 'builtin-meta',
    })
  })

  test('显式目标覆盖父会话预设', () => {
    const result = resolveDelegationPreset({
      parent: parent({ presetId: 'minimal' }),
      target: { presetId: 'code', presetScope: 'builtin-meta' },
      workspaceSlug: 'workspace-a',
    })

    expect(result?.reference.presetId).toBe('code')
    expect(result?.preset.id).toBe('code')
  })

  test('显式工作区目标必须携带 workspaceSlug', () => {
    expect(() => resolveDelegationPreset({
      target: {
        presetId: 'target',
        presetScope: 'workspace',
      },
      workspaceSlug: 'workspace-a',
    })).toThrow('目标工作区预设必须提供 workspaceSlug')
  })

  test('允许当前父会话工作区内的显式工作区预设', () => {
    const preset = createAgentPreset('workspace-a', {
      name: 'Review',
      description: 'Review preset',
      permissionMode: 'plan',
    })
    const result = resolveDelegationPreset({
      target: {
        presetId: preset.id,
        presetScope: 'workspace',
        workspaceSlug: 'workspace-a',
      },
      workspaceSlug: 'workspace-a',
    })

    expect(result?.preset.id).toBe(preset.id)
    expect(result?.reference.workspaceSlug).toBe('workspace-a')
  })

  test('拒绝其他工作区的工作区预设引用', () => {
    expect(() => resolveDelegationPreset({
      parent: parent({ presetId: 'code' }),
      target: {
        presetId: 'target',
        presetScope: 'workspace',
        workspaceSlug: 'workspace-b',
      },
      workspaceSlug: 'workspace-a',
    })).toThrow('目标工作区预设不属于父会话工作区')
  })

  test('拒绝当前工作区已禁用的全局预设', () => {
    const preset = createGlobalAgentPreset({ name: 'Global review', description: 'Review' })
    const reference: PresetReference = { presetId: preset.id, presetScope: 'user-global' }
    disableGlobalPresetInWorkspace('workspace-a', reference)

    expect(() => resolveDelegationPreset({
      target: reference,
      workspaceSlug: 'workspace-a',
    })).toThrow('当前工作区')
  })

  test('拒绝给全局引用附加 workspaceSlug', () => {
    expect(() => resolveDelegationPreset({
      target: {
        presetId: 'code',
        presetScope: 'builtin-meta',
        workspaceSlug: 'workspace-a',
      },
      workspaceSlug: 'workspace-a',
    })).toThrow('全局预设引用不得携带 workspaceSlug')
  })

  test('没有父预设和显式目标时保留既有默认行为', () => {
    expect(resolveDelegationPreset({
      parent: parent({}),
      workspaceSlug: 'workspace-a',
    })).toBeUndefined()
  })
})
