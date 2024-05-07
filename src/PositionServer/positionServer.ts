import {MSPositionMessage} from '../MediaServer/MediaMessages'
import websocket from 'ws'
import { sendMSMessage } from '../MainServer/mainServer'


export function addPositionListener(ws: websocket.WebSocket, peer: string){
  console.log(`addPositionListener called by ${peer}`)
  ws.addEventListener('message', (ev: websocket.MessageEvent) => {
  })
  ws.addEventListener('close', (ev)=>{
  })
  let time = 0
  setInterval(()=>{
    time += 0.5
    const msg: MSPositionMessage = {
      type: 'position',
      position: [200*Math.cos(time), 200*Math.sin(time)],
      orientation: Math.floor(time*100) % 360 - 180
    }
    sendMSMessage(msg, ws)
  }, 500)
}
