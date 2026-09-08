import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const EXCLUDED = new Set(['.git', 'node_modules', '.profer-pi-checkpoints'])

function walk(root: string, current = root): string[] {
  const files: string[] = []
  for (const name of readdirSync(current)) {
    if (EXCLUDED.has(name)) continue
    const path = join(current, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walk(root, path))
    else if (stat.isFile()) files.push(relative(root, path))
  }
  return files
}

export interface PiFileCheckpoint {
  path: string
  files: string[]
}

export function createPiFileCheckpoint(sessionId: string, cwd: string, rootDir: string): PiFileCheckpoint {
  const path = join(rootDir, sessionId, String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  mkdirSync(path, { recursive: true })
  const files = walk(cwd)
  for (const file of files) {
    const source = join(cwd, file)
    const target = join(path, file)
    mkdirSync(resolve(target, '..'), { recursive: true })
    cpSync(source, target)
  }
  writeFileSync(join(path, '.manifest.json'), JSON.stringify(files), 'utf8')
  return { path, files }
}

export function loadPiFileCheckpoint(path: string): PiFileCheckpoint {
  const manifestPath = join(path, '.manifest.json')
  if (!existsSync(manifestPath)) throw new Error('Pi 文件检查点清单不存在，无法恢复')
  const files = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === 'string')) {
    throw new Error('Pi 文件检查点清单无效')
  }
  return { path, files }
}

export function restorePiFileCheckpoint(checkpoint: PiFileCheckpoint, cwd: string): string[] {
  if (!existsSync(checkpoint.path)) throw new Error('Pi 文件检查点不存在，无法恢复')
  const previous = new Set(checkpoint.files)
  const current = walk(cwd)
  const changed: string[] = []
  for (const file of current) {
    if (!previous.has(file)) {
      unlinkSync(join(cwd, file))
      changed.push(file)
    }
  }
  for (const file of checkpoint.files) {
    const source = join(checkpoint.path, file)
    const target = join(cwd, file)
    mkdirSync(resolve(target, '..'), { recursive: true })
    cpSync(source, target)
    changed.push(file)
  }
  return [...new Set(changed)]
}

export function removePiFileCheckpoints(rootDir: string, sessionId: string): void {
  const path = join(rootDir, sessionId)
  if (existsSync(path)) rmSync(path, { recursive: true, force: true })
}
