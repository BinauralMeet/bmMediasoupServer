import {describe, expect, it} from 'vitest'
import {kickMessageLoop, setMessageProcessor, takeMessageLoad} from '../messageLoop'

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

describe('messageLoop', () => {
  it('handles a queued message on the next turn, without waiting for a tick', async () => {
    const queue = ['a', 'b', 'c']
    const handled: string[] = []
    setMessageProcessor(() => {
      const m = queue.shift()
      if (m === undefined){ return false }
      handled.push(m)

      return true
    })
    kickMessageLoop()
    kickMessageLoop()   //  a second kick before the run does not run twice
    expect(handled).toEqual([])
    await nextTurn()
    expect(handled).toEqual(['a', 'b', 'c'])
  })

  it('yields after its budget and continues on a later turn', async () => {
    let left = 3
    let calls = 0
    setMessageProcessor(() => {
      if (!left){ return false }
      left -= 1
      calls += 1
      const until = Date.now() + 30
      while (Date.now() < until){ /* a heavy handler */ }

      return true
    })
    kickMessageLoop()
    await nextTurn()
    expect(calls).toBe(2)     //  50ms budget: two 30ms handlers, then yield
    await nextTurn()
    expect(calls).toBe(3)
    expect(takeMessageLoad()).toBeGreaterThan(0)
  })
})
