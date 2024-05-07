import websocket from 'ws'
import { mainServer } from './mainServer'
import { consoleDebug, consoleLog } from './utils'
import { MSRemotePeer } from '../MediaServer/MediaMessages'

export interface PingPong {
  ws: websocket.WebSocket
  interval?: NodeJS.Timeout
  pongWait: number
}

export interface Worker extends PingPong{
  id: string
  stat:{
    load: number
  }
}
export function deleteWorker(worker: Worker){
  mainServer.workers.delete(worker.id)
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
  worker?: Worker
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
