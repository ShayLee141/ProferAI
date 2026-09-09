import { describe, expect, test } from 'bun:test'
import { buildWslBashArgs, ensureBashWorkingDirectory, windowsPathToWslPath } from './pi-agent-adapter'

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

  test('Given a deleted session cwd When starting Bash Then recreates the directory before spawn', () => {
    const created: string[] = []
    ensureBashWorkingDirectory(
      '/Users/alice/.profer/session-1',
      () => false,
      (path) => { created.push(path) },
    )

    expect(created).toEqual(['/Users/alice/.profer/session-1'])
  })

  test('Given an empty cwd When starting Bash Then fails with a path-specific error', () => {
    expect(() => ensureBashWorkingDirectory('   ')).toThrow('Bash 工作目录为空')
  })
})
