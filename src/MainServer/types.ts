import websocket from 'ws'
import { mainServer } from './mainServer'
import { consoleDebug, consoleLog } from './utils'
import { MSRemotePeer } from '../MediaServer/MediaMessages'

export interface PingPong {
  ws: websocket.WebSocket
  interval?: NodeJS.Timeout
  pongWait: number
}

export interface MedServer extends PingPong{
  id: string
  stat:{
    load: number
  }
}
export function deleteWorker(worker: MedServer){
  mainServer.workers.delete(worker.id)
  //  Its transports went with it.
  const lost = new Set<string>()
  for (const [transport, w] of mainServer.transportWorkers){
    if (w === worker){
      mainServer.transportWorkers.delete(transport)
      lost.add(transport)
    }
  }
  //  Everyone whose media ran through it has to start over: peer.worker would otherwise keep
  //  pointing at the dead worker, its requests silently dropped, and receive transports on it
  //  stay failed. Dropping the RTC socket makes the client reconnect from scratch (and the
  //  resulting leave_error cleans the peer up here).
  for (const peer of mainServer.peers.values()){
    if (peer.worker === worker || peer.transports.some(t => lost.has(t))){
      consoleLog(`worker ${worker.id} gone: disconnecting ${peer.peer} so that it reconnects.`)
      peer.ws.terminate()
    }
  }
}
export function getVacantWorker(){
  if (mainServer.workers.size){
    const worker = Array.from(mainServer.workers.values()).reduce((prev, cur)=> prev.stat.load < cur.stat.load ? prev : cur)
    consoleDebug(`worker ${worker.id} with load ${worker.stat.load} is selected.`)
    return worker
  }
  return undefined
}

export interface Peer extends MSRemotePeer{
  ws: websocket.WebSocket
  isAdmin: boolean
  lastReceived: number
  lastSent: number
  interval?: NodeJS.Timeout
  room?: Room
  worker?: MedServer
  transports:string[]
}

export function toMSRemotePeer(peer: Peer):MSRemotePeer{
  const {ws, lastReceived, lastSent, interval, room, worker, ...ms} = peer
  return ms
}

export interface Admin{
  email: string
  token: string
}
export interface Room{
  id: string;
  roomName: string;
  peers: Set<Peer>;
}
