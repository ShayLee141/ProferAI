import type { DOMOutputSpec } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

/** DOMOutputSpec 的兄弟节点必须直接放在父数组内，不能再套一层数组。 */
export function renderSessionMention(id: string, label: string): DOMOutputSpec {
  return [
    'span',
    {
      'data-type': 'mention',
      'data-id': id,
      'data-label': label,
      'data-mention-suggestion-char': '&',
      'data-session-reference': 'true',
      class: 'session-mention-chip',
      contenteditable: 'false',
      title: label,
    },
    ['span', { class: 'session-mention-label' }, label],
    ['button', {
      type: 'button',
      class: 'session-mention-remove',
      'data-session-reference-remove': 'true',
      'aria-label': `移除会话引用：${label}`,
      title: '移除引用（也可点击鼠标中键）',
      contenteditable: 'false',
    }, '×'],
  ]
}

function getTarget(event: Event): Element | null {
  const target = event.target as Node | null
  return target?.nodeType === 1 ? target as Element : target?.parentElement ?? null
}

/** 按 DOM 对应的位置删除单颗原子节点，不按 ID 删除，避免重复引用一起消失。 */
function removeSessionMention(view: EditorView, event: Event): boolean {
  const chip = getTarget(event)?.closest('[data-session-reference="true"]')
  if (!chip || !view.dom.contains(chip)) return false
  event.preventDefault()
  event.stopPropagation()
  if (!view.editable) return true
  const pos = view.posAtDOM(chip, 0)
  const node = view.state.doc.nodeAt(pos)
  if (node?.type.name !== 'mention' || node.attrs.mentionSuggestionChar !== '&'
      || node.attrs.id !== chip.getAttribute('data-id')) return true
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView())
  view.focus()
  return true
}

export function handleSessionMentionMouseDown(view: EditorView, event: MouseEvent): boolean {
  if (event.button === 1) return removeSessionMention(view, event)
  if (event.button !== 0 || !getTarget(event)?.closest('[data-session-reference-remove="true"]')) return false
  // 避免 ProseMirror 先改变选区；真正删除由 click 完成，兼容触屏和键盘按钮激活。
  event.preventDefault()
  event.stopPropagation()
  return true
}

export function handleSessionMentionClick(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || !getTarget(event)?.closest('[data-session-reference-remove="true"]')) return false
  return removeSessionMention(view, event)
}

export function handleSessionMentionKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if ((event.key !== 'Enter' && event.key !== ' ')
      || !getTarget(event)?.closest('[data-session-reference-remove="true"]')) return false
  return removeSessionMention(view, event)
}
