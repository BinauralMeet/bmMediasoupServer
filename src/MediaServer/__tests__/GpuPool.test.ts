import {describe, it, expect} from 'vitest'
import http from 'http'
import {groupIntoRungs, orderPool, GpuLockReader, freeMembers} from '../GpuPool'

describe('groupIntoRungs', () => {
  it('keeps unpooled entries as rungs of their own, in order', () => {
    expect(groupIntoRungs([undefined, undefined])).toEqual([[0], [1]])
  })
  it('gathers a pool into one rung where its first member appears', () => {
    expect(groupIntoRungs(['gpu', undefined, 'gpu', undefined])).toEqual([[0, 2], [1], [3]])
  })
  it('keeps different pools apart', () => {
    expect(groupIntoRungs(['a', 'b', 'a', 'b'])).toEqual([[0, 2], [1, 3]])
  })
})

describe('orderPool', () => {
  it('puts the member with fewer requests in flight first', () => {
    expect(orderPool([0, 1], [3, 1], 0)).toEqual([1, 0])
  })
  it('rotates among equally busy members', () => {
    expect(orderPool([4, 7], [0, 0, 0, 0, 0, 0, 0, 0], 0)).toEqual([4, 7])
    expect(orderPool([4, 7], [0, 0, 0, 0, 0, 0, 0, 0], 1)).toEqual([7, 4])
    expect(orderPool([4, 7], [0, 0, 0, 0, 0, 0, 0, 0], 2)).toEqual([4, 7])
  })
  it('copes with an empty rung', () => {
    expect(orderPool([], [], 5)).toEqual([])
  })
})

describe('GpuLockReader', () => {
  it('makes callers that arrive during a read wait for its answer, not the initial default', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits += 1
      //  Slow enough that the second caller certainly arrives while the first read runs.
      setTimeout(() => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({locked: true}))
      }, 50)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    try{
      const reader = new GpuLockReader(`http://127.0.0.1:${(server.address() as any).port}`, () => ({}))
      expect(await Promise.all([reader.locked(), reader.locked()])).toEqual([true, true])
      expect(hits).toBe(1)
    }finally{ server.close() }
  })

  it('counts an unreachable status endpoint as unlocked', async () => {
    const reader = new GpuLockReader('http://127.0.0.1:1', () => ({}))
    expect(await reader.locked()).toBe(false)
  })
})

describe('freeMembers', () => {
  const never = new Promise<boolean>(() => {})
  it('keeps the members whose check said yes, in member order', async () => {
    expect(await freeMembers([3, 5, 7], [Promise.resolve(true), Promise.resolve(false),
      Promise.reject(new Error('down'))])).toEqual([3])
    expect(await freeMembers([3, 5], [Promise.resolve(true), Promise.resolve(true)])).toEqual([3, 5])
  })
  it('does not wait for a member that never answers once another one is free', async () => {
    const started = Date.now()
    expect(await freeMembers([0, 1], [never, Promise.resolve(true)], 20)).toEqual([1])
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('still takes a member that answers within the grace period', async () => {
    const late = new Promise<boolean>(r => setTimeout(() => r(true), 5))
    expect(await freeMembers([0, 1], [late, Promise.resolve(true)], 200)).toEqual([0, 1])
  })
  it('answers at once with nobody free when every check has said no', async () => {
    expect(await freeMembers([0, 1], [Promise.resolve(false), Promise.resolve(false)])).toEqual([])
    expect(await freeMembers([], [])).toEqual([])
  })
})
