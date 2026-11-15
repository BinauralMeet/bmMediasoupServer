import {describe, it, expect, vi, beforeAll, afterEach} from 'vitest'
import {mainServer} from '../mainServer'
import {initHandlers} from '../handlers'
import {MedServer, Peer} from '../types'

//  utils captures console.error at load, so a spy on console.error would not see these calls.
const {consoleError} = vi.hoisted(() => ({consoleError: vi.fn()}))
vi.mock('../utils', async (importOriginal) => ({...(await importOriginal<object>()), consoleError}))

function worker(id: string): MedServer{ return {id, ws: {send: vi.fn()} as any, pongWait: 0, stat: {load: 0}} }
function peer(id: string, w?: MedServer): Peer{
  return {peer: id, ws: {send: vi.fn()} as any, isAdmin: false, lastReceived: 0, lastSent: 0,
    producers: [], transports: [], worker: w}
}

describe('consumeTransport relay', () => {
  beforeAll(() => { initHandlers() })
  afterEach(() => {
    mainServer.peers.clear()
    mainServer.workers.clear()
    mainServer.transportWorkers.clear()
    vi.restoreAllMocks()
    consoleError.mockClear()
  })

  //  A consume of a producer that has just closed fails on the media; the requester must get that
  //  failure (same sn, with error) at once, not wait for its reply timeout.
  it('passes the media\'s error reply for a closed producer back to the requester', () => {
    const media = worker('media1')
    const a = peer('a', media)
    const b = peer('b', media)
    mainServer.peers.set('a', a)
    mainServer.peers.set('b', b)
    mainServer.transportWorkers.set('ta-recv-b', media)

    mainServer.handlersForPeer.get('consumeTransport')!({type: 'consumeTransport', peer: 'a', remote: 'b',
      transport: 'ta-recv-b', producer: 'gone', rtpCapabilities: {}, sn: 7} as any, a)
    expect(media.ws.send).toHaveBeenCalledTimes(1)
    const toMedia = JSON.parse((media.ws.send as any).mock.calls[0][0])
    expect(toMedia).toMatchObject({type: 'consumeTransport', peer: 'a', transport: 'ta-recv-b', sn: 7})

    //  what media.ts's consumeTransport .catch sends back: the request minus rtpCapabilities, plus error
    const {rtpCapabilities, ...reply} = toMedia
    mainServer.handlersForWorker.get('consumeTransport')!({...reply, error: 'consume for gone failed'}, media)
    expect(a.ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse((a.ws.send as any).mock.calls[0][0])).toMatchObject(
      {type: 'consumeTransport', peer: 'a', sn: 7, error: 'consume for gone failed'})
  })

  it('drops a request about a remote that has already left with one warning, no error', () => {
    const a = peer('a', worker('media1'))
    mainServer.peers.set('a', a)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mainServer.handlersForPeer.get('closeConsumer')!({type: 'closeConsumer', peer: 'a', remote: 'left',
      consumer: 'c1'} as any, a)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })
})
