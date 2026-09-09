import * as React from 'react'
import { AlertTriangle, Check, CircleX, Pause, Play, Square, Target } from 'lucide-react'
import { useAtomValue } from 'jotai'
import type { AgentGoalState } from '@profer/shared'
import { agentGoalAtomFamily } from '@/atoms/goal-atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Props = { sessionId: string }

const labels: Record<AgentGoalState['status'], string> = {
  active: '执行中', paused: '已暂停', completed: '已完成', blocked: '等待处理', failed: '执行失败', stopped: '已停止',
}

const statusIconClass: Record<AgentGoalState['status'], string> = {
  active: 'text-primary animate-pulse', paused: 'text-muted-foreground', completed: 'text-emerald-500', blocked: 'text-amber-500', failed: 'text-destructive', stopped: 'text-muted-foreground',
}

function GoalIcon({ status }: { status: AgentGoalState['status'] }): React.ReactElement {
  if (status === 'blocked') return <AlertTriangle className="size-3.5 text-amber-500" aria-hidden="true" />
  if (status === 'completed') return <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
  if (status === 'failed') return <CircleX className="size-3.5 text-destructive" aria-hidden="true" />
  return <Target className={cn('size-3.5', statusIconClass[status])} aria-hidden="true" />
}

export function GoalStatusBar({ sessionId }: Props): React.ReactElement | null {
  const goal = useAtomValue(agentGoalAtomFamily(sessionId))
  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!goal) return
    const update = () => setElapsed(Math.max(0, Date.now() - goal.startedAt))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [goal])
  if (!goal) return null
  const seconds = Math.floor(elapsed / 1000)
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  const invoke = (action: 'pause' | 'resume' | 'stop') => window.electronAPI[`${action}Goal`](sessionId).catch(console.error)
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-primary/[0.04] px-3 py-2 text-xs" data-testid="goal-status-bar">
      <span className="flex shrink-0 items-center gap-1.5" aria-label={`Goal ${labels[goal.status]}`}>
        <GoalIcon status={goal.status} />
        <span className="font-semibold">Goal</span>
      </span>
      <span className="min-w-0 flex-1 truncate font-medium" title={goal.goal}>{goal.goal}</span>
      <span className={cn('shrink-0', goal.status === 'active' ? 'text-primary' : goal.status === 'blocked' ? 'text-amber-500' : 'text-muted-foreground')} role="status">{labels[goal.status]}</span>
      <span className="shrink-0 text-muted-foreground">第 {goal.iteration} 轮 · {duration}</span>
      {goal.status === 'active' && <Button size="icon" variant="ghost" className="size-6" title="暂停 Goal" onClick={() => invoke('pause')}><Pause className="size-3" /></Button>}
      {goal.status === 'paused' && <Button size="icon" variant="ghost" className="size-6" title="恢复 Goal" onClick={() => invoke('resume')}><Play className="size-3" /></Button>}
      {(goal.status === 'active' || goal.status === 'paused') && <Button size="icon" variant="ghost" className="size-6 text-destructive" title="停止 Goal" onClick={() => invoke('stop')}><Square className="size-3" /></Button>}
    </div>
  )
}
