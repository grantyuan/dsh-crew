// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
beforeEach(() => { localStorage.clear() })

/**
 * Focusing a Member swaps the main Session, and the shipped Sidebar holds one
 * layout per Session with fresh surfaces starting collapsed: the swap used to
 * collapse a column the Human holds open. The column itself must keep the
 * state the Human left it in — held open it carries the arriving Member's
 * conversation tabs, closed it stays closed — while only the content inside
 * follows the Member.
 */
describe('Member focus holds the right column', () => {
  afterEach(cleanup)

  async function benchWithBuilder() {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    return b
  }

  it('restores a held-open column the arriving Member surface collapses', async () => {
    const b = await benchWithBuilder()
    // The capture reads the held state; the post-commit read answers collapsed,
    // exactly what a fresh Member surface does in production.
    b.sidebarColumn.isExpanded.mockReturnValueOnce(true).mockReturnValue(false)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('session:member:builder') })
    await waitFor(() => { expect(b.sidebarColumn.toggleExpanded).toHaveBeenCalledTimes(1) })
    await b.runtime.dispose()
  })

  it('leaves a closed column closed', async () => {
    const b = await benchWithBuilder()
    b.sidebarColumn.isExpanded.mockReturnValue(false)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('session:member:builder') })
    // The restore frame must pass without a write: focusing a Member never
    // opens the column on its own.
    await new Promise(resolve => { setTimeout(resolve, 60) })
    expect(b.sidebarColumn.toggleExpanded).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('retries the restore past a seat that has not adopted its store yet', async () => {
    const b = await benchWithBuilder()
    b.sidebarColumn.isExpanded.mockReturnValueOnce(true).mockReturnValue(false)
    b.sidebarColumn.toggleExpanded.mockImplementationOnce(() => {
      throw new Error('sidebarRight: no session surface is mounted')
    })
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('session:member:builder') })
    await waitFor(() => { expect(b.sidebarColumn.toggleExpanded).toHaveBeenCalledTimes(2) })
    await b.runtime.dispose()
  })
})
