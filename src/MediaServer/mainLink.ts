import websocket from 'ws'

//  Keeps one websocket from a media server to the main server. check() runs every timeout/2.
//  A socket still connecting is waited for (up to timeout), not replaced: replacing it left the
//  first socket connecting, and when it opened its 'workerAdd' went out on the newer, already
//  registered socket, which main then dropped as "Unhandle worker message workerAdd".
export class MainLink {
  ws?: websocket.WebSocket
  private lastAlive = 0   //  last ping from main, or when the current socket was started

  constructor(private connect: () => websocket.WebSocket, private timeout: number,
    private log: (s: string) => void = console.log){}

  check(now = Date.now()){
    const ws = this.ws
    if (ws && (ws.readyState === websocket.OPEN || ws.readyState === websocket.CONNECTING)){
      if (this.lastAlive + this.timeout < now){
        this.log(ws.readyState === websocket.OPEN ? 'Ping timeout. Terminate websocket.'
          : 'Connecting to main server timed out. Terminate websocket.')
        ws.terminate()
      }

      return
    }
    this.log('Try to connect to main server.')
    this.lastAlive = now
    const sock = this.connect()
    this.ws = sock
    sock.on('ping', () => { if (this.ws === sock){ this.lastAlive = Date.now() } })
  }
}
