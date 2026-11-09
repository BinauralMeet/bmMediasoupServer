import {EventEmitter} from 'events'
import websocket from 'ws'
import {describe, expect, it} from 'vitest'
import {MainLink} from '../mainLink'

class FakeSocket extends EventEmitter {
  readyState: number = websocket.CONNECTING
  terminated = false
  terminate(){ this.terminated = true; this.readyState = websocket.CLOSED }
}

function setup(){
  const sockets: FakeSocket[] = []
  const link = new MainLink(() => {
    const s = new FakeSocket()
    sockets.push(s)

    return s as unknown as websocket.WebSocket
  }, 15000, () => {})

  return {sockets, link}
}

describe('MainLink', () => {
  it('waits for a socket still connecting instead of opening a second one', () => {
    const {sockets, link} = setup()
    link.check(0)
    link.check(7500)
    link.check(15000)
    expect(sockets.length).toBe(1)
    expect(sockets[0].terminated).toBe(false)
  })

  it('gives up on a connection attempt after the timeout, then reconnects', () => {
    const {sockets, link} = setup()
    link.check(0)
    link.check(15001)
    expect(sockets[0].terminated).toBe(true)
    link.check(22500)
    expect(sockets.length).toBe(2)
    expect(link.ws).toBe(sockets[1])
  })

  it('terminates an open socket without pings and reconnects once', () => {
    const {sockets, link} = setup()
    link.check(0)
    sockets[0].readyState = websocket.OPEN
    link.check(7500)
    expect(sockets[0].terminated).toBe(false)
    link.check(15001)                         //  no ping since the start: ping timeout
    expect(sockets[0].terminated).toBe(true)
    link.check(22500)
    link.check(30000)                         //  the new one is still connecting
    expect(sockets.length).toBe(2)
  })

  it('does not time out a new socket on the stale ping time of the old one', () => {
    const {sockets, link} = setup()
    link.check(0)
    sockets[0].readyState = websocket.OPEN
    link.check(15001)
    link.check(22500)
    sockets[1].readyState = websocket.OPEN
    link.check(30000)
    expect(sockets[1].terminated).toBe(false)
  })

  it('keeps an open socket that main pings', () => {
    const {sockets, link} = setup()
    link.check(Date.now())
    sockets[0].readyState = websocket.OPEN
    sockets[0].emit('ping')
    link.check(Date.now() + 10000)
    expect(sockets[0].terminated).toBe(false)
  })
})
