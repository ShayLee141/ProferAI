import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiFileCheckpoint, loadPiFileCheckpoint, restorePiFileCheckpoint } from './pi-file-checkpoint'

let roots: string[] = []
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = [] })

describe('Pi 文件检查点', () => {
  test('Given a turn modifies and creates files When restoring Then returns the workspace to the turn baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-pi-checkpoint-'))
    roots.push(root)
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'existing.txt'), 'before')

    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot)
    writeFileSync(join(cwd, 'existing.txt'), 'after')
    writeFileSync(join(cwd, 'created.txt'), 'new')

    const changed = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(changed).toEqual(expect.arrayContaining(['existing.txt', 'created.txt']))
    expect(readFileSync(join(cwd, 'existing.txt'), 'utf8')).toBe('before')
    expect(() => readFileSync(join(cwd, 'created.txt'))).toThrow()
  })
})
