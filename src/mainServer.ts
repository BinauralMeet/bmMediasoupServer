import websocket from 'ws'
import {MSMessage, MSMessageType, MSCreateTransportReply, MSPeerMessage, MSAuthMessage,MSUploadFileMessage,
  MSProduceTransportReply, MSRemotePeer, MSRemoteUpdateMessage, MSRoomJoinMessage,
  MSCloseTransportMessage, MSCloseProducerMessage, MSRemoteLeftMessage, MSWorkerUpdateMessage} from './MediaServer/MediaMessages'
import {userLog, stamp} from './main'
const config = require('../config');
import { GoogleServer } from "./GoogleServer/GoogleServer";


const CONSOLE_DEBUG = false
const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.log
/*
    main server only for signaling
      knows peers=endpoints, rooms, producers and consumers
      a peer can join to only one room.

    each media server has 1 worker and router i.e.
    media server 1 has producer1 and consumers
    media server 2 has producer2 and consumers
    see https://mediasoup.org/documentation/v3/mediasoup/design/#architecture
 */
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
function deleteWorker(worker: Worker){
  workers.delete(worker.id)
}
function getVacantWorker(){
  if (workers.size){
    const worker = Array.from(workers.values()).reduce((prev, cur)=> prev.stat.load < cur.stat.load ? prev : cur)
    consoleLog(`worker ${worker.id} with load ${worker.stat.load} is selected.`)
    return worker
  }
  return undefined
}

export interface Peer extends MSRemotePeer{
  ws: websocket.WebSocket
  lastReceived: number
  lastSent: number
  interval?: NodeJS.Timeout
  room?: Room
  worker?: Worker
  transports:string[]
}
function toMSRemotePeer(peer: Peer):MSRemotePeer{
  const {ws, lastReceived, lastSent, interval, room, worker, ...ms} = peer
  return ms
}

interface Room{
  id: string;
  RoomName: string;
  RoomOwner: string;
  RoomPassword: string;
  requiredLogin: boolean;
  peers: Set<Peer>;
}

const peers = new Map<string, Peer>()
const rooms = new Map<string, Room>()
const workers = new Map<string, Worker>()


export function getRoomById(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function setRoom(roomId: string, room: Room): void {
  rooms.set(roomId, room);
}

function checkDeleteRoom(room?: Room){
  if (room && room.peers.size === 0){
    rooms.delete(room.id)
  }
}

export function sendMSMessage<MSM extends MSMessage>(msg: MSM, ws: websocket.WebSocket){
  ws.send(JSON.stringify(msg))
}

export function sendRoom<MSM extends MSMessage>(msg: MSM, room:Room){
  if (room?.peers){
    for(const peer of room.peers.values()){
      peer.ws.send(JSON.stringify(msg))
    }
  }
}

function getPeerAndWorker(id: string){
  const peer = peers.get(id)
  if (!peer) {
    consoleError(`Peer ${id} not found.`)
    return undefined
  }
  if (!peer.worker) peer.worker = getVacantWorker()
  return peer
}

function getPeer(id: string):Peer|undefined{
  const peer = peers.get(id)
  if (!peer){
    consoleError(`peer ${id} not found.`)
    return undefined
  }
  return peer
}

export function deletePeer(peer: Peer){
  //   delete from room
  peer.room?.peers.delete(peer)
  checkDeleteRoom(peer.room)

  //  delete from peers
  peer.producers.forEach(producer => {
    const msg: MSCloseProducerMessage= {
      type: 'closeProducer',
      peer: peer.peer,
      producer: producer.id,
    }
    if (peer.worker?.ws){
      sendMSMessage(msg, peer.worker.ws)
    }
  })
  peer.producers=[]

  peer.transports.forEach(transport => {
    const msg: MSCloseTransportMessage= {
      type: 'closeTransport',
      transport,
    }
    consoleDebug(`Send ${msg.type} for ${msg.transport}`)
    if (peer.worker?.ws){
      sendMSMessage(msg, peer.worker.ws)
    }
  })
  peer.transports=[]

  remoteLeft([peer.peer], peer.room!)
  peers.delete(peer.peer)
  if (CONSOLE_DEBUG){
    const peerList = Array.from(peers.keys()).reduce((prev, cur) => `${prev} ${cur}`, '')
    consoleDebug(`Peers: ${peerList}`)
  }

  if (peer.ws.readyState === peer.ws.OPEN || peer.ws.readyState === peer.ws.CONNECTING){
    peer.ws.close()
  }
}

function remoteUpdated(ps: Peer[], room: Room){
  if (!ps.length) return
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: ps.map(p=>toMSRemotePeer(p))
  }
  sendRoom(remoteUpdateMsg, room)
}
function remoteLeft(ps: string[], room:Room){
  if (!ps.length) return
  const remoteLeftMsg:MSRemoteLeftMessage = {
    type:'remoteLeft',
    remotes: ps
  }
  sendRoom(remoteLeftMsg, room)
}


//-------------------------------------------------------
//  handlers for worker
export const handlersForWorker = new Map<MSMessageType, (base:MSMessage, worker: Worker)=>void>()
handlersForWorker.set('workerDelete',(base, ws)=>{
  const msg = base as MSPeerMessage
  workers.delete(msg.peer)
})
handlersForWorker.set('workerUpdate',(base, ws)=>{
  const msg = base as MSWorkerUpdateMessage
  const worker = workers.get(msg.peer)
  if (worker){
    worker.stat.load = msg.load
  }
})



//-------------------------------------------------------
//  handlers for peer
export const handlersForPeer = new Map<MSMessageType, (base:MSMessage, peer: Peer)=>void>()

// --------------> This is where join to the Server
handlersForPeer.set('join',(base, peer)=>{
  const msg = base as MSPeerMessage;
  const join = base as MSRoomJoinMessage;
  let room = rooms.get(join.room);
  if (room?.peers) {
    room.peers.add(peer)
  }else{
    room = {
      id: join.room,
      RoomName: join.RoomName,
      RoomOwner: join.RoomOwner,
      RoomPassword: join.RoomPassword,
      requiredLogin: join.requiredLogin,
      peers: new Set<Peer>([peer]) // <--- The list of users in the Room
    }

    rooms.set(room.id, room);
    userLog.log(`${stamp()}: room ${join.room} created: ${JSON.stringify(Array.from(rooms.keys()))}`);
  }

  peer.room = room;
  userLog.log(`${stamp()}: ${peer.peer} joined to room '${join.room}' ${room.peers.size}`);

  //  Notify (reply) the room's remotes
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: Array.from(peer.room.peers).map(peer => toMSRemotePeer(peer))
  };
  peer.lastSent = Date.now()
  sendMSMessage(remoteUpdateMsg, peer.ws);
})
handlersForPeer.set('leave', (_base, peer)=>{
  userLog.log(`${stamp()}: ${peer.peer} left from room '${peer.room?.id}' ${peer.room?.peers.size?peer.room?.peers.size-1:'not exist'}`)
  deletePeer(peer)
  peer.ws.close()
})
handlersForPeer.set('leave_error', (base, peer)=>{
  if (peer.room?.peers.has(peer)){
    const msg = base as any
    console.warn(`Peer ${peer.peer} left by error. RTC websocket closed. code:${msg.code} reason:${msg.reason}`)
    mainServer.deletePeer(peer)
  }
})
handlersForPeer.set('pong', (_base)=>{})

// handle user upload image to google drive, return the file id
handlersForPeer.set('uploadFile', (base, peer)=>{
  const msg = base as MSUploadFileMessage
  const gt= new GoogleServer();
  gt.login().then((logined) => {
    gt.uploadFile(msg.file, msg.fileName).then((result) => {
      if (result == 'upload error'){
        msg.error = 'upload error'
        msg.fileID = ''
        sendMSMessage(msg ,peer.ws)
      }
      else{
        msg.fileID = result as string
        sendMSMessage(msg ,peer.ws)
      }
    })
  })
})

export const mainServer = {
  peers,
  rooms,
  workers,
  handlersForPeer,
  handlersForWorker,
  deletePeer,
  deleteWorker,
}

//-------------------------------------------------------
//  bridging(peer->worker / worker->peer) handlers
function relayPeerToWorker(base: MSMessage){
  const msg = base as MSPeerMessage
  const remoteOrPeer = getPeerAndWorker(msg.remote? msg.remote : msg.peer)
  if (remoteOrPeer?.worker){
    consoleDebug(`P=>W ${msg.type} from ${msg.peer} relayed to ${remoteOrPeer.worker.id}`)
    const {remote, ...msg_} = msg
    sendMSMessage(msg_, remoteOrPeer.worker.ws)
  }
}
function relayWorkerToPeer(base: MSMessage){
  const msg = base as MSPeerMessage
  const peer = peers.get(msg.peer)
  if (peer){
    consoleDebug(`W=>P ${msg.type} from ${peer.worker?.id} relayed to ${peer.peer}`)
    peer.lastSent = Date.now()
    sendMSMessage(msg, peer.ws)
  }
}
function setRelayHandlers(mt: MSMessageType){
  handlersForPeer.set(mt, relayPeerToWorker)
  handlersForWorker.set(mt, relayWorkerToPeer)
}

//-------------------------------------------------------
//  handlers for both
setRelayHandlers('rtpCapabilities')
handlersForPeer.set('createTransport', relayPeerToWorker)
handlersForWorker.set('createTransport', (base, worker)=>{
  const msg = base as MSCreateTransportReply
  const peer = getPeer(msg.peer)
  if (!peer){
    consoleError(`peer '${msg.peer}' not found.`)
    const cmsg: MSCloseTransportMessage= {
      type: 'closeTransport',
      transport: msg.transport,
    }
    if (worker?.ws){
      sendMSMessage(cmsg, worker.ws)
    }
    return
  }
  if (msg.transport){ peer.transports.push(msg.transport) }
  peer.lastSent = Date.now()
  sendMSMessage(base, peer.ws)
})

setRelayHandlers('connectTransport')

handlersForPeer.set('produceTransport', relayPeerToWorker)
handlersForWorker.set('produceTransport', (base, worker)=>{
  const msg = base as MSProduceTransportReply
  const peer = getPeer(msg.peer)
  if (!peer){
    consoleError(`peer '${msg.peer}' not found.`)
    if (msg.producer){
      const cmsg: MSCloseProducerMessage= {
        type: 'closeProducer',
        peer: msg.peer,
        producer: msg.producer,
      }
      if (worker?.ws){
        sendMSMessage(cmsg, worker.ws)
      }
    }
    return
  }
  if (msg.producer){
    if (peer.producers.find(p => p.role === msg.role && p.kind === msg.kind)){
      consoleError(`A producer for the same role "${msg.role}" and kind "${msg.kind}" already exists for peer "${peer.peer}".`)
    }else{
      consoleDebug(`new producer, role "${msg.role}" and kind "${msg.kind}" created for peer "${peer.peer}".`)
    }
    peer.producers.push({id:msg.producer, kind: msg.kind, role: msg.role})
  }
  peer.lastSent = Date.now()
  sendMSMessage(base, peer.ws)
  remoteUpdated([peer], peer.room!)
})
handlersForPeer.set('closeProducer', (base)=>{
  const msg = base as MSCloseProducerMessage
  const peer = peers.get(msg.peer)
  if (peer){
    peer.producers = peer.producers.filter(pr => pr.id !== msg.producer)
    consoleDebug(`Close producer ${msg.producer}` +
      `remains:[${peer.producers.map(rp => rp.id).reduce((prev, cur)=>`${prev} ${cur}`, '')}]`)
    remoteUpdated([peer], peer.room!)
  }
  relayPeerToWorker(base)
})
handlersForWorker.set('closeProducer', relayWorkerToPeer)

setRelayHandlers('consumeTransport')
setRelayHandlers('resumeConsumer')
setRelayHandlers('streamingStart')
setRelayHandlers('streamingStop')


//-------------------------------------------------------
//  message queue and process messages
//
interface MessageAndWorker {msg: MSMessage, worker: Worker}
const workerQueue = new Array<MessageAndWorker>
export function processWorker():boolean{
  const top = workerQueue.shift()
  if (top){ //  woker
    const handler = mainServer.handlersForWorker.get(top.msg.type)
    if (handler){
      handler(top.msg, top.worker)
    }else{
      console.warn(`Unhandle peer message ${top.msg.type} received from ${top.worker.id}`)
    }
    return true
  }
  return false
}

interface MessageAndPeer {msg: MSMessage, peer: Peer}
const peerQueue = new Array<MessageAndPeer>
export function processPeer(){
  const top = peerQueue.shift()
  if (top){ //  peer
    const handler = mainServer.handlersForPeer.get(top.msg.type)
    if (handler){
      handler(top.msg, top.peer)
    }else{
      console.warn(`Unhandle peer message ${top.msg.type} received from ${top.peer.peer}`)
    }
    return true
  }
  return false
}

//--------------------------------------------------
//  Functions to add listners to websocket
//
const PEER_TIMEOUT = config.websocketTimeout

export function addPeerListener(peer: Peer){
  //console.log(`addPeerListener ${peer.peer} called.`)
  peer.ws.addEventListener('close', (ev) =>{
    const mp:MessageAndPeer={
      msg:{type:'leave_error'},
      peer
    }
    Object.assign(mp.msg, {code: ev.code, reason: ev.reason})
    peerQueue.push(mp)
  })
  peer.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    peer.lastReceived = Date.now()
    consoleDebug(`Msg ${msg.type} from ${msg.peer}`)
    peerQueue.push({msg, peer})
  })
  if (peer.interval) console.error(`addPeerListner for peer ${peer.peer} called again.`)
  peer.interval = setInterval(()=>{
    const now = Date.now()
    //  check last receive time
    if (now-peer.lastReceived > PEER_TIMEOUT){
      console.warn(`Websocket for peer ${peer.peer} has been timed out.`)
      peer.ws.close()
    }
    //  send pong packet when no packet sent to peer for long time.
    if (now-peer.lastSent > PEER_TIMEOUT/4){
      const msg:MSMessage = {
        type:'pong'
      }
      peer.lastSent = now
      sendMSMessage(msg, peer.ws)
    }
  }, PEER_TIMEOUT/4)

  peer.ws.addEventListener('close', ()=>{
    if (peer.interval){
      clearInterval(peer.interval)
      peer.interval = undefined
    }
  })
}

const PING_INTERVAL = config.workerWebsocketTimeout / 3
function addPingPongListner(pingPong: PingPong){
  pingPong.ws.on('ping', () =>{ pingPong.ws.pong() })
  pingPong.ws.on('pong', (ev) =>{
    pingPong.pongWait = 0
    consoleDebug(`pong ${pingPong.pongWait}`)
  })
  pingPong.interval = setInterval(()=>{
    if (pingPong.pongWait >= 3){
      const id = (pingPong as Worker).id
      console.warn(`WS for worker '${id}' timed out. pong wait count = ${pingPong.pongWait}.`)
      pingPong.ws.terminate()
      clearInterval(pingPong.interval)
      return
    }
    pingPong.ws.ping()
    consoleDebug('ping sent')
    pingPong.pongWait ++
  }, PING_INTERVAL)
  pingPong.ws.addEventListener('close', ()=>{
    if (pingPong.interval){
      clearInterval(pingPong.interval)
      pingPong.interval = undefined
    }
  })
}
export function addWorkerListener(worker: Worker){
  addPingPongListner(worker)
  worker.ws.addEventListener('close', () =>{
    consoleDebug(`WS for worker ${worker.id} closed.`)
    mainServer.deleteWorker(worker)
  })
  worker.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    workerQueue.push({msg, worker})
  })
}
