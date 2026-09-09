import * as React from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/components/settings/primitives'
import type { AgentPreset, AgentWorkspace, PresetReference, PresetReferenceReport, PresetWorkspaceReference } from '@profer/shared'

interface Props { preset: AgentPreset }
type ScopeRow = { workspaceSlug: string; workspaceName: string; references: PresetWorkspaceReference[] }

function presetScopeOf(preset: AgentPreset): PresetReference['presetScope'] {
  return preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'user-global')
}

function ref(preset: AgentPreset, workspaceSlug?: string): PresetReference {
  const presetScope = presetScopeOf(preset)
  return { presetId: preset.id, presetScope, ...(presetScope === 'workspace' && workspaceSlug ? { workspaceSlug } : {}) }
}

function candidateKey(preset: AgentPreset): string {
  return `${presetScopeOf(preset)}:${preset.id}`
}

/** 全局/元预设详情中的工作区生效范围；交互与预设编辑器的多选白名单保持一致。 */
export function GlobalPresetScopePanel({ preset }: Props): React.ReactElement {
  const [report, setReport] = React.useState<PresetReferenceReport | null>(null)
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [replacementKeys, setReplacementKeys] = React.useState<Record<string, string>>({})
  const [candidates, setCandidates] = React.useState<Record<string, AgentPreset[]>>({})
  const [candidateLoading, setCandidateLoading] = React.useState<Set<string>>(new Set())

  const load = React.useCallback(async (isCurrent: () => boolean = () => true) => {
    const [nextReport, listed] = await Promise.all([
      window.electronAPI.getPresetReferenceReport(ref(preset)),
      window.electronAPI.listAgentWorkspaces(),
    ])
    if (!isCurrent()) return
    setReport(nextReport)
    setWorkspaces(listed.filter((workspace) => !workspace.isDeleted))
    setSelected(new Set(nextReport.workspaceScopes.map((scope) => scope.workspaceSlug)))
    setReplacementKeys({})
    setCandidates({})
  }, [preset.id, preset.scope])

  React.useEffect(() => {
    let cancelled = false
    void load(() => !cancelled).catch((error) => {
      if (!cancelled) toast.error(error instanceof Error ? error.message : '读取工作区范围失败')
    })
    return () => { cancelled = true }
  }, [load])

  const rows = React.useMemo(() => {
    const names = new Map(workspaces.map((workspace) => [workspace.slug, workspace.name]))
    const map = new Map<string, ScopeRow>()
    for (const scope of report?.workspaceScopes ?? []) map.set(scope.workspaceSlug, { ...scope, references: [] })
    for (const item of report?.blockers ?? []) {
      const row = map.get(item.workspaceSlug) ?? { workspaceSlug: item.workspaceSlug, workspaceName: item.workspaceName, references: [] }
      row.references.push(item)
      map.set(item.workspaceSlug, row)
    }
    for (const workspace of workspaces) {
      if (!map.has(workspace.slug)) map.set(workspace.slug, { workspaceSlug: workspace.slug, workspaceName: names.get(workspace.slug) ?? workspace.slug, references: [] })
    }
    return [...map.values()]
  }, [report, workspaces])

  const visibleRows = rows.filter((row) => `${row.workspaceName} ${row.workspaceSlug}`.toLowerCase().includes(query.trim().toLowerCase()))

  const loadCandidates = async (workspaceSlug: string): Promise<void> => {
    if (candidates[workspaceSlug] || candidateLoading.has(workspaceSlug)) return
    setCandidateLoading((previous) => new Set(previous).add(workspaceSlug))
    try {
      const listed = await window.electronAPI.listAgentPresets(workspaceSlug)
      setCandidates((previous) => ({ ...previous, [workspaceSlug]: listed }))
    } finally {
      setCandidateLoading((previous) => {
        const next = new Set(previous)
        next.delete(workspaceSlug)
        return next
      })
    }
  }

  const prepareRemovalCandidates = (slugs: string[]): void => {
    for (const slug of slugs) {
      void loadCandidates(slug).catch((error) => toast.error(error instanceof Error ? error.message : '加载替代预设失败'))
    }
  }

  const toggle = (row: ScopeRow): void => {
    const wasSelected = selected.has(row.workspaceSlug)
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(row.workspaceSlug)) next.delete(row.workspaceSlug)
      else next.add(row.workspaceSlug)
      return next
    })
    if (wasSelected && row.references.length > 0) {
      void loadCandidates(row.workspaceSlug).catch((error) => toast.error(error instanceof Error ? error.message : '加载替代预设失败'))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const current = new Set(report?.workspaceScopes.map((scope) => scope.workspaceSlug) ?? [])
      const additions = [...selected].filter((slug) => !current.has(slug))
      const removals = [...current].filter((slug) => !selected.has(slug))
      const rowsBySlug = new Map(rows.map((row) => [row.workspaceSlug, row]))

      // 先做完整校验，避免范围白名单更新到一半才发现某个引用没有替代预设。
      for (const slug of removals) {
        const row = rowsBySlug.get(slug)
        if (!row || row.references.length === 0) continue
        const replacementKey = replacementKeys[slug]
        if (!replacementKey) throw new Error(`请为「${row.workspaceName}」选择替代预设`)
        if (!(candidates[slug] ?? []).some((candidate) => candidateKey(candidate) === replacementKey)) {
          throw new Error(`「${row.workspaceName}」的替代预设无效，请重新选择`)
        }
      }

      for (const slug of additions) await window.electronAPI.enableGlobalPresetInWorkspace(slug, ref(preset))
      for (const slug of removals) {
        const row = rowsBySlug.get(slug)
        if (!row || row.references.length === 0) {
          await window.electronAPI.rebindAndDisableGlobalPresetScope(slug, ref(preset))
          continue
        }
        const replacement = (candidates[slug] ?? []).find((candidate) => candidateKey(candidate) === replacementKeys[slug])
        if (!replacement) throw new Error(`「${row.workspaceName}」的替代预设无效，请重新选择`)
        await window.electronAPI.rebindAndDisableGlobalPresetScope(slug, ref(preset), ref(replacement, slug))
      }
      await load()
      toast.success('工作区生效范围已更新')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新工作区范围失败')
      await load().catch(() => undefined)
    } finally { setBusy(false) }
  }

  return <div className="space-y-2"><div className="flex items-center justify-between gap-2"><div><div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">生效工作区</div><div className="mt-1 text-[11px] text-muted-foreground">已选择 {selected.size} / {workspaces.length}</div></div><Button size="sm" onClick={() => void save()} disabled={busy || !report}>{busy ? '保存中…' : '保存范围'}</Button></div><SettingsCard divided={false}><div className="space-y-3 p-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作区…" className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-xs outline-none focus:ring-1 focus:ring-ring" /><div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>工作区白名单</span><div className="flex gap-2"><button type="button" onClick={() => setSelected(new Set(visibleRows.map((row) => row.workspaceSlug)))} className="hover:text-foreground">全选</button><button type="button" onClick={() => { const removable = rows.filter((row) => row.references.length > 0).map((row) => row.workspaceSlug); setSelected(new Set()); prepareRemovalCandidates(removable) }} className="hover:text-foreground">清空</button></div></div><div className="grid max-h-56 gap-1 overflow-y-auto">{visibleRows.map((row) => <div key={row.workspaceSlug} className="rounded-md px-2 py-1.5 hover:bg-accent"><button type="button" disabled={busy} onClick={() => toggle(row)} className="flex w-full items-center gap-2 text-left text-xs disabled:opacity-50"><span className="flex size-4 shrink-0 items-center justify-center rounded border border-border">{selected.has(row.workspaceSlug) && <Check size={12} className="text-primary" />}</span><span className="min-w-0 flex-1 truncate">{row.workspaceName}</span>{row.references.length > 0 && <span className="text-[10px] text-muted-foreground">引用 {row.references.reduce((sum, item) => sum + item.objectCount, 0)}</span>}</button>{!selected.has(row.workspaceSlug) && row.references.length > 0 && <select aria-label={`${row.workspaceName} 的替代预设`} disabled={busy || candidateLoading.has(row.workspaceSlug)} value={replacementKeys[row.workspaceSlug] ?? ''} onChange={(event) => setReplacementKeys((previous) => ({ ...previous, [row.workspaceSlug]: event.target.value }))} className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 text-[11px]"><option value="">{candidateLoading.has(row.workspaceSlug) ? '加载替代预设…' : '选择替代预设…'}</option>{(candidates[row.workspaceSlug] ?? []).filter((candidate) => candidateKey(candidate) !== candidateKey(preset)).map((candidate) => <option key={`${candidate.scope}:${candidate.id}`} value={candidateKey(candidate)}>{candidate.name}</option>)}</select>}</div>)}{visibleRows.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">没有匹配的工作区</p>}</div></div></SettingsCard></div>
}
