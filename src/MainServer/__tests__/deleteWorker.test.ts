import {describe, it, expect, vi} from 'vitest'
import {mainServer} from '../mainServer'
import {deleteWorker, MedServer, Peer} from '../types'

function worker(id: string): MedServer{ return {id, ws: {} as any, pongWait: 0, stat: {load: 0}} }
function peer(id: string, w?: MedServer, transports: string[] = []): Peer{
  return {peer: id, ws: {terminate: vi.fn()} as any, isAdmin: false, lastReceived: 0, lastSent: 0,
    producers: [], transports, worker: w}
}

describe('deleteWorker', () => {
  it('disconnects the peers whose media ran through the lost worker, and only those', () => {
    const gone = worker('m1')
    const alive = worker('m2')
    const onGone = peer('a', gone, ['ta'])
    const receivesFromGone = peer('b', alive, ['tb1', 'tb2'])
    const unaffected = peer('c', alive, ['tc'])
    for (const p of [onGone, receivesFromGone, unaffected]){ mainServer.peers.set(p.peer, p) }
    mainServer.workers.set(gone.id, gone)
    mainServer.workers.set(alive.id, alive)
    mainServer.transportWorkers.set('ta', gone)
    mainServer.transportWorkers.set('tb1', alive)
    mainServer.transportWorkers.set('tb2', gone)    //  b's receive transport for a's tracks
    mainServer.transportWorkers.set('tc', alive)
    try{
      deleteWorker(gone)
      expect(onGone.ws.terminate).toHaveBeenCalled()
      expect(receivesFromGone.ws.terminate).toHaveBeenCalled()
      expect(unaffected.ws.terminate).not.toHaveBeenCalled()
      expect(mainServer.transportWorkers.has('tb2')).toBe(false)
      expect(mainServer.transportWorkers.get('tc')).toBe(alive)
    }finally{
      mainServer.peers.clear()
      mainServer.workers.clear()
      mainServer.transportWorkers.clear()
    }
  })
})
