/**
 * BranchTreeView - 真正的节点树状图（右侧抽屉）
 *
 * 设计（对照 VSCode / GitLens 缩略图 + 经典 hierarchy tree）：
 * - 一个对话对（user + 其下 assistant / tool 回复） = 一个「轮次节点」
 * - 自上而下的树：根在最上方，兄弟节点横向展开，父节点水平居中于其子节点之上
 * - 节点是圆形 + 序号；连线是平滑贝塞尔曲线（非直线拼接）
 * - 鼠标悬停圆形节点 → Portal 浮层展示该轮完整 user / assistant 内容
 * - 点击圆形节点 → 主视图切换到「该节点到根」的路径
 *
 * 数据层仍是消息级 DAG（BranchTreeSnapshot），UI 层先做 turn 聚合，
 * 再用「子树宽度打包」算法排出真实的树坐标。
 */

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { GitBranch, Loader2, AlertCircle, ZoomIn, ZoomOut, Maximize2, LocateFixed, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DeleteMessageDialog } from './DeleteMessageDialog'
import type { BranchTreeSnapshot } from '@profer/shared'

interface BranchTreeViewProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前对话 ID（用于按 ID 取单条消息 content） */
  conversationId: string
  /** 当前对话的快照（由 ChatView 提供；切换抽屉打开时再读一次） */
  tree: BranchTreeSnapshot | null
  /** 节点被点击切到主视图展示（从该节点到根） */
  onSwitchToPath: (path: string[]) => void | Promise<void>
  /** 重新拉取树（通常在分支变化后调用） */
  onReloadTree: () => Promise<void>
  /** 删除某个 turn（含其子树），由 ChatView 透传 handleDeleteMessage */
  onDeleteMessage: (messageId: string) => void | Promise<void>
}

// ===== Turn 模型 =====

interface Turn {
  /** 根 user message id */
  userId: string
  /** 后续 assistant / tool 消息 ids（DFS 顺序，直到下一个 user child） */
  descendantIds: string[]
  /** lane 索引（仅用于配色区分分支） */
  lane: number
  /** 是否在 active path 上 */
  isActive: boolean
  /** 是否是 active path 的"末端 turn" */
  isActiveTail: boolean
  /** 父 turn 的 userId（null 表示第一轮） */
  parentUserId: string | null
  /** 在用户视觉顺序中的索引 */
  order: number
}

/**
 * 把消息级 DAG 转换为 turn 列表，并分配 lane。
 *
 * 关键：DAG 结构是 user → assistant → user → assistant（assistant 嵌在 user 中间），
 * 所以要从 user 节点向下穿过 assistant 层才能找到下一轮 user 节点。
 */
function buildTurns(snapshot: BranchTreeSnapshot): Turn[] {
  const userTurns: Turn[] = []
  let laneCount = 0
  let order = 0

  // 从某节点向下递归寻找所有 user 后继（穿过 assistant / tool 中间层）
  function findNextUserIds(nodeId: string, out: string[]): void {
    const node = snapshot.nodes[nodeId]
    if (!node) return
    for (const childId of node.childIds) {
      const child = snapshot.nodes[childId]
      if (!child) continue
      if (child.role === 'user') {
        out.push(childId)
      } else {
        findNextUserIds(childId, out)
      }
    }
  }

  function visit(nodeId: string, lane: number, parentUserId: string | null): void {
    const node = snapshot.nodes[nodeId]
    if (!node || node.role !== 'user') return

    // BFS 收集该 user 之下的所有非 user 子节点（assistant / tool），保持子节点原有顺序
    const descendantIds: string[] = []
    const queue: string[] = [...node.childIds]
    // 用 index 指针而非 shift()：Array.shift() 每次 O(n)，大树上退化为 O(n²)
    for (let qi = 0; qi < queue.length; qi++) {
      const childId = queue[qi]!
      const child = snapshot.nodes[childId]
      if (!child) continue
      if (child.role === 'user') continue
      descendantIds.push(childId)
      // 非 user 节点的 child 也算 descendant（tool 嵌套等）
      queue.push(...child.childIds)
    }

    userTurns.push({
      userId: nodeId,
      descendantIds,
      lane,
      isActive: false,
      isActiveTail: false,
      parentUserId,
      order: order++,
    })

    // 向下穿过 assistant 层找下一轮 user 节点
    const nextUserIds: string[] = []
    findNextUserIds(nodeId, nextUserIds)
    // 按 createdAt 排序保证视觉稳定
    nextUserIds.sort((a, b) => {
      const na = snapshot.nodes[a]?.createdAt ?? 0
      const nb = snapshot.nodes[b]?.createdAt ?? 0
      return na - nb
    })

    nextUserIds.forEach((nextId, idx) => {
      // 第一个沿用当前 lane；后续每个开新 lane
      const childLane = idx === 0 ? lane : ++laneCount
      // 子 turn 看到的 parentLane = 父 turn 所在 lane（也就是当前 turn 的 lane）
      visit(nextId, childLane, nodeId)
    })
  }

  for (const rid of snapshot.rootIds) {
    const node = snapshot.nodes[rid]
    if (!node) continue
    if (node.role === 'user') {
      visit(rid, laneCount, null)
    } else {
      // 跳过非 user 的根节点（孤立 assistant / system 等）
    }
  }

  const activePath = snapshot.activePath
  if (activePath.length > 0) {
    const activeSet = new Set(activePath)
    const lastId = activePath[activePath.length - 1]!
    let lastTurnIdx = -1
    userTurns.forEach((t, idx) => {
      const allOnActive = activeSet.has(t.userId) && t.descendantIds.every((id) => activeSet.has(id))
      t.isActive = allOnActive
      if (lastId === t.userId || t.descendantIds.includes(lastId)) {
        t.isActiveTail = true
        lastTurnIdx = idx
      }
    })
    if (lastTurnIdx === -1) {
      for (let i = userTurns.length - 1; i >= 0; i--) {
        if (userTurns[i]!.isActive) {
          userTurns[i]!.isActiveTail = true
          break
        }
      }
    }
  }

  return userTurns
}

// ===== Lane 配色 =====

const LANE_COLORS = [
  'hsl(217, 91%, 60%)',
  'hsl(280, 65%, 60%)',
  'hsl(160, 60%, 45%)',
  'hsl(30, 95%, 55%)',
  'hsl(340, 80%, 55%)',
  'hsl(50, 90%, 50%)',
] as const

// hover 预览路径专用色：与 active 主链同色（蓝色），区分靠「更粗线宽 + 更透的 opacity + 仅悬停临时出现」
const HOVER_PATH_COLOR = 'hsl(217, 91%, 60%)'

function laneColor(lane: number, isActive: boolean): string {
  if (isActive) return LANE_COLORS[0]!
  return LANE_COLORS[lane % LANE_COLORS.length]!
}

// ===== 树布局常量 =====

const NODE_R = 21 // 圆形节点半径（可点击）
const LEVEL_H = 92 // 相邻层级的垂直间距
const H_GAP = 46 // 兄弟子树之间的最小水平间距
const PAD_X = 48 // 左右留白
const PAD_TOP = 26
const PAD_BOTTOM = 30
const HOVER_OPEN_DELAY = 250 // 悬停打开内容面板的延迟（ms），避免鼠标划过节点就弹面板
const MIN_SCALE = 0.35 // 最小缩放
const MAX_SCALE = 2 // 最大缩放

// 视口持久化：按对话记住上次关闭时的缩放大小与平移位置
const VIEWPORT_STORAGE_KEY = 'profer.branch-tree-viewport'

interface SavedViewport {
  scale: number
  x: number
  y: number
}

function loadSavedViewport(conversationId: string): SavedViewport | null {
  try {
    const raw = localStorage.getItem(`${VIEWPORT_STORAGE_KEY}:${conversationId}`)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<SavedViewport>
    if (typeof p.scale !== 'number' || typeof p.x !== 'number' || typeof p.y !== 'number') return null
    if (!Number.isFinite(p.scale) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    // 兜底把 scale 夹回合法范围，防止历史/损坏数据导致极端缩放
    return {
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale)),
      x: p.x,
      y: p.y,
    }
  } catch {
    return null
  }
}

function saveViewport(conversationId: string, vp: SavedViewport): void {
  try {
    localStorage.setItem(`${VIEWPORT_STORAGE_KEY}:${conversationId}`, JSON.stringify(vp))
  } catch {
    // 忽略写入失败（隐私模式 / 存储配额满等）
  }
}

// ===== 抽屉宽度（左侧拖拽调宽） =====

const WIDTH_STORAGE_KEY = 'profer.branch-tree-width'
const DRAWER_MIN_W = 360 // 抽屉最小宽度
const DRAWER_DEFAULT_W = 512 // 抽屉默认宽度（与之前 sm:max-w-lg 一致）

function loadSavedWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(w)))
  } catch {
    // 忽略写入失败
  }
}

/** 把宽度夹进 [最小宽度, 视口 92%] 区间 */
function clampDrawerWidth(w: number): number {
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const maxW = Math.max(DRAWER_MIN_W, Math.round(viewportW * 0.92))
  return Math.min(maxW, Math.max(DRAWER_MIN_W, Math.round(w)))
}

// ===== 树布局 =====

interface LayoutNode {
  turn: Turn
  x: number
  y: number
  depth: number
  children: LayoutNode[]
  /** 从根到这里（含自身 user+descendant）的消息 ID 路径 */
  pathToRoot: string[]
}

interface TreeEdge {
  from: LayoutNode
  to: LayoutNode
  active: boolean
}

interface TreeLayout {
  nodes: LayoutNode[]
  edges: TreeEdge[]
  width: number
  height: number
  maxDepth: number
}

function buildTreeLayout(turns: Turn[], collapsedIds: ReadonlySet<string> = new Set()): TreeLayout {
  const nodeMap = new Map<string, LayoutNode>()
  for (const t of turns) {
    nodeMap.set(t.userId, { turn: t, x: 0, y: 0, depth: 0, children: [], pathToRoot: [] })
  }

  const roots: LayoutNode[] = []
  for (const t of turns) {
    const node = nodeMap.get(t.userId)!
    const parent = t.parentUserId ? nodeMap.get(t.parentUserId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // 按视觉顺序稳定排序（兄弟 & 根）
  const byOrder = (a: LayoutNode, b: LayoutNode) => a.turn.order - b.turn.order
  for (const n of nodeMap.values()) n.children.sort(byOrder)
  roots.sort(byOrder)

  // 深度遍历：计算 depth、pathToRoot、子树宽度。
  // 折叠节点按叶子处理：子树宽度只占一个节点，children 不再参与布局。
  function measure(node: LayoutNode, depth: number, parentPath: string[]): number {
    node.depth = depth
    node.pathToRoot = [...parentPath, node.turn.userId, ...node.turn.descendantIds]
    if (node.children.length === 0) return NODE_R * 2
    if (collapsedIds.has(node.turn.userId)) return NODE_R * 2
    let w = 0
    node.children.forEach((c, i) => {
      const cw = measure(c, depth + 1, node.pathToRoot)
      w += cw + (i > 0 ? H_GAP : 0)
    })
    return Math.max(w, NODE_R * 2)
  }

  // 放置：父节点水平居中于子节点之上；叶子作为子树占用连续水平条带
  function place(node: LayoutNode, leftX: number): number {
    if (node.children.length === 0 || collapsedIds.has(node.turn.userId)) {
      node.x = leftX + NODE_R
      return leftX + NODE_R * 2
    }
    let cx = leftX
    let firstChild: LayoutNode | null = null
    let lastChild: LayoutNode | null = null
    node.children.forEach((c, i) => {
      const right = place(c, cx)
      if (i === 0) firstChild = c
      lastChild = c
      cx = right + H_GAP
    })
    node.x = (firstChild!.x + lastChild!.x) / 2
    return cx - H_GAP
  }

  let cursor = PAD_X
  for (const root of roots) {
    const w = measure(root, 0, [])
    place(root, cursor)
    cursor += w + H_GAP
  }

  // 收集节点 & 边（折叠节点的子树不收集，从视图中消失）
  const nodes: LayoutNode[] = []
  const edges: TreeEdge[] = []
  function collect(n: LayoutNode): void {
    nodes.push(n)
    if (collapsedIds.has(n.turn.userId)) return
    for (const c of n.children) {
      edges.push({ from: n, to: c, active: n.turn.isActive && c.turn.isActive })
      collect(c)
    }
  }
  for (const root of roots) collect(root)

  let maxX = 0
  let maxDepth = 0
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x)
    maxDepth = Math.max(maxDepth, n.depth)
    n.y = PAD_TOP + n.depth * LEVEL_H
  }
  const width = maxX + NODE_R + PAD_X
  const height = PAD_TOP + maxDepth * LEVEL_H + NODE_R * 2 + PAD_BOTTOM

  return { nodes, edges, width, height, maxDepth }
}

// 贝塞尔曲线：从父节点底部平滑拐到子节点顶部
function edgePath(from: LayoutNode, to: LayoutNode): string {
  const x1 = from.x
  const y1 = from.y + NODE_R
  const x2 = to.x
  const y2 = to.y - NODE_R
  const my = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
}

// module 级缓存：避免重复拉取同一 message 的完整 content。
// key = conversationId → messageId → content；嵌套结构避免跨对话的 messageId 撞车，
// 例如 conversationA 与 conversationB 中都存在 id="u-1" 的 user message 时互不覆盖。
const messageContentCache = new Map<string, Map<string, string>>()

const ContentPreview = React.memo(function ContentPreview({
  messageId,
  conversationId,
  compact = false,
}: {
  messageId: string
  conversationId: string
  compact?: boolean
}): React.ReactElement {
  const cached = messageContentCache.get(conversationId)?.get(messageId)
  const [content, setContent] = React.useState<string | null>(cached ?? null)
  const [loading, setLoading] = React.useState(cached === undefined)

  React.useEffect(() => {
    if (cached !== undefined) {
      setContent(cached)
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const api = window.electronAPI as unknown as {
          getMessageContent?: (cid: string, mid: string) => Promise<string | null>
        }
        const full = api.getMessageContent ? await api.getMessageContent(conversationId, messageId) : null
        if (cancelled) return
        const value = full ?? ''
        // 嵌套 Map 写入：外层按 conversationId 隔离，内层按 messageId 寻址
        let inner = messageContentCache.get(conversationId)
        if (!inner) {
          inner = new Map<string, string>()
          messageContentCache.set(conversationId, inner)
        }
        inner.set(messageId, value)
        setContent(value)
      } catch {
        if (cancelled) return
        setContent('')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [messageId, conversationId, cached])

  if (loading) {
    return <div className="text-xs text-muted-foreground italic px-3 py-2">加载中…</div>
  }
  return (
    <div className={cn('rounded-md border bg-muted/30 px-3 py-2 whitespace-pre-wrap break-words', compact ? 'text-xs' : 'text-sm')}>
      {content && content.length > 0 ? content : '(空)'}
    </div>
  )
})

function TurnFullContent({ turn, conversationId }: { turn: Turn; conversationId: string }): React.ReactElement {
  return (
    <div className="space-y-3 p-4">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">用户消息</div>
        <ContentPreview messageId={turn.userId} conversationId={conversationId} />
      </div>
      {turn.descendantIds.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            助手回复（{turn.descendantIds.length} 条）
          </div>
          <div className="space-y-2">
            {turn.descendantIds.map((id) => (
              <ContentPreview key={id} messageId={id} conversationId={conversationId} compact />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 树画布 =====

interface TreeCanvasProps {
  layout: TreeLayout
  conversationId: string
  onSwitch: (id: string) => void
  /** 当前折叠的节点 id 集合（折叠后其子树不参与布局/渲染） */
  collapsedIds: ReadonlySet<string>
  /** 切换某个节点的折叠状态 */
  onToggleCollapse: (id: string) => void
  /** 删除某个 turn（含其子树） */
  onDelete: (id: string) => void
}

function TreeCanvas({ layout, conversationId, onSwitch, collapsedIds, onToggleCollapse, onDelete }: TreeCanvasProps): React.ReactElement {
  // 视口是否已锁定（恢复了保存值 / 已做过首次自动适配）。锁定后不再自动 fit，
  // 完全尊重用户保存的位置。用「永久锁定」而非「跳过一次」：React.StrictMode 在 dev 下
  // 会对 effect 做 setup→cleanup→setup 双跑，"跳过一次"的 ref 会在第一次 setup 被消耗、
  // 第二次 setup 又触发 fitToWidth，把恢复的视口覆盖掉，导致"记住位置"失效。
  const viewportLockedRef = React.useRef(false)
  const [viewport, setViewport] = React.useState<SavedViewport>(() => {
    const saved = loadSavedViewport(conversationId)
    if (saved) {
      viewportLockedRef.current = true
      return saved
    }
    return { scale: 1, x: 0, y: 0 }
  })
  const viewportRef = React.useRef(viewport)
  React.useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])
  // 面板状态合并到一个对象，避免多个独立 useState 因 useCallback 依赖产生 stale closure 时序问题
  interface PanelState {
    id: string | null
    box: { top: number; left: number } | null
    mounted: boolean
    visible: boolean
  }
  const [panel, setPanel] = React.useState<PanelState>({
    id: null,
    box: null,
    mounted: false,
    visible: false,
  })
  // 当前面板内容来源（hoverId 用于从 layout 找节点）
  const [hoverId, setHoverId] = React.useState<string | null>(null)
  const [hoverBox, setHoverBox] = React.useState<{ top: number; left: number } | null>(null)
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const openTimer = React.useRef<number | null>(null)
  const dragRef = React.useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const panelWidth = 400
  // 用 ref 跟踪 mounted 状态，避免 openPanel 因 panelMounted 变化导致函数引用频繁变化
  const panelMountedRef = React.useRef(false)
  React.useEffect(() => {
    panelMountedRef.current = panel.mounted
  }, [panel.mounted])

  const hoveredNode = hoverId ? layout.nodes.find((n) => n.turn.userId === hoverId) ?? null : null

  // hover 节点 → 高亮其到根的 user 节点集合（用于预览目标分支的路径）
  const hoverPathSet = React.useMemo(() => {
    if (!hoverId) return null
    const set = new Set<string>()
    let cur: LayoutNode | null = layout.nodes.find((n) => n.turn.userId === hoverId) ?? null
    while (cur) {
      set.add(cur.turn.userId)
      cur = cur.turn.parentUserId
        ? (layout.nodes.find((n) => n.turn.userId === cur!.turn.parentUserId) ?? null)
        : null
    }
    return set
  }, [hoverId, layout])

  // 右键菜单状态
  const [contextMenu, setContextMenu] = React.useState<{ id: string; top: number; left: number } | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  // 删除确认对话框状态
  const [deleteTargetId, setDeleteTargetId] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)

  // 自动适配宽度（打开 / 树变化时）：缩放并居中
  const fitToWidth = React.useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    const availW = el.clientWidth - 24
    if (availW <= 0 || layout.width <= 0) return
    const next = Math.max(MIN_SCALE, Math.min(availW / layout.width, 1.25))
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const treeCx = layout.width / 2
    const treeCy = layout.height / 2
    setViewport({ scale: next, x: cx - treeCx * next, y: cy - treeCy * next })
  }, [layout.width, layout.height])

  React.useEffect(() => {
    // 首次（无保存值）自动适配一次并锁定；有保存值已在初始化时锁定，这里直接跳过。
    // 锁定后树变化不再自动 fit，避免覆盖用户手动缩放/拖拽后的位置。
    if (viewportLockedRef.current) return
    viewportLockedRef.current = true
    fitToWidth()
  }, [fitToWidth])

  // 持久化视口：debounce 200ms 写入 localStorage（拖拽/缩放后自动记住）
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      saveViewport(conversationId, viewport)
    }, 200)
    return () => clearTimeout(t)
  }, [viewport, conversationId])

  // 卸载时兜底保存最新视口（确保最后一次拖拽位置不丢）
  React.useEffect(() => {
    return () => {
      saveViewport(conversationId, viewportRef.current)
    }
  }, [conversationId])

  // 聚焦到当前 active tail（若被折叠隐藏则回退到最后一个可见的 active 节点）
  const focusActive = React.useCallback(() => {
    const el = canvasRef.current
    if (!el) return
    const target =
      layout.nodes.find((n) => n.turn.isActiveTail) ??
      [...layout.nodes].reverse().find((n) => n.turn.isActive)
    if (!target) return
    const v = viewportRef.current
    const sx = target.x * v.scale + v.x
    const sy = target.y * v.scale + v.y
    const dx = el.clientWidth / 2 - sx
    const dy = el.clientHeight / 2 - sy
    setViewport((vp) => ({ ...vp, x: vp.x + dx, y: vp.y + dy }))
  }, [layout])

  // 右键菜单：点击外部 / Esc 关闭
  React.useEffect(() => {
    if (!contextMenu) return
    const handleDocMouseDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (menuRef.current && !menuRef.current.contains(t)) setContextMenu(null)
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleDocMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  const cancelOpenTimer = React.useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  /** 关闭面板（淡出 160ms 后卸载 DOM） */
  const closePanel = React.useCallback(() => {
    cancelOpenTimer()
    setPanel((p) => ({ ...p, visible: false }))
    window.setTimeout(() => {
      setPanel({ id: null, box: null, mounted: false, visible: false })
      setHoverId(null)
      setHoverBox(null)
    }, 160)
  }, [cancelOpenTimer])

  /** 以画布内某点 (cx, cy) 为锚点缩放（缩放时该点下的内容保持不动） */
  const zoomAt = React.useCallback((cx: number, cy: number, factor: number) => {
    closePanel()
    setViewport((v) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = nextScale / v.scale
      return { scale: nextScale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }, [closePanel])

  /** 以画布中心为锚点缩放（供工具条按钮用） */
  const zoomBy = React.useCallback((factor: number) => {
    const el = canvasRef.current
    if (!el) return
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor)
  }, [zoomAt])

  /** 左键按住空白区域开始拖拽平移（节点上有自己的点击/右键处理，不触发平移） */
  const handleCanvasMouseDown = React.useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const t = e.target as Element | null
    if (t?.closest('[data-node-id]')) return
    const v = viewportRef.current
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: v.x, startPanY: v.y }
    setIsDragging(true)
    closePanel()
  }, [closePanel])

  // 滚轮缩放（以鼠标位置为锚点）；用原生监听器绕过 React 的 passive wheel 限制
  React.useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      zoomAt(cx, cy, factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // 拖拽平移：window 级 mousemove/mouseup，保证拖出画布也能继续
  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const d = dragRef.current
      setViewport((v) => ({ ...v, x: d.startPanX + (e.clientX - d.startX), y: d.startPanY + (e.clientY - d.startY) }))
    }
    const onUp = () => {
      dragRef.current = null
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  /** 打开 / 切换面板：原子地更新所有 panel 状态，根除 useCallback stale closure 与异步时序问题 */
  const openPanel = React.useCallback((node: LayoutNode) => {
    if (dragRef.current) return // 拖拽平移中不打开面板
    cancelOpenTimer()
    const rect = (document.querySelector(`[data-node-id="${node.turn.userId}"]`) as SVGGElement | null)?.getBoundingClientRect()
    if (!rect) return
    // 面板紧贴节点左侧相切（无 gap）；垂直方向优先放到节点上方，
    // 若节点太靠下导致上方空间不足，则翻转到节点下方。无论如何 top 都被 clamp 进视口。
    const margin = 12
    const viewportH = window.innerHeight
    const posAbove = rect.top - 20
    const posBelow = rect.bottom + 8
    const spaceAbove = posAbove - margin
    const spaceBelow = viewportH - posBelow - margin
    // 下方空间更充足时放节点下方（避免面板向下溢出视口），否则放上方
    const topRaw = spaceBelow >= spaceAbove && spaceBelow > 80 ? posBelow : posAbove
    const pos = {
      top: Math.max(margin, Math.min(topRaw, viewportH - margin)),
      left: Math.max(margin, rect.left - panelWidth + 8), // 面板右边缘 = 节点左边缘 + 8（避免超出视口左缘）
    }
    setHoverBox(pos)
    setHoverId(node.turn.userId)
    // 用 ref 判断 mounted，避免函数被频繁替换（每次 panelMounted 变化都会重新创建 openPanel，
    // 旧引用在某些时序下会被事件系统用，造成"有时不挂载"的 bug）
    if (!panelMountedRef.current) {
      // 首次 / 关闭后再次 hover：延迟 HOVER_OPEN_DELAY 后再挂载（避免鼠标划过就弹面板）。
      // 一次性 mounted+visible，靠 @keyframes 动画淡入，无需两步。
      openTimer.current = window.setTimeout(() => {
        setPanel({ id: node.turn.userId, box: pos, mounted: true, visible: true })
      }, HOVER_OPEN_DELAY)
    } else {
      // 已经在 DOM 里：只更新 id/box + 确保可见（避免淡出动画期间被截断）
      setPanel((p) => ({ ...p, id: node.turn.userId, box: pos, visible: true }))
    }
  }, [cancelOpenTimer])

  React.useEffect(() => cancelOpenTimer, [cancelOpenTimer])

  /** 鼠标离开节点：若面板尚未挂载（还在打开延迟中），取消本次打开并清理高亮 */
  const handleNodeLeave = React.useCallback(() => {
    cancelOpenTimer()
    if (!panelMountedRef.current) {
      setHoverId(null)
      setHoverBox(null)
    }
    // 面板已挂载时什么都不做，交给 document.mousemove 的离开检测处理
  }, [cancelOpenTimer])

  // 用 document.mousemove 检测鼠标是否在「节点 ∪ 面板」区域内，
  // 只要在任一区域内，鼠标自由移动都不关闭；离开两者超过 250ms 才关。
  // 额外：鼠标按住（拖选文本中）不关闭，避免选到一半面板消失。
  React.useEffect(() => {
    if (!panel.mounted) return
    let closeTimer: number | null = null

    const isInHoverZone = (x: number, y: number): boolean => {
      // 面板区域（带 4px 容差，桥接节点↔面板）
      if (panelRef.current) {
        const r = panelRef.current.getBoundingClientRect()
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) {
          return true
        }
      }
      // 节点区域（任意节点，不只是当前 hover 的那个）
      const el = document.elementFromPoint(x, y) as Element | null
      if (el?.closest('[data-node-id]')) return true
      return false
    }

    const handleMove = (e: MouseEvent): void => {
      // 拖选文本 / 任何鼠标按下状态：不调度关闭
      if (e.buttons !== 0) {
        if (closeTimer) {
          clearTimeout(closeTimer)
          closeTimer = null
        }
        return
      }
      if (isInHoverZone(e.clientX, e.clientY)) {
        if (closeTimer) {
          clearTimeout(closeTimer)
          closeTimer = null
        }
      } else if (!closeTimer) {
        closeTimer = window.setTimeout(() => {
          closePanel()
          closeTimer = null
        }, 250)
      }
    }

    document.addEventListener('mousemove', handleMove)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [panel.mounted, closePanel])

  // 点击 / 滚动 / Esc 关闭
  React.useEffect(() => {
    if (!panel.mounted) return

    const handleDocMouseDown = (e: MouseEvent): void => {
      // 用户正在面板内或任意位置选中文本 → 不关（拖选过程中鼠标会移到面板外）
      const selection = window.getSelection?.()?.toString() ?? ''
      if (selection.length > 0) return
      const t = e.target as Element | null
      if (panelRef.current && panelRef.current.contains(t)) return
      if (t?.closest?.('[data-node-id]')) return
      closePanel()
    }

    const handleScroll = (e: Event): void => {
      // 拖选文本中触发自动滚动 → 不关
      const selection = window.getSelection?.()?.toString() ?? ''
      if (selection.length > 0) return
      const target = e.target as Element | null
      // 面板内部滚动（用户主动滚面板内容）→ 不要关
      if (panelRef.current && panelRef.current.contains(target)) return
      // 画布已改为「滚轮缩放 + 左键拖拽平移」，不再有外层滚动事件
    }

    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }

    document.addEventListener('mousedown', handleDocMouseDown)
    window.addEventListener('scroll', handleScroll, true)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown)
      window.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('keydown', handleKey)
    }
  }, [panel.mounted, closePanel])

  return (
    <div className="flex flex-col h-full">
      {/* 缩放工具条 */}
      <div className="flex items-center gap-1 px-3 py-2 border-b">
        <Button variant="ghost" size="icon" className="size-7" title="缩小" onClick={() => zoomBy(1 / 1.12)}>
          <ZoomOut className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="放大" onClick={() => zoomBy(1.12)}>
          <ZoomIn className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="适应宽度" onClick={fitToWidth}>
          <Maximize2 className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="聚焦到当前对话" onClick={focusActive}>
          <LocateFixed className="size-4" />
        </Button>
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">{Math.round(viewport.scale * 100)}%</span>
      </div>

      {/* 树形画布：滚轮缩放 + 左键拖拽平移 */}
      <div
        ref={canvasRef}
        className={cn('flex-1 overflow-hidden relative', isDragging ? 'cursor-grabbing' : 'cursor-grab')}
        onMouseDown={handleCanvasMouseDown}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: '0 0',
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="select-none"
            role="img"
            aria-label="对话节点树"
          >
            {/* 连线 */}
            {layout.edges.map((e) => {
              const active = e.active
              // hover 时高亮"该节点到根"的路径连线（区别于 active 分支）
              const onHoverPath = !!hoverPathSet?.has(e.from.turn.userId) && !!hoverPathSet.has(e.to.turn.userId)
              const isHovering = hoverPathSet !== null
              const color = onHoverPath
                ? HOVER_PATH_COLOR
                : active
                  ? laneColor(e.from.turn.lane, true)
                  : 'hsl(217 91% 60% / 0.28)'
              // hover 时交换主次：hover 链最不透明(1)，active 链退后(0.45)，历史分支更透(0.3)
              const opacity = onHoverPath ? 1 : active ? (isHovering ? 0.45 : 1) : (isHovering ? 0.3 : 0.5)
              const strokeWidth = onHoverPath ? 3 : active ? 2.4 : 1.6
              return (
                <path
                  key={`${e.from.turn.userId}-${e.to.turn.userId}`}
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  opacity={opacity}
                  style={{ transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.15s' }}
                />
              )
            })}

            {/* 节点 */}
            {layout.nodes.map((n) => {
              const color = laneColor(n.turn.lane, n.turn.isActive)
              const isHover = hoverId === n.turn.userId
              const isOnHoverPath = !!hoverPathSet?.has(n.turn.userId)
              const hasChildren = n.children.length > 0
              const collapsed = collapsedIds.has(n.turn.userId)
              return (
                <g
                  key={n.turn.userId}
                  data-node-id={n.turn.userId}
                  transform={`translate(${n.x}, ${n.y})`}
                  className="cursor-pointer group"
                  onMouseEnter={() => openPanel(n)}
                  onMouseLeave={handleNodeLeave}
                  onClick={() => onSwitch(n.turn.userId)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setContextMenu({ id: n.turn.userId, top: e.clientY, left: e.clientX })
                  }}
                >
                  {/* 点击热区（稍大） */}
                  <circle r={NODE_R + 4} fill="transparent" />
                  <circle
                    r={NODE_R}
                    fill={n.turn.isActiveTail ? color : 'hsl(210 40% 98%)'}
                    stroke={isHover || isOnHoverPath ? HOVER_PATH_COLOR : n.turn.isActive ? color : 'hsl(217 91% 60% / 0.45)'}
                    strokeWidth={isHover ? 2.6 : isOnHoverPath ? 2.4 : 2}
                    style={{ transition: 'stroke 0.15s, fill 0.15s' }}
                  />
                  {/* 序号 */}
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fontWeight={600}
                    fill={n.turn.isActiveTail ? 'hsl(210 40% 98%)' : color}
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.turn.order + 1}
                  </text>
                  {/* active tail 外圈光晕 */}
                  {n.turn.isActiveTail && (
                    <circle r={NODE_R + 4} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={1.5} />
                  )}
                  {/* 折叠/展开指示器（有子节点才显示） */}
                  {hasChildren && (
                    <g
                      transform={`translate(${NODE_R * 0.78}, ${-NODE_R * 0.78})`}
                      className="cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleCollapse(n.turn.userId)
                      }}
                    >
                      <circle r={8} fill="hsl(210 40% 98%)" stroke="hsl(217 91% 60% / 0.55)" strokeWidth={1.5} />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={11}
                        fontWeight={700}
                        fill="hsl(217 91% 60%)"
                        style={{ pointerEvents: 'none' }}
                      >
                        {collapsed ? '+' : '-'}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>

      <div className="px-4 pb-3 text-[11px] text-muted-foreground/70 leading-relaxed">
        共 {layout.nodes.length} 轮 · 悬停查看内容 · 点击切换分支 · 节点右上角 -/+ 折叠 · 右键删除 · 滚轮缩放 · 左键拖拽平移
      </div>

      {/* 悬停浮层（Portal 挂到 body，避免被 ScrollArea 裁剪；带淡入/淡出动画）
       * 关键：所有交互事件 stopPropagation，避免 document 级 mousedown/scroll handler
       * 把面板内的"点击开始选文本 / 滚轮 / 拖选"误判为"在面板外点击 → 关闭面板"。 */}
      {panel.mounted && hoveredNode && panel.box && typeof document !== 'undefined' && ReactDOM.createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="对话完整内容"
          // stopPropagation 在 capture 阶段执行，document handler 收不到任何面板内的事件
          onMouseDownCapture={(e) => e.stopPropagation()}
          onMouseUpCapture={(e) => e.stopPropagation()}
          onClickCapture={(e) => e.stopPropagation()}
          onWheelCapture={(e) => e.stopPropagation()}
          // scroll 事件不冒泡，但用 capture 也保险一次
          onScrollCapture={(e) => e.stopPropagation()}
          className={cn(
            "fixed overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-0 shadow-lg",
            // @keyframes 动画由 globals.css 的 .animate-branch-tree-panel-in 定义
            panel.visible && "animate-branch-tree-panel-in",
          )}
          style={{
            top: panel.box.top,
            left: panel.box.left,
            width: panelWidth,
            // maxHeight 跟随 top 动态计算：面板底边 = top + (100vh - top - 12) = 100vh - 12，
            // 永远在视口底部留 12px，内容滚动到底也能看到最后一行，不会被屏幕外截断。
            maxHeight: `calc(100vh - ${panel.box.top}px - 12px)`,
            zIndex: 9999,
            // 不可见时强制隐藏 + 禁交互（动画入场期间也确保 pointer-events）
            opacity: panel.visible ? undefined : 0,
            pointerEvents: panel.visible ? 'auto' : 'none',
          }}
        >
          <TurnFullContent turn={hoveredNode.turn} conversationId={conversationId} />
        </div>,
        document.body,
      )}

      {/* 右键菜单（Portal 到 body，删除该分支） */}
      {contextMenu && typeof document !== 'undefined' && ReactDOM.createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[10000] min-w-[160px] rounded-md border bg-popover p-1 shadow-lg"
          style={{ top: contextMenu.top, left: contextMenu.left }}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onClickCapture={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            onClick={() => {
              const id = contextMenu.id
              setContextMenu(null)
              setDeleteTargetId(id)
            }}
          >
            <Trash2 className="size-3.5" />
            删除此分支
          </button>
        </div>,
        document.body,
      )}

      {/* 删除确认对话框（复用主视图的 DeleteMessageDialog） */}
      <DeleteMessageDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null)
        }}
        isDeleting={isDeleting}
        onConfirm={() => {
          if (!deleteTargetId) return
          const id = deleteTargetId
          setIsDeleting(true)
          void (async () => {
            try {
              await onDelete(id)
            } finally {
              setIsDeleting(false)
              setDeleteTargetId(null)
            }
          })()
        }}
      />
    </div>
  )
}

// ===== 主组件 =====

export function BranchTreeView({
  open,
  onOpenChange,
  conversationId,
  tree,
  onSwitchToPath,
  onReloadTree,
  onDeleteMessage,
}: BranchTreeViewProps): React.ReactElement {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // 折叠的 turn id 集合（折叠后子树不参与布局/渲染，布局自动收紧）
  const [collapsedIds, setCollapsedIds] = React.useState<ReadonlySet<string>>(new Set())
  // 抽屉宽度（支持鼠标左键拖拽左侧边缘向左扩大/向右缩小）
  const [drawerWidth, setDrawerWidth] = React.useState<number>(() => {
    const saved = loadSavedWidth()
    return saved ? clampDrawerWidth(saved) : DRAWER_DEFAULT_W
  })
  const resizeStateRef = React.useRef<{ startX: number; startWidth: number } | null>(null)

  // 拖拽开始：记录起点与起始宽度
  const handleResizeStart = React.useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeStateRef.current = { startX: e.clientX, startWidth: drawerWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [drawerWidth])

  // 拖拽中：向左拖（clientX 减小）→ 宽度增大；向右拖 → 宽度减小
  React.useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!resizeStateRef.current) return
      const { startX, startWidth } = resizeStateRef.current
      setDrawerWidth(clampDrawerWidth(startWidth - (e.clientX - startX)))
    }
    const onUp = (): void => {
      resizeStateRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  // 持久化抽屉宽度（debounce，避免拖拽时频繁写 localStorage）
  React.useEffect(() => {
    const t = window.setTimeout(() => saveWidth(drawerWidth), 200)
    return () => clearTimeout(t)
  }, [drawerWidth])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await onReloadTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [onReloadTree])

  React.useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 树变化（删除/刷新）后清理已不存在的折叠 id
  React.useEffect(() => {
    if (!tree) return
    const validIds = new Set(Object.keys(tree.nodes))
    setCollapsedIds((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (validIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [tree])

  const toggleCollapse = React.useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const turns = React.useMemo(() => (tree ? buildTurns(tree) : []), [tree])
  const layout = React.useMemo(() => buildTreeLayout(turns, collapsedIds), [turns, collapsedIds])

  const fullPathByNode = React.useMemo(() => {
    const map = new Map<string, string[]>()
    for (const n of layout.nodes) map.set(n.turn.userId, n.pathToRoot)
    return map
  }, [layout])

  const handleSwitch = React.useCallback(
    async (userId: string) => {
      const fullPath = fullPathByNode.get(userId)
      if (!fullPath || fullPath.length === 0) return
      try {
        await onSwitchToPath(fullPath)
        toast.success(`主视图已切换 (${fullPath.length} 条消息)`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [fullPathByNode, onSwitchToPath],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex flex-col p-0"
        style={{ width: drawerWidth, maxWidth: 'none' }}
      >
        {/* 左侧拖拽手柄：左键按住向左拖扩大显示区域，向右拖缩小 */}
        <div
          className="group absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize"
          onMouseDown={handleResizeStart}
          title="拖动调整宽度"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
        </div>

        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <GitBranch className="size-4" />
            对话节点图
          </SheetTitle>
          <SheetDescription>
            一个圆形节点 = 一轮完整对话（你 + 助手回复）。悬停节点查看内容，点击切换主视图分支。
          </SheetDescription>
        </SheetHeader>

        {loading && tree === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive mx-4 my-4">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">加载失败</div>
              <div className="text-xs opacity-80 mt-1">{error}</div>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void refresh()}>
                重试
              </Button>
            </div>
          </div>
        ) : layout.nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <GitBranch className="size-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">还没有对话轮次</div>
          </div>
        ) : (
          <TreeCanvas
            key={conversationId}
            layout={layout}
            conversationId={conversationId}
            onSwitch={(id) => void handleSwitch(id)}
            collapsedIds={collapsedIds}
            onToggleCollapse={toggleCollapse}
            onDelete={(id) => void onDeleteMessage(id)}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
