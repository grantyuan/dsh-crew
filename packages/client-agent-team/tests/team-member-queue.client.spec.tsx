// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One Task row as the Host projects it; queue entries embed it verbatim. */
function queueRow(taskRef: string, taskNumber: number, subject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskRef,
    threadRef: taskRef.replace('task:', 'thread:'),
    channelRef: 'channel:engineering',
    taskNumber,
    status: 'todo',
    resolution: 'open',
    subject,
    claimOwners: [],
    lastActivityAt: '2026-09-13T04:00:00.000Z',
    ...overrides,
  }
}

/** One private-queue entry as the Host's memberTasks projection returns it. */
function queueEntry(entryRef: string, task: Record<string, unknown>, standing: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entryRef,
    task,
    standing,
    addedBy: 'member:worker',
    addedAt: '2026-11-17T02:00:00.000Z',
    ...overrides,
  }
}

/** Open the queue dialog for builder through the Agents row menu. */
async function openQueueDialog(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<HTMLElement> {
  await b.view.findByText('builder')
  fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
  fireEvent.click(await within(document.body).findByRole('menuitem', { name: '任务队列' }))
  return b.view.findByRole('dialog', { name: '任务队列：builder' })
}

describe('Member task queue', () => {
  it('lists the private queue in order with standings, notes, and assignment provenance; a row click follows the Task', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      entries: [
        queueEntry('entry:9', queueRow('task:9', 9, '拆分出的第一步', { status: 'in_progress', claimOwners: [{ memberId: 'member:builder', name: 'builder' }] }), 'working'),
        queueEntry('entry:7', queueRow('task:7', 7, '叠放校验'), 'pending', { note: '先做这条' }),
      ],
    } }])
    const dialog = await openQueueDialog(b)
    expect(within(dialog).getByRole('heading', { name: '正在处理' })).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: '待开始' })).toBeTruthy()
    expect(within(dialog).getByText('进行中或待验收的任务不可改派、移除或重排。')).toBeTruthy()
    expect(within(dialog).getByText('先做这条')).toBeTruthy()
    expect(within(dialog).getAllByText('由 worker 安排').length).toBe(2)
    // The pending row opens its Task's Thread with the navigation snapshot.
    fireEvent.click(within(dialog).getByTitle('叠放校验 — 先做这条'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')).toMatchObject({
      mode: 'team', workspaceId: 'w1', channelRef: 'channel:engineering', threadRef: 'thread:7', taskRef: 'task:7',
    }))
    await b.runtime.dispose()
  })

  it('reassigns a pending entry through the real ledger mutation', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      entries: [queueEntry('entry:7', queueRow('task:7', 7, '叠放校验'), 'pending')],
    } }])
    const dialog = await openQueueDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Task #7 的队列操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '改派' }))
    const reassign = await b.view.findByRole('dialog', { name: '改派 Task #7' })
    expect(within(reassign).getByText('把 Task #7「叠放校验」从当前队列移出，追加到目标成员队列的末尾。仅未开始的任务可以改派。')).toBeTruthy()
    fireEvent.click(within(reassign).getByRole('button', { name: '改派给' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /worker/ }))
    fireEvent.click(within(reassign).getByRole('button', { name: '确认改派' }))
    await waitFor(() => expect(b.queueReassign).toHaveBeenCalledTimes(1))
    const request = (b.queueReassign.mock.calls[0] as unknown[])[0] as { requestId: string; workspaceId: string; entryRef: string; fromMemberId: string; toMemberId: string }
    expect(request).toMatchObject({ workspaceId: 'w1', entryRef: 'entry:7', fromMemberId: 'member:builder', toMemberId: 'member:worker' })
    expect(typeof request.requestId).toBe('string')
    expect(within(reassign).getByText('已改派。')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('removes and reorders pending entries through queueAmend, and never offers those actions on started entries', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      entries: [
        queueEntry('entry:9', queueRow('task:9', 9, '拆分出的第一步', { status: 'in_progress', claimOwners: [{ memberId: 'member:builder', name: 'builder' }] }), 'working'),
        queueEntry('entry:7', queueRow('task:7', 7, '叠放校验'), 'pending'),
        queueEntry('entry:8', queueRow('task:8', 8, '回归测试'), 'pending'),
      ],
    } }])
    const dialog = await openQueueDialog(b)
    // The working entry exposes no row menu; the pending ones do.
    expect(within(dialog).queryByRole('button', { name: 'Task #9 的队列操作' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Task #8 的队列操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '上移' }))
    await waitFor(() => expect(b.queueAmend).toHaveBeenCalledTimes(1))
    let request = (b.queueAmend.mock.calls[0] as unknown[])[0] as { requestId: string; workspaceId: string; memberId: string; action: string; order?: readonly string[]; entryRef?: string }
    expect(request).toMatchObject({ workspaceId: 'w1', memberId: 'member:builder', action: 'reorder' })
    // The reorder is the full queue order with the two pending entries swapped.
    expect(request.order).toEqual(['entry:9', 'entry:8', 'entry:7'])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Task #8 的队列操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '移除' }))
    await waitFor(() => expect(b.queueAmend).toHaveBeenCalledTimes(2))
    request = (b.queueAmend.mock.calls[1] as unknown[])[0] as typeof request
    expect(request).toMatchObject({ workspaceId: 'w1', memberId: 'member:builder', action: 'remove', entryRef: 'entry:8' })
    await b.runtime.dispose()
  })

  it('appends an unqueued open task to the queue tail with an optional note', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: {
      memberId: 'member:builder',
      entries: [queueEntry('entry:7', queueRow('task:7', 7, '叠放校验'), 'pending')],
    } }])
    b.seedTasks([
      { workspaceId: 'w1', row: queueRow('task:7', 7, '叠放校验') },
      { workspaceId: 'w1', row: queueRow('task:12', 12, '补齐回归用例') },
    ])
    const dialog = await openQueueDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '追加任务' }))
    const append = await b.view.findByRole('dialog', { name: '追加任务到 builder 的队列' })
    fireEvent.click(within(append).getByRole('button', { name: '选择任务' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /Task #12/ }))
    fireEvent.change(within(append).getByPlaceholderText('补充说明，例如执行顺序或验收要点'), { target: { value: '排在当前项之后' } })
    fireEvent.click(within(append).getByRole('button', { name: '追加' }))
    await waitFor(() => expect(b.queueAssign).toHaveBeenCalledTimes(1))
    const request = (b.queueAssign.mock.calls[0] as unknown[])[0] as { requestId: string; workspaceId: string; memberId: string; items: ReadonlyArray<{ taskRef: string; note?: string }> }
    expect(request).toMatchObject({ workspaceId: 'w1', memberId: 'member:builder', items: [{ taskRef: 'task:12', note: '排在当前项之后' }] })
    expect(within(append).getByText('已追加到队尾。')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('mints a task card from freeform requirement text and queues it atomically', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    b.seedMemberTasks([{ queue: { memberId: 'member:builder', entries: [] } }])
    b.seedChannel({ channelRef: 'channel:engineering', workspaceId: 'w1', name: 'engineering', state: 'active', createdAtSequence: 2 })
    await b.joinChannel({ requestId: 'request:join-builder', channelRef: 'channel:engineering', memberId: 'member:builder' })
    const dialog = await openQueueDialog(b)
    fireEvent.click(within(dialog).getByRole('button', { name: '追加任务' }))
    const append = await b.view.findByRole('dialog', { name: '追加任务到 builder 的队列' })
    fireEvent.click(within(append).getByRole('button', { name: '直接描述需求' }))
    expect(within(append).getByText(/原子地把它建为任务卡并入队/)).toBeTruthy()
    fireEvent.change(within(append).getByPlaceholderText('一段需求、一个研究目标、一个要查证的问题…'), { target: { value: '调研竞品定价' } })
    fireEvent.click(within(append).getByRole('button', { name: '建卡并入队' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenCalledTimes(1))
    const sent = (b.sendMessage.mock.calls[0] as unknown[])[0] as { requestId: string; workspaceId: string; channelRef: string; body: string; asTask: boolean }
    expect(sent).toMatchObject({ workspaceId: 'w1', channelRef: 'channel:engineering', body: '调研竞品定价', asTask: true })
    await waitFor(() => expect(b.queueAssign).toHaveBeenCalledTimes(1))
    const assigned = (b.queueAssign.mock.calls[0] as unknown[])[0] as { workspaceId: string; memberId: string; items: ReadonlyArray<{ taskRef: string }> }
    expect(assigned).toMatchObject({ workspaceId: 'w1', memberId: 'member:builder', items: [{ taskRef: 'task:1' }] })
    expect(within(append).getByText('已建卡并入队。')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('renders the empty queue and the load failure', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedMemberTasks([{ queue: { memberId: 'member:builder', entries: [] } }])
    const dialog = await openQueueDialog(b)
    expect(within(dialog).getByText('队列为空——负责人或你可以在看板上安排任务。')).toBeTruthy()
    await b.runtime.dispose()

    const failing = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    failing.memberTasks.mockRejectedValueOnce(new Error('gateway gone'))
    await failing.view.findByText('builder')
    fireEvent.click(failing.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '任务队列' }))
    const failed = await failing.view.findByRole('dialog', { name: '任务队列：builder' })
    await waitFor(() => expect(within(failed).getByText('读取任务队列失败：gateway gone')).toBeTruthy())
    await failing.runtime.dispose()
  })
})
