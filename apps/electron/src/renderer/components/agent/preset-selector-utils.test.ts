import { describe, expect, test } from 'bun:test'
import type { AgentPreset } from '@profer/shared'
import {
  referenceForSelectablePreset,
  selectablePresetMatchesReference,
} from './preset-selector-utils'

function preset(input: Partial<AgentPreset> & Pick<AgentPreset, 'id'>): AgentPreset {
  return {
    name: input.id,
    description: '',
    isBuiltin: false,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
}

describe('预设选择器稳定引用', () => {
  test('工作区岗位切换时携带作用域、工作区和版本', () => {
    const candidate = preset({ id: 'renderer', scope: 'workspace', workspaceSlug: 'profer', version: '1.2.3' })
    expect(referenceForSelectablePreset(candidate, 'profer')).toEqual({
      presetId: 'renderer',
      presetScope: 'workspace',
      workspaceSlug: 'profer',
      presetVersion: '1.2.3',
    })
  })

  test('元预设和同 ID 工作区预设不会被误判成同一个选择', () => {
    const builtin = preset({ id: 'code', scope: 'builtin-meta', isBuiltin: true })
    const workspace = preset({ id: 'code', scope: 'workspace' })
    const reference = referenceForSelectablePreset(builtin, 'profer')

    expect(selectablePresetMatchesReference(builtin, reference)).toBe(true)
    expect(selectablePresetMatchesReference(workspace, reference)).toBe(false)
  })
})
