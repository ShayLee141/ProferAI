/**
 * dedup-helpers 单元测试
 *
 * 覆盖场景：
 * 1. 基础：空 prev + 唯一 candidates → 全部接受
 * 2. 同批次去重：同 name+size 多次出现 → 只有一项 accepted
 * 3. 跨批次去重：prev 已存在 → 拒绝
 * 4. 同名不同 size：视为不同 → 正常入批
 * 5. toast 文案去重：同名多次出现 → 文案只一份（Copilot 提到的"a.pdf、a.pdf"问题）
 * 6. 关键 race-free 场景：模拟"两次几乎同时调用 helper 都基于同一 prev"，验证
 *    同步原子的 prev 回调语义下，最终 prev 只一项被接受（review #122 关键要求）
 */

import { describe, expect, test } from 'bun:test'
import {
  dedupPendingAgainst,
  formatDuplicateSummary,
  type DedupCandidate,
} from './dedup-helpers'

interface Item {
  id: string
  filename: string
  size: number
}

function mk(filename: string, size: number, id = filename + size): Item {
  return { id, filename, size }
}

function mkCand<T>(fileLike: { name: string; size: number }, item: T): DedupCandidate<T> {
  return { fileLike, item }
}

describe('dedupPendingAgainst', () => {
  test('accepts all when prev empty and batch unique', () => {
    const result = dedupPendingAgainst<Item>(
      [],
      [
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100)),
        mkCand({ name: 'b.pdf', size: 200 }, mk('b.pdf', 200)),
      ],
    )
    expect(result.accepted).toHaveLength(2)
    expect(result.duplicateNames).toEqual([])
  })

  test('dedups within same batch', () => {
    const result = dedupPendingAgainst<Item>(
      [],
      [
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'a1')),
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'a2')),
      ],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.id).toBe('a1')
    expect(result.duplicateNames).toEqual(['a.pdf'])
  })

  test('dedups against prev existing', () => {
    const result = dedupPendingAgainst<Item>(
      [{ filename: 'a.pdf', size: 100 }],
      [
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100)),
        mkCand({ name: 'b.pdf', size: 200 }, mk('b.pdf', 200)),
      ],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.filename).toBe('b.pdf')
    expect(result.duplicateNames).toEqual(['a.pdf'])
  })

  test('different size is not duplicate', () => {
    const result = dedupPendingAgainst<Item>(
      [{ filename: 'a.pdf', size: 100 }],
      [mkCand({ name: 'a.pdf', size: 200 }, mk('a.pdf', 200))],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.duplicateNames).toEqual([])
  })

  test('three mixed: 1 new + 2 dup → only 1 accepted, dup list preserves order', () => {
    const result = dedupPendingAgainst<Item>(
      [{ filename: 'a.pdf', size: 100 }],
      [
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'dup-a')),
        mkCand({ name: 'b.pdf', size: 200 }, mk('b.pdf', 200, 'new')),
        mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'dup-a2')),
      ],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.filename).toBe('b.pdf')
    expect(result.duplicateNames).toEqual(['a.pdf', 'a.pdf'])
  })

  test('empty candidates returns empty accepted and no duplicates', () => {
    const result = dedupPendingAgainst<Item>(
      [{ filename: 'a.pdf', size: 100 }],
      [],
    )
    expect(result.accepted).toEqual([])
    expect(result.duplicateNames).toEqual([])
  })

  test('uses fileLike field (intentional case sensitivity)', () => {
    // key 严格大小写敏感：A.PDF 与 a.pdf 视为不同文件
    const result = dedupPendingAgainst<{ name: string; size: number }>(
      [{ filename: 'A.PDF', size: 100 }],
      [{ fileLike: { name: 'a.pdf', size: 100 }, item: { name: 'a.pdf', size: 100 } }],
    )
    expect(result.accepted).toHaveLength(1)
    expect(result.duplicateNames).toEqual([])
  })
})

describe('formatDuplicateSummary', () => {
  test('empty input returns empty string', () => {
    expect(formatDuplicateSummary([])).toBe('')
  })

  test('single name returns the name', () => {
    expect(formatDuplicateSummary(['a.pdf'])).toBe('a.pdf')
  })

  test('dedups repeated names (avoids "a.pdf、a.pdf")', () => {
    expect(formatDuplicateSummary(['a.pdf', 'a.pdf', 'b.pdf'])).toBe('a.pdf、b.pdf')
  })

  test('preserves first-occurrence order', () => {
    expect(formatDuplicateSummary(['c.pdf', 'a.pdf', 'c.pdf'])).toBe('c.pdf、a.pdf')
  })
})

describe('race-free via setState(prev => ...) semantics', () => {
  /**
   * 关键场景（原 PR #122 review 要求）：
   * 用户在第一次异步处理完成前再拖入同一文件。
   *
   * 如果走"读快照 + 写"的旧模式：两次调用都拿到同一 prev（React 还没机会刷新），
   * 都判为"新文件"，都成功写入 → 重复。
   *
   * 修法：在 setPendingAttachments(prev => ...) 的 prev 回调里同步判重 + 写。
   * React/Jotai 会按提交顺序序列化执行 prev 回调：
   * - callA callback 拿到 prev=[] → 判为新 → prev=[A]
   * - callB callback 拿到 prev=[A]（已被 callA 刷过） → 判为重复 → prev=[A]
   *
   * 本测试模拟这种序列化执行，验证最终 atom 只有一项。
   */
  test('two parallel callbacks against same prev yield only one accepted item', () => {
    // 模拟 React 的 prev 链：每次 setState 回调返回的 prev 链上下一个调用看见
    type State = Item[]
    let state: State = []

    // callA：先调度一个 setState 回调（立即执行）
    function callA(prev: State): State {
      const result = dedupPendingAgainst<Item>(
        prev,
        [mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'from-A'))],
      )
      if (result.accepted.length > 0) return [...prev, ...result.accepted]
      return prev
    }

    // callB：同样基于"自己拿到的 prev"（旧代码 bug 场景就是都拿同一 prev）
    function callB(prev: State): State {
      const result = dedupPendingAgainst<Item>(
        prev,
        [mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'from-B'))],
      )
      if (result.accepted.length > 0) return [...prev, ...result.accepted]
      return prev
    }

    // 序列化执行两个 prev 回调（React commit 阶段的同一批会同步执行）
    const afterA = callA(state)
    state = afterA
    const afterB = callB(state)
    state = afterB

    // 最终 atom 只有 1 项（callB 看见 callA 已写入）
    expect(state).toHaveLength(1)
    expect(state[0]?.id).toBe('from-A')
  })

  test('broken pattern (read snapshot + write) IS racy — documented expected failure', () => {
    // 故意走"读旧快照"模式，证明它确实 race——helper 单独修不了这个调用语义，
    // 必须配合 setState(prev => ...) 才能根除。
    type State = Item[]
    let stateSnapshot: State = []

    // 模拟旧代码：两个调用都基于入栈时的 snapshot 判重
    const snapshotAtStart = stateSnapshot

    // callA 异步完成：snapshot 当时是 []
    const aAccepted = dedupPendingAgainst<Item>(
      snapshotAtStart,
      [mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'A'))],
    ).accepted.length > 0

    // callB 也在 snapshot 当时读到 []
    const bAccepted = dedupPendingAgainst<Item>(
      snapshotAtStart,
      [mkCand({ name: 'a.pdf', size: 100 }, mk('a.pdf', 100, 'B'))],
    ).accepted.length > 0

    // 两个都判为"新"——证明 race 确实存在
    expect(aAccepted).toBe(true)
    expect(bAccepted).toBe(true)

    // 这就是为什么必须把判重下沉到 setState(prev => ...) 内
    // 而不是 helper API 自身能解决的问题
  })
})
