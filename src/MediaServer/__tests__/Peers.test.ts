import {describe, it, expect} from 'vitest'
import {Peers} from '../Peers'

describe('Peers', () => {
  it('adds a peer with its first transport', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    expect(peers.get('p1')?.transports).toEqual(['t1'])
  })

  it('appends additional transports for the same peer', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    peers.addTransport('p1', 't2')
    expect(peers.get('p1')?.transports).toEqual(['t1', 't2'])
  })

  it('keeps separate transport lists per peer', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    peers.addTransport('p2', 't2')
    expect(peers.get('p1')?.transports).toEqual(['t1'])
    expect(peers.get('p2')?.transports).toEqual(['t2'])
  })

  it('removes a single transport but keeps the peer while others remain', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    peers.addTransport('p1', 't2')
    peers.removeTransport('p1', 't1')
    expect(peers.get('p1')?.transports).toEqual(['t2'])
  })

  //  Regression-relevant: this is exactly the bookkeeping deletePeer()/peerLeft rely on to know
  //  every transport for a departing peer has been accounted for -- see mainServer.ts's
  //  peer-timeout fix (terminate() vs close()) for the bug this guards against reaching.
  it('removes the peer entry entirely once its last transport is removed', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    peers.removeTransport('p1', 't1')
    expect(peers.has('p1')).toBe(false)
  })

  it('removeTransport on an unknown peer is a safe no-op', () => {
    const peers = new Peers()
    expect(() => peers.removeTransport('nope', 't1')).not.toThrow()
    expect(peers.has('nope')).toBe(false)
  })

  it('removeTransport for a transport id the peer does not have leaves its list unchanged', () => {
    const peers = new Peers()
    peers.addTransport('p1', 't1')
    peers.removeTransport('p1', 'not-t1')
    expect(peers.get('p1')?.transports).toEqual(['t1'])
  })
})
