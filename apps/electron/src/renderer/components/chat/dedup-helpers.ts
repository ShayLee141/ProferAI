/**
 * dedup-helpers - Chat 输入附件去重纯函数
 *
 * 设计动机（原 PR #122 review 反馈）：
 * 原 ChatInput.tsx 的两条附件入口（addFilesAsAttachments 拖拽 / handleOpenFileDialog
 * 选择文件）都先从渲染快照 pendingAttachments 构造 existingKeys，再做异步
 * base64 转换，最后才 setPendingAttachments(prev => [...prev, item])。
 * 这种"读旧快照 → 异步转换 → 写"模式在快速重复拖入或混用入口时存在竞态：
 * 两次异步调用读到同一 prev 快照都成功添加，导致 atom 出现重复项。
 *
 * 本 helper 把判重做成基于最新 prev 的纯函数，由调用方在 setPendingAttachments
 * 的 prev => ... 回调内同步调用——React/Jotai 会序列化 prev 回调的执行，每次回调
 * 拿到的 prev 必然是写入链上最新值，从根上消除"读陈旧快照"的竞态。
 *
 * 用法：
 *   setPendingAttachments((prev) => {
 *     const result = dedupPendingAgainst(
 *       prev,
 *       candidates,        // 候选 { fileLike: {name,size}, item: T }[]
 *       (c) => c.fileLike
 *     )
 *     if (result.duplicateNames.length > 0) {
 *       toast.info(`已跳过重复文件：${formatDuplicateSummary(result.duplicateNames)}`, ...)
 *     }
 *     return result.accepted.length > 0 ? [...prev, ...result.accepted] : prev
 *   })
 */

export interface DedupCandidate<T> {
  /** 提供去重 key（一般就是 {name, size}）和 toast 文案要用的名字 */
  fileLike: { name: string; size: number }
  /** 真正要写入 atom 的对象 */
  item: T
}

export interface DedupResult<T> {
  /** 未命中已有/批内重复、可以入 atom 的 item */
  accepted: T[]
  /** 命中的文件名（原始顺序，可能含重复） */
  duplicateNames: string[]
}

/**
 * 同步判重：基于现有 prev 列表把候选项去重为 accepted / duplicateNames 两个集合。
 *
 * 规则（顺序）：
 * 1. 与 prev 已存在的同 filename+size 视为重复 → 入 duplicateNames
 * 2. 与同批内已接受的同 filename+size 视为重复 → 入 duplicateNames
 * 3. 都未命中 → 入 accepted
 *
 * 纯函数：不读闭包、不读 useState、不发起 I/O，可在 setPendingAttachments 的 prev
 * 回调内同步调用。
 */
export function dedupPendingAgainst<T>(
  prev: ReadonlyArray<{ filename: string; size: number }>,
  candidates: ReadonlyArray<DedupCandidate<T>>,
): DedupResult<T> {
  const existingKeys = new Set(
    prev.map((p) => `${p.filename}:${p.size}`)
  )
  const batchKeys = new Set<string>()
  const accepted: T[] = []
  const duplicateNames: string[] = []

  for (const c of candidates) {
    const key = `${c.fileLike.name}:${c.fileLike.size}`
    if (existingKeys.has(key) || batchKeys.has(key)) {
      duplicateNames.push(c.fileLike.name)
    } else {
      batchKeys.add(key)
      accepted.push(c.item)
    }
  }

  return { accepted, duplicateNames }
}

/**
 * 把"已跳过重复文件：a.pdf、a.pdf、b.pdf"折叠为"已跳过重复文件：a.pdf、b.pdf"，
 * 直接用于 toast 文案。
 *
 * 不能直接 [...new Set(names)] 再 join——formatFileNames 会根据数量截断，超过
 * 一定数量会显示 "等 N 个文件"。这里直接传 unique 后的数组让它整体截断，更友好。
 */
export function formatDuplicateSummary(duplicateNames: ReadonlyArray<string>): string {
  return duplicateNames.length === 0
    ? ''
    : [...new Set(duplicateNames)].join('、')
}
