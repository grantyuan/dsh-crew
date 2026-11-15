import { describe, expect, it } from 'vitest'
import { ContextRoleQueueError, ContextRoleScheduler } from '../src/context/role-scheduler.ts'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('context role scheduler', () => {
  it('admits three globally and one per key', async () => {
    const scheduler = new ContextRoleScheduler()
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    const runs = gates.map((gate, index) => scheduler.run({
      key: `member-${index}`,
      priority: 'background',
      task: () => {
        started.push(index)
        return gate.promise
      },
    }))
    await tick()
    expect(started).toEqual([0, 1, 2])
    gates[0]!.resolve()
    await runs[0]
    await tick()
    expect(started).toEqual([0, 1, 2, 3])
    gates[1]!.resolve()
    gates[2]!.resolve()
    gates[3]!.resolve()
    await Promise.all(runs.slice(1))

    const sameKey = deferred()
    const first = scheduler.run({ key: 'same', task: () => sameKey.promise })
    const second = scheduler.run({ key: 'same', task: () => Promise.resolve() })
    await tick()
    sameKey.resolve()
    await Promise.all([first, second])
    scheduler.dispose()
  })

  it('rejects when the queue is full', async () => {
    const scheduler = new ContextRoleScheduler()
    const gates = Array.from({ length: 11 }, () => deferred())
    const runs = gates.map((gate, index) => scheduler.run({ key: `k-${index}`, task: () => gate.promise }))
    await tick()
    await expect(scheduler.run({ key: 'overflow', task: () => Promise.resolve() }))
      .rejects.toBeInstanceOf(ContextRoleQueueError)
    for (const gate of gates) gate.resolve()
    await Promise.all(runs)
    scheduler.dispose()
  })

  it('admits interactive jobs before background jobs', async () => {
    const scheduler = new ContextRoleScheduler()
    const gates = [deferred(), deferred(), deferred()]
    const runs = gates.map((gate, index) => scheduler.run({
      key: `active-${index}`,
      task: () => gate.promise,
    }))
    await tick()
    const order: string[] = []
    const backgroundGate = deferred()
    const interactiveGate = deferred()
    const background = scheduler.run({
      key: 'queued-bg',
      priority: 'background',
      task: () => {
        order.push('background')
        return backgroundGate.promise
      },
    })
    const interactive = scheduler.run({
      key: 'queued-interactive',
      priority: 'interactive',
      task: () => {
        order.push('interactive')
        return interactiveGate.promise
      },
    })
    gates[0]!.resolve()
    await tick()
    expect(order).toEqual(['interactive'])
    gates[1]!.resolve()
    gates[2]!.resolve()
    await tick()
    expect(order).toEqual(['interactive', 'background'])
    backgroundGate.resolve()
    interactiveGate.resolve()
    await Promise.all([background, interactive, ...runs])
    scheduler.dispose()
  })

  it('cancels queued work and aborts in-flight work on dispose', async () => {
    const scheduler = new ContextRoleScheduler()
    const aborted: string[] = []
    const runs = ['live-0', 'live-1', 'live-2'].map(key => scheduler.run({
      key,
      task: signal => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(key)
          reject(new Error('aborted'))
        }, { once: true })
      }),
    }).catch(() => undefined))
    await tick()
    const queued = scheduler.run({ key: 'queued', task: () => Promise.resolve() })
    scheduler.dispose()
    await expect(queued).rejects.toThrow('disposed')
    await Promise.all(runs)
    expect(aborted).toEqual(['live-0', 'live-1', 'live-2'])
  })
})
