import { afterEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptPiFileCheckpoints,
  createPiFileCheckpoint,
  loadPiFileCheckpoint,
  prunePiFileCheckpoints,
  removePiFileCheckpoints,
  restorePiFileCheckpoint,
} from './pi-file-checkpoint'
import { __setGitExecutableForTest, fromGitPath, isGitSnapshotAvailable, toGitPath } from './pi-checkpoint-git'

const sh = (command: string, cwd: string): string => execSync(command, { cwd, encoding: 'utf8' }).trim()

/** 没装 git 的环境只跑降级路径（git 相关用例整体跳过） */
const hasGit = isGitSnapshotAvailable()
const gitOnly = test.skipIf(!hasGit)

type Engine = 'git' | 'copy'
const ENGINES: Engine[] = hasGit ? ['git', 'copy'] : ['copy']

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  __setGitExecutableForTest(undefined)
})

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-pi-checkpoint-'))
  roots.push(root)
  return root
}

/** 造一个可辨认的 Chromium user-data-dir（特征：Local State + Default/Network/Cookies） */
function writeBrowserProfile(profileDir: string): string {
  mkdirSync(join(profileDir, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(profileDir, 'Local State'), '{}')
  const cookies = join(profileDir, 'Default', 'Network', 'Cookies')
  writeFileSync(cookies, 'locked-by-browser')
  return cookies
}

for (const engine of ENGINES) {
  describe(`Pi 检查点（${engine} 引擎）`, () => {
    test('Given a turn modifies, creates and deletes files When restoring Then returns the workspace to the turn baseline', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'modified.txt'), 'before')
      writeFileSync(join(cwd, 'deleted.txt'), 'still here')

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })
      expect(checkpoint.engine).toBe(engine)

      writeFileSync(join(cwd, 'modified.txt'), 'after')
      writeFileSync(join(cwd, 'created.txt'), 'new')
      rmSync(join(cwd, 'deleted.txt'))

      const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
      expect(restored.changed).toEqual(expect.arrayContaining(['modified.txt', 'created.txt', 'deleted.txt']))
      expect(readFileSync(join(cwd, 'modified.txt'), 'utf8')).toBe('before')
      expect(readFileSync(join(cwd, 'deleted.txt'), 'utf8')).toBe('still here')
      expect(() => readFileSync(join(cwd, 'created.txt'))).toThrow()
    })

    test('Given a workspace holds dependencies, build output and a browser profile When snapshotting Then only agent-authored content is captured', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(join(cwd, '.git'), { recursive: true })
      mkdirSync(join(cwd, 'node_modules', 'left-pad'), { recursive: true })
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      mkdirSync(join(cwd, '.context', 'evidence'), { recursive: true })
      writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main')
      writeFileSync(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
      writeFileSync(join(cwd, 'dist', 'bundle.js'), 'built')
      writeFileSync(join(cwd, 'LOCK'), 'lock')
      writeFileSync(join(cwd, '.context', 'evidence', 'report.md'), 'agent output')
      const cookies = writeBrowserProfile(join(cwd, '.context', 'evidence', '.mobile-profile'))

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })

      expect(checkpoint.files).toEqual(['.context/evidence/report.md'])
      // 被排除的内容属于「静默排除」，不该以 skipped 形式污染回退提示
      expect(checkpoint.skipped).toEqual([])

      // 被浏览器独占锁定的 Cookies 既没进基线，也不该在回退时被当作「本轮新增」删除
      const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
      expect(existsSync(cookies)).toBe(true)
      expect(existsSync(join(cwd, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
      expect(existsSync(join(cwd, 'dist', 'bundle.js'))).toBe(true)
      expect(restored.changed).not.toContain('node_modules/left-pad/index.js')
      expect(restored.changed).not.toContain('dist/bundle.js')
      expect(restored.changed).not.toContain('LOCK')
      // git 引擎按 tree diff 精确报告（无改动即空），copy 引擎会重写全部基线文件
      expect(restored.changed).toEqual(engine === 'git' ? [] : ['.context/evidence/report.md'])
    })

    test('Given a baseline file is too large to snapshot When the turn runs Then the turn still succeeds and the file survives the rewind', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'big.bin'), 'baseline-blob')
      writeFileSync(join(cwd, 'small.txt'), 'ok')

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine, maxFileBytes: 4 })

      expect(checkpoint.files).toEqual(['small.txt'])
      expect(checkpoint.skipped.map((item) => item.path)).toEqual(['big.bin'])

      writeFileSync(join(cwd, 'big.bin'), 'turn-blob')
      const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)

      // 未纳入基线的既有文件既不能被删除，也不该被当作可回退内容；
      // 结果必须回传 UI，不能把“未回退”伪装为成功。
      expect(readFileSync(join(cwd, 'big.bin'), 'utf8')).toBe('turn-blob')
      expect(restored.incomplete).toBe(true)
      expect(restored.skipped.map((item) => item.path)).toContain('big.bin')
    })

    test('Given the total snapshot budget is exceeded When snapshotting Then the baseline is marked partial and rewind skips deletions', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'a.txt'), 'baseline')

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine, maxTotalBytes: 3 })
      expect(checkpoint.partial).toBe(true)
      expect(checkpoint.files).toEqual([])

      writeFileSync(join(cwd, 'created.txt'), 'new')
      restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
      // 基线不完整时无法区分「本轮新增」与「基线遗漏」，宁可不删除
      expect(readFileSync(join(cwd, 'created.txt'), 'utf8')).toBe('new')
    })

    test('Given a directory cannot be read When snapshotting Then it is recorded as a protected subtree instead of failing the turn', () => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) return // root 无视权限位，该用例无意义
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      const blockedDir = join(cwd, 'blocked')
      mkdirSync(blockedDir, { recursive: true })
      writeFileSync(join(blockedDir, 'secret.txt'), 'cannot read')
      chmodSync(blockedDir, 0o000)

      try {
        const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })
        expect(checkpoint.files).toEqual([])
        expect(checkpoint.skipped).toEqual([expect.objectContaining({ path: 'blocked', kind: 'dir' })])

        // 目录级跳过保护整棵子树：其中文件不得在回退时被删除
        restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
        chmodSync(blockedDir, 0o700)
        expect(readFileSync(join(blockedDir, 'secret.txt'), 'utf8')).toBe('cannot read')
      } finally {
        chmodSync(blockedDir, 0o700)
      }
    })

    test('Given the turn deletes a whole directory When restoring Then its files come back', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(join(cwd, '.context', 'evidence', 'nested'), { recursive: true })
      writeFileSync(join(cwd, '.context', 'evidence', 'a.md'), 'a')
      writeFileSync(join(cwd, '.context', 'evidence', 'nested', 'b.md'), 'b')

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })
      rmSync(join(cwd, '.context', 'evidence'), { recursive: true, force: true })

      restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
      expect(readFileSync(join(cwd, '.context', 'evidence', 'a.md'), 'utf8')).toBe('a')
      expect(readFileSync(join(cwd, '.context', 'evidence', 'nested', 'b.md'), 'utf8')).toBe('b')
    })

    test('Given a workspace symlink points outside When snapshotting and restoring Then the external target is never traversed or deleted', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      const outside = join(root, 'outside')
      mkdirSync(cwd)
      mkdirSync(outside)
      symlinkSync(outside, join(cwd, 'external'), 'dir')
      writeFileSync(join(cwd, 'tracked.txt'), 'baseline')

      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })
      expect(checkpoint.files).toEqual(['tracked.txt'])
      expect(checkpoint.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'external', kind: 'dir' }),
      ]))

      writeFileSync(join(outside, 'new.txt'), 'must survive')
      writeFileSync(join(cwd, 'tracked.txt'), 'changed')
      const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)

      expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe('must survive')
      expect(lstatSync(join(cwd, 'external')).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe('baseline')
      expect(restored.incomplete).toBe(true)
      expect(restored.skipped.map((item) => item.path)).toContain('external')
    })

    test('Given a baseline file becomes a directory When restoring Then the file replaces the directory', () => {
      const root = makeTempRoot()
      const cwd = join(root, 'cwd')
      const checkpointRoot = join(root, 'checkpoints')
      mkdirSync(cwd)
      writeFileSync(join(cwd, 'node'), 'baseline-file')
      const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: engine })

      unlinkSync(join(cwd, 'node'))
      mkdirSync(join(cwd, 'node'))
      writeFileSync(join(cwd, 'node', 'created.txt'), 'turn output')

      const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
      expect(lstatSync(join(cwd, 'node')).isFile()).toBe(true)
      expect(readFileSync(join(cwd, 'node'), 'utf8')).toBe('baseline-file')
      expect(restored.skipped.map((item) => item.path)).not.toContain('node')
    })
  })
}

describe('git 引擎特性', () => {
  gitOnly('Given the workspace is unchanged When snapshotting again Then the previous checkpoint is reused instead of adding objects', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')

    const first = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    const second = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    expect(second.path).toBe(first.path)

    writeFileSync(join(cwd, 'file.txt'), 'changed')
    const third = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    expect(third.path).not.toBe(first.path)
  })

  gitOnly('Given identical empty trees with different protection semantics When snapshotting Then partial checkpoints are not deduplicated', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)

    const empty = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    writeFileSync(join(cwd, 'baseline-too-large.txt'), '12345')
    const partial = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git', maxTotalBytes: 3 })
    expect(partial.path).not.toBe(empty.path)
    expect(partial.partial).toBe(true)

    writeFileSync(join(cwd, 'turn-created.txt'), 'turn')
    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(partial.path), cwd)
    expect(existsSync(join(cwd, 'baseline-too-large.txt'))).toBe(true)
    expect(readFileSync(join(cwd, 'turn-created.txt'), 'utf8')).toBe('turn')
    expect(restored.incomplete).toBe(true)
  })

  gitOnly('Given a tampered baseline tree When restoring Then it reports failure instead of an empty successful diff', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'baseline')
    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    writeFileSync(join(cwd, 'file.txt'), 'turn value')

    const manifest = JSON.parse(readFileSync(checkpoint.path, 'utf8')) as Record<string, unknown>
    manifest.treeSha = '0000000000000000000000000000000000000000'
    writeFileSync(checkpoint.path, JSON.stringify(manifest), 'utf8')

    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(restored.failed).toBe(true)
    expect(restored.changed).toEqual([])
    expect(restored.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: '.' })]))
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('turn value')
  })

  gitOnly('Given the workspace is itself a git repo When snapshotting Then the user repo, index and stash stay untouched', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'repo')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    sh('git init -q . && git config user.email t@example.com && git config user.name t', cwd)
    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\npages/\n')
    mkdirSync(join(cwd, 'src'))
    mkdirSync(join(cwd, 'pages'))
    writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(cwd, 'ignored.txt'), 'ignored at baseline\n')
    writeFileSync(join(cwd, 'pages', 'index.md'), 'page at baseline\n')
    sh('git add .gitignore src/app.ts && git commit -qm init', cwd)
    const headBefore = sh('git rev-parse HEAD', cwd)
    const statusBefore = sh('git status --porcelain', cwd)
    const objectsBefore = sh('git count-objects -v', cwd)

    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot)

    // 影子仓库完全独立：用户仓库的 HEAD/索引/对象库/ stash 一律不变
    expect(checkpoint.engine).toBe('git')
    expect(sh('git rev-parse HEAD', cwd)).toBe(headBefore)
    expect(sh('git status --porcelain', cwd)).toBe(statusBefore)
    expect(sh('git count-objects -v', cwd)).toBe(objectsBefore)
    expect(sh('git stash list', cwd)).toBe('')
    // .gitignore 不得成为隐形豁免：是否纳入基线只由 Profer 的排除规则决定
    expect(checkpoint.files).toEqual(expect.arrayContaining(['ignored.txt', 'pages/index.md', 'src/app.ts']))

    writeFileSync(join(cwd, 'ignored.txt'), 'changed during turn\n')
    writeFileSync(join(cwd, 'pages', 'index.md'), 'rebuilt\n')
    restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(readFileSync(join(cwd, 'ignored.txt'), 'utf8')).toBe('ignored at baseline\n')
    expect(readFileSync(join(cwd, 'pages', 'index.md'), 'utf8')).toBe('page at baseline\n')
  })

  gitOnly('Given binary and CRLF content When restoring Then files come back byte for byte', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x7f, 0x80])
    writeFileSync(join(cwd, 'blob.bin'), binary)
    writeFileSync(join(cwd, 'crlf.txt'), 'line1\r\nline2\r\n')

    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    writeFileSync(join(cwd, 'blob.bin'), 'overwritten')
    writeFileSync(join(cwd, 'crlf.txt'), 'overwritten')

    restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(readFileSync(join(cwd, 'blob.bin')).equals(binary)).toBe(true)
    expect(readFileSync(join(cwd, 'crlf.txt'), 'utf8')).toBe('line1\r\nline2\r\n')
  })

  test('Given paths on the platform When converting to git pathspecs Then separators match git conventions', () => {
    if (process.platform === 'win32') {
      expect(toGitPath('sub\\dir\\file.txt')).toBe('sub/dir/file.txt')
      expect(fromGitPath('sub/dir/file.txt')).toBe('sub\\dir\\file.txt')
    } else {
      expect(toGitPath('sub/dir/file.txt')).toBe('sub/dir/file.txt')
      expect(fromGitPath('sub/dir/file.txt')).toBe('sub/dir/file.txt')
    }
  })
})

describe('引擎降级与历史兼容', () => {
  test('Given git is unavailable When snapshotting in auto mode Then it falls back to the copy engine', () => {
    __setGitExecutableForTest(null)
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'v1')

    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot)
    expect(checkpoint.engine).toBe('copy')

    writeFileSync(join(cwd, 'file.txt'), 'v2')
    restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('v1')
  })

  test('Given git is unavailable When the git engine is forced Then the failure is explicit', () => {
    __setGitExecutableForTest(null)
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    mkdirSync(cwd)
    expect(() => createPiFileCheckpoint('session', cwd, join(root, 'checkpoints'), { mode: 'git' })).toThrow()
  })

  test('Given the workspace rewrites content via .gitattributes When snapshotting Then git is skipped for byte-exact copy', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'crlf.txt'), 'a\r\nb\r\n')
    writeFileSync(join(cwd, '.gitattributes'), '* text=auto\n')

    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot)
    expect(checkpoint.engine).toBe('copy')

    writeFileSync(join(cwd, 'crlf.txt'), 'turned\n')
    restorePiFileCheckpoint(loadPiFileCheckpoint(checkpoint.path), cwd)
    expect(readFileSync(join(cwd, 'crlf.txt'), 'utf8')).toBe('a\r\nb\r\n')
  })

  test('Given a legacy v1 manifest (plain path array) When loading Then it still rewinds', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointPath = join(root, 'checkpoints', 'session', 'legacy')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(checkpointPath, { recursive: true })
    writeFileSync(join(cwd, 'file.txt'), 'turn-value')
    writeFileSync(join(checkpointPath, 'file.txt'), 'baseline-value')
    writeFileSync(join(checkpointPath, '.manifest.json'), JSON.stringify(['file.txt']))

    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath), cwd)
    expect(restored.changed).toEqual(['file.txt'])
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('baseline-value')
  })

  test('Given a legacy v2 copy manifest with skips When loading Then omitted files are preserved', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointPath = join(root, 'checkpoints', 'session', 'legacy-v2')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(checkpointPath, { recursive: true })
    writeFileSync(join(cwd, 'file.txt'), 'turn-value')
    writeFileSync(join(cwd, 'locked.bin'), 'turn-locked')
    writeFileSync(join(checkpointPath, 'file.txt'), 'baseline-value')
    writeFileSync(
      join(checkpointPath, '.manifest.json'),
      JSON.stringify({
        version: 2,
        files: ['file.txt'],
        skipped: [{ path: 'locked.bin', kind: 'file', reason: 'EBUSY' }],
        partial: false,
        bytes: 14,
      }),
    )

    const restored = restorePiFileCheckpoint(loadPiFileCheckpoint(checkpointPath), cwd)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('baseline-value')
    expect(readFileSync(join(cwd, 'locked.bin'), 'utf8')).toBe('turn-locked')
    expect(restored.incomplete).toBe(true)
    expect(restored.skipped.map((item) => item.path)).toContain('locked.bin')
  })

  test('Given a legacy manifest path escapes the checkpoint When loading Then it is rejected before any workspace write', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointPath = join(root, 'checkpoints', 'session', 'legacy')
    const outside = join(root, 'outside')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(checkpointPath, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'victim.txt'), 'must not change')
    writeFileSync(join(checkpointPath, '.manifest.json'), JSON.stringify(['../outside/victim.txt']))

    expect(() => loadPiFileCheckpoint(checkpointPath)).toThrow('无效路径')
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('must not change')
  })
})

describe('分叉会话的基线迁移', () => {
  test('Given a fork session inherits baselines When the source session is deleted Then the fork still rewinds on its own', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'turn-1 baseline')
    const source = createPiFileCheckpoint('source-session', cwd, checkpointRoot, { mode: 'git' })
    writeFileSync(join(cwd, 'file.txt'), 'turn-2 baseline')
    const sourceSecond = createPiFileCheckpoint('source-session', cwd, checkpointRoot, { mode: 'git' })

    const { adopted, failed } = adoptPiFileCheckpoints({
      rootDir: checkpointRoot,
      targetSessionId: 'fork-session',
      paths: [source.path, sourceSecond.path],
    })
    expect(failed).toEqual([])
    expect(Object.keys(adopted)).toHaveLength(2)
    for (const targetPath of Object.values(adopted)) {
      expect(targetPath.startsWith(join(checkpointRoot, 'fork-session'))).toBe(true)
    }

    // 源会话被彻底删除（目录都不在了），分叉会话仍能独立回退
    removePiFileCheckpoints(checkpointRoot, 'source-session')
    expect(existsSync(join(checkpointRoot, 'source-session'))).toBe(false)

    writeFileSync(join(cwd, 'file.txt'), 'changed after fork')
    restorePiFileCheckpoint(loadPiFileCheckpoint(adopted[source.path]!), cwd)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('turn-1 baseline')

    // 迁移后的清单必须指向自己的影子仓库，而非源仓库
    const manifest = JSON.parse(readFileSync(adopted[source.path]!, 'utf8')) as { dir: string }
    expect(manifest.dir.startsWith(join(checkpointRoot, 'fork-session'))).toBe(true)
  })

  test('Given the copy engine is in use When baselines are adopted Then they are copied into the target session directory', () => {
    __setGitExecutableForTest(null)
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'baseline')
    const source = createPiFileCheckpoint('source-session', cwd, checkpointRoot)

    const { adopted, failed } = adoptPiFileCheckpoints({
      rootDir: checkpointRoot,
      targetSessionId: 'fork-session',
      paths: [source.path],
    })
    expect(failed).toEqual([])
    removePiFileCheckpoints(checkpointRoot, 'source-session')

    writeFileSync(join(cwd, 'file.txt'), 'changed')
    restorePiFileCheckpoint(loadPiFileCheckpoint(adopted[source.path]!), cwd)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('baseline')
  })

  gitOnly('Given a fork imports one checkpoint ref When the source has later checkpoints Then the target only contains reachable fork objects', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'fork baseline')
    const first = createPiFileCheckpoint('source-session', cwd, checkpointRoot, { mode: 'git' })
    writeFileSync(join(cwd, 'file.txt'), 'later baseline')
    const later = createPiFileCheckpoint('source-session', cwd, checkpointRoot, { mode: 'git' })
    const laterManifest = JSON.parse(readFileSync(later.path, 'utf8')) as { commitSha: string }

    const { adopted, failed } = adoptPiFileCheckpoints({
      rootDir: checkpointRoot,
      targetSessionId: 'fork-session',
      paths: [first.path],
    })
    expect(failed).toEqual([])
    const targetManifest = JSON.parse(readFileSync(adopted[first.path]!, 'utf8')) as { dir: string; commitSha: string }
    expect(sh(`git --git-dir "${targetManifest.dir}" cat-file -e ${targetManifest.commitSha}^{commit}`, cwd)).toBe('')
    expect(() => sh(`git --git-dir "${targetManifest.dir}" cat-file -e ${laterManifest.commitSha}^{commit}`, cwd)).toThrow()
  })

  test('Given a baseline is already gone When adopting Then it is reported as failed instead of silently dropped', () => {
    const root = makeTempRoot()
    const checkpointRoot = join(root, 'checkpoints')
    const { adopted, failed } = adoptPiFileCheckpoints({
      rootDir: checkpointRoot,
      targetSessionId: 'fork-session',
      paths: [join(checkpointRoot, 'source-session', 'missing.json')],
    })
    expect(adopted).toEqual({})
    expect(failed).toHaveLength(1)
  })
})

describe('Pi 检查点回收', () => {
  test('Given checkpoints are no longer referenced or exceed the cap When pruning Then disk stays consistent with the bindings', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')

    const oldest = createPiFileCheckpoint('session', cwd, checkpointRoot)
    writeFileSync(join(cwd, 'file.txt'), 'content-2')
    const middle = createPiFileCheckpoint('session', cwd, checkpointRoot)
    writeFileSync(join(cwd, 'file.txt'), 'content-3')
    const newest = createPiFileCheckpoint('session', cwd, checkpointRoot)
    const otherSession = createPiFileCheckpoint('other-session', cwd, checkpointRoot)
    const base = Date.now() / 1000
    utimesSync(oldest.path, base - 60, base - 60)
    utimesSync(middle.path, base - 30, base - 30)
    utimesSync(newest.path, base - 10, base - 10)

    // 1) 未被任何回退点引用的检查点直接回收，其他会话不受影响
    expect(prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [middle.path, newest.path] }).removed)
      .toEqual([oldest.path])
    expect(existsSync(oldest.path)).toBe(false)
    expect(existsSync(otherSession.path)).toBe(true)

    // 2) 被引用但超出数量上限时，从最旧的开始回收并上报，供调用方丢弃绑定
    const result = prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [middle.path, newest.path], maxCount: 1 })
    expect(result.removed).toEqual([middle.path])
    expect(result.removedBound).toBe(1)
    expect(existsSync(middle.path)).toBe(false)
    expect(existsSync(newest.path)).toBe(true)
  })

  gitOnly('Given every checkpoint is dropped When pruning Then the shadow repo is released as well', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')
    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    const sessionDir = join(checkpointRoot, 'session')
    expect(existsSync(join(sessionDir, 'shadow.git'))).toBe(true)

    const result = prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [] })
    expect(result.removed).toEqual([checkpoint.path])
    expect(result.releasedRepo).toBe(true)
    expect(existsSync(join(sessionDir, 'shadow.git'))).toBe(false)
  })

  gitOnly('Given an orphaned checkpoint ref has no manifest When pruning Then the ref is removed and cannot retain objects', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')
    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    const manifest = JSON.parse(readFileSync(checkpoint.path, 'utf8')) as { dir: string; commitSha: string }
    const orphanRef = 'refs/profer/checkpoints/orphan-after-manifest-failure'
    sh(`git --git-dir "${manifest.dir}" update-ref ${orphanRef} ${manifest.commitSha}`, cwd)

    prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [checkpoint.path] })
    expect(() => sh(`git --git-dir "${manifest.dir}" show-ref --verify --quiet ${orphanRef}`, cwd)).toThrow()
  })

  gitOnly('Given a Git attempt falls back to copy When pruning Then the empty shadow repository is released', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')
    const first = createPiFileCheckpoint('session', cwd, checkpointRoot, { mode: 'git' })
    const manifest = JSON.parse(readFileSync(first.path, 'utf8')) as { dir: string }
    // The existing Git checkpoint is pruned, then a later copy-only checkpoint leaves an empty repo behind.
    prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [] })
    mkdirSync(manifest.dir, { recursive: true })
    writeFileSync(join(manifest.dir, 'HEAD'), 'invalid\n')
    __setGitExecutableForTest(null)
    writeFileSync(join(cwd, 'file.txt'), 'changed')
    const fallback = createPiFileCheckpoint('session', cwd, checkpointRoot)
    expect(fallback.engine).toBe('copy')

    const result = prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [fallback.path] })
    expect(result.releasedRepo).toBe(true)
    expect(existsSync(manifest.dir)).toBe(false)
  })

  test('Given another session still references a baseline When pruning Then it is kept alive', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')
    const shared = createPiFileCheckpoint('session', cwd, checkpointRoot)

    // 分叉会话引用了本会话目录里的基线（迁移失败时的兼容路径）：不能被当成孤儿删掉
    const result = prunePiFileCheckpoints(checkpointRoot, 'session', { keepPaths: [shared.path] })
    expect(result.removed).toEqual([])
    expect(existsSync(shared.path)).toBe(true)
  })

  test('Given a crashed checkpoint has no manifest When it is stale Then it is garbage collected but fresh ones are kept', () => {
    const root = makeTempRoot()
    const checkpointRoot = join(root, 'checkpoints')
    const sessionDir = join(checkpointRoot, 'session')
    const stale = join(sessionDir, 'stale')
    const fresh = join(sessionDir, 'fresh')
    mkdirSync(stale, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    const past = (Date.now() - 60 * 60 * 1000) / 1000
    utimesSync(stale, past, past)

    expect(prunePiFileCheckpoints(checkpointRoot, 'session').removed).toEqual([stale])
    expect(existsSync(fresh)).toBe(true)
  })

  test('Given a session is deleted When removing its checkpoints Then only that session directory is gone', () => {
    const root = makeTempRoot()
    const cwd = join(root, 'cwd')
    const checkpointRoot = join(root, 'checkpoints')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'file.txt'), 'content')
    const checkpoint = createPiFileCheckpoint('session', cwd, checkpointRoot)
    const other = createPiFileCheckpoint('other-session', cwd, checkpointRoot)

    removePiFileCheckpoints(checkpointRoot, 'session')
    expect(existsSync(checkpoint.path)).toBe(false)
    expect(existsSync(join(checkpointRoot, 'session'))).toBe(false)
    expect(existsSync(other.path)).toBe(true)
  })
})
