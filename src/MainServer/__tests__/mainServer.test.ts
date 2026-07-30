import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {addPeerListener, PEER_TIMEOUT} from '../mainServer'
import {Peer} from '../types'

function makeMockWs() {
  const listeners = new Map<string, (ev: any) => void>()
  return {
    addEventListener: vi.fn((event: string, cb: (ev: any) => void) => { listeners.set(event, cb) }),
    close: vi.fn(),
    terminate: vi.fn(),
    OPEN: 1,
    readyState: 1,
    trigger: (event: string, ev: any = {}) => listeners.get(event)?.(ev),
  }
}

function makePeer(ws: ReturnType<typeof makeMockWs>): Peer {
  const now = Date.now()
  return {
    peer: 'p1', ws: ws as any, isAdmin: false, lastReceived: now, lastSent: now, transports: [],
    producers: [],
  }
}

describe('addPeerListener', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  //  Regression test: a peer we've detected as unresponsive (no message received within
  //  PEER_TIMEOUT) must be disconnected with terminate(), not close(). close() starts a graceful
  //  handshake that waits for the peer's acknowledgement -- which an unresponsive peer, by
  //  definition, may never send, so the 'close' event that drives cleanup (deletePeer(), and in
  //  turn the closeTransport messages that free the peer's resources in media.ts) could be
  //  delayed indefinitely or never fire, leaking that peer's transports/producers/consumers
  //  forever. This was the root cause of transports piling up in media.ts over long-running
  //  sessions whenever a client's network dropped without a clean disconnect.
  it('terminates (not closes) a peer whose connection has gone silent past PEER_TIMEOUT', () => {
    const ws = makeMockWs()
    const peer = makePeer(ws)
    peer.lastReceived = Date.now() - PEER_TIMEOUT - 1

    addPeerListener(peer)
    vi.advanceTimersByTime(PEER_TIMEOUT / 4)

    expect(ws.terminate).toHaveBeenCalledTimes(1)
    expect(ws.close).not.toHaveBeenCalled()

    clearInterval(peer.interval)
  })

  it('does not disconnect a peer that has received a message within PEER_TIMEOUT', () => {
    const ws = makeMockWs()
    const peer = makePeer(ws)
    peer.lastReceived = Date.now()

    addPeerListener(peer)
    vi.advanceTimersByTime(PEER_TIMEOUT / 4)

    expect(ws.terminate).not.toHaveBeenCalled()
    expect(ws.close).not.toHaveBeenCalled()

    clearInterval(peer.interval)
  })

  it('updates lastReceived and queues an incoming message', () => {
    const ws = makeMockWs()
    const peer = makePeer(ws)
    const before = peer.lastReceived

    addPeerListener(peer)
    vi.advanceTimersByTime(5)
    ws.trigger('message', {data: JSON.stringify({type: 'pong', peer: 'p1'})})

    expect(peer.lastReceived).toBeGreaterThan(before)

    clearInterval(peer.interval)
  })
})
