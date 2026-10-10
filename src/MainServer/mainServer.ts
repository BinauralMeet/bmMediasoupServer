import websocket from 'ws'
import {MSMessage, MSMessageType, MSPeerMessage, MSRemoteUpdateMessage, MSCloseTransportMessage,
  MSCloseProducerMessage, MSRemoteLeftMessage, MSConnectMessage,
  MSPeerLeftMessage} from '../MediaServer/MediaMessages'
import {googleServer} from "../GoogleServer/GoogleServer";
import {findRoomLoginInfo, loginInfo} from './mainLogin';
import {Peer, MedServer, Room, PingPong, deleteWorker, getVacantWorker, toMSRemotePeer} from './types';
import {CONSOLE_DEBUG, consoleDebug, consoleError, consoleLog } from './utils';
import {initHandlers} from './handlers';

const config = require('../../config');


/*
    main server only for signaling
      knows peers=endpoints, rooms, producers and consumers
      a peer can join to only one room.

    each media server has 1 worker and router i.e.
    media server 1 has producer1 and consumers
    media server 2 has producer2 and consumers
    see https://mediasoup.org/documentation/v3/mediasoup/design/#architecture
 */

const peers = new Map<string, Peer>()
const rooms = new Map<string, Room>()
const workers = new Map<string, MedServer>()
//  Which worker holds each transport. A peer's receive transports are created on the workers of
//  the remotes it receives from, not on its own worker, so closing one needs this -- by the time
//  it is closed the remote (and with it the routing by `remote`) may already be gone.
const transportWorkers = new Map<string, MedServer>()
export const handlersForPeer = new Map<MSMessageType, (base:MSMessage, peer: Peer)=>void>()
export const handlersForWorker = new Map<MSMessageType, (base:MSMessage, worker: MedServer)=>void>()
export const mainServer = {
  peers,
  rooms,
  workers,
  transportWorkers,
  handlersForPeer,
  handlersForWorker,
}
initHandlers()

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

export function sendToRoom<MSM extends MSMessage>(msg: MSM, room:Room){
  if (room?.peers){
    for(const peer of room.peers.values()){
      peer.ws.send(JSON.stringify(msg))
    }
  }
}
//  Sends closeTransport to the worker that actually holds the transport (see transportWorkers).
export function closeTransportOnWorker(peer: string, transport: string){
  const worker = transportWorkers.get(transport)
  transportWorkers.delete(transport)
  if (!worker){ return }
  const msg: MSCloseTransportMessage = {type: 'closeTransport', peer, transport}
  consoleDebug(`Send ${msg.type} for ${msg.transport} to ${worker.id}`)
  sendMSMessage(msg, worker.ws)
}

export function sendToWorker<MSM extends MSMessage>(msg: MSM, peer: Peer){
  peer.worker?.ws.send(JSON.stringify(msg))
}

export function getPeerAndWorker(id: string){
  const peer = peers.get(id)
  if (!peer) {
    consoleError(`Peer ${id} not found.`)
    return undefined
  }
  if (!peer.worker) peer.worker = getVacantWorker()
  return peer
}

export function getPeer(id: string):Peer|undefined{
  const peer = peers.get(id)
  if (!peer){
    consoleError(`peer ${id} not found.`)
    return undefined
  }
  return peer
}

export function deletePeer(peer: Peer){
  //  A peer that reconnected (peerJustBefore) is replaced by a new Peer under the same id. The old
  //  socket's close arrives seconds later as 'leave_error'; acting on it by id would tear down the
  //  new peer -- remoteLeft to the room, peerLeft to every media, removal from `peers` -- and leave
  //  the reconnected user stuck on "Peer not found" until they reload (seen 2026-08-26, 09-27,
  //  10-02). The old peer was already cleaned up when it was replaced.
  if (peers.get(peer.peer) !== peer){
    consoleLog(`deletePeer: ${peer.peer} is a replaced connection, ignored.`)

    return
  }
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

  peer.transports.forEach(transport => closeTransportOnWorker(peer.peer, transport))
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

export function remoteUpdated(ps: Peer[], room: Room){
  if (!ps.length) return
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: ps.map(p=>toMSRemotePeer(p))
  }
  sendToRoom(remoteUpdateMsg, room)
}
function remoteLeft(ps: string[], room:Room){
  if (!ps.length) return
  const remoteLeftMsg:MSRemoteLeftMessage = {
    type:'remoteLeft',
    remotes: ps
  }
  sendToRoom(remoteLeftMsg, room)
  //  Every worker, not just the peer's own: a peer's receive transports live on the workers of the
  //  remotes it receives from (relayPeerToWorker routes createTransport by `remote`), and each
  //  worker files them under this peer. Told only its own worker, the others kept those
  //  transports -- and their UDP/TCP ports -- until they restarted ('closetransport: ... not
  //  found' on every leave was the visible half of this). A worker that has nothing for the peer
  //  ignores the message.
  ps.forEach(p => {
    if (!peers.get(p)){ return }
    const peerLeftMsg:MSPeerLeftMessage = {
      type: 'peerLeft',
      peer: p
    }
    for (const worker of workers.values()){
      worker.ws.send(JSON.stringify(peerLeftMsg))
    }
  })
}



//-------------------------------------------------------
//  message queue and process messages
//
interface MessageAndWorker {msg: MSMessage, worker: MedServer}
const workerQueue = new Array<MessageAndWorker>
export function processWorker():boolean{
  const top = workerQueue.shift()
  if (top){ //  woker
    const handler = mainServer.handlersForWorker.get(top.msg.type)
    if (handler){
      handler(top.msg, top.worker)
    }else{
      console.warn(`Unhandle worker message ${top.msg.type} received from ${top.worker.id}`)
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
export function addConnectListener(ws: websocket){
  ws.addEventListener('message', onConnectMessage)
  function onConnectMessage(messageData: websocket.MessageEvent){
    const msg = JSON.parse(messageData.data.toString()) as MSConnectMessage
    consoleDebug(`Connect handler msg:${msg.type} from ${msg.peer}`)
    if (msg.type === 'pong'){
      //  do nothing
    }else if (msg.type === 'connect'){
      consoleDebug(`Connect: ${JSON.stringify(msg)}`)
      if(msg.email && msg.token){ //  Oauth2 if required by client
        googleServer.authorizeRoom(msg.room, msg.token, msg.email, loginInfo).then((role) => {
          consoleDebug(`Connect auth: ${role}`)
          if (!role){
            error()
          }else{
            msg.role = role
            createPeer(role)
          }
        }).catch((reason)=>{
          error()
        })
      }else{
        const loginRoom = findRoomLoginInfo(msg.room)
        if (!loginRoom?.emailSuffixes?.length){
          createPeer()
        }else{
          error()
        }
      }
      function error(){
        msg.error = 'auth error'
        sendMSMessage(msg, ws)
      }
      function createPeer(role?: string){
        let unique = ''
        let justBefore:Peer|undefined

        if (msg.peerJustBefore && (justBefore = mainServer.peers.get(msg.peerJustBefore))) {
          deletePeer(justBefore)
          //  Stop the old connection outright: its timeout timer would otherwise keep running, and
          //  close() waits for a handshake the dead client may never answer.
          if (justBefore.interval){
            clearInterval(justBefore.interval)
            justBefore.interval = undefined
          }
          justBefore.ws.terminate()
          consoleLog(`New connection removes ${justBefore.peer} from room ${justBefore.room?.id}` +
            `${justBefore.room ? JSON.stringify(Array.from(justBefore.room.peers.keys()).map(p=>p.peer)):'[]'}`)
          unique = makeUniqueId(justBefore.peer, mainServer.peers)
        } else {
          unique = makeUniqueId(msg.peer, mainServer.peers)
        }
        msg.peer = unique
        //  create peer
        const now = Date.now()
        const peer:Peer = {
          peer:unique, ws, producers:[], transports:[], lastSent:now, lastReceived:now,
          isAdmin:role==='admin'
        }
        mainServer.peers.set(unique, peer)
        ws.removeEventListener('message', onConnectMessage)
        addPeerListener(peer)
        consoleDebug(`${unique} connected: ${JSON.stringify(Array.from(mainServer.peers.keys()))}`)

        sendMSMessage(msg, ws)
      }
    }else{
      console.warn(`Peer message ${msg.type} received instead of 'connect'. ${JSON.stringify(msg)}`)
    }
  }
}


export const PEER_TIMEOUT = config.websocketTimeout

//  exported for testing -- see MainServer/__tests__/mainServer.test.ts, which guards against
//  reintroducing the close()-vs-terminate() peer-timeout bug (see the comment at the call site).
export function addPeerListener(peer: Peer){
  //console.log(`addPeerListener ${peer.peer} called.`)
  //  The browser answers WebSocket pings itself, even in a background tab whose timers Chrome
  //  throttles to once a minute -- too slow for the client's own 'pong' to beat PEER_TIMEOUT, which
  //  is what made returning to a backgrounded tab show an RTC connection error and reconnect.
  peer.ws.on('pong', () => { peer.lastReceived = Date.now() })
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
      //  terminate(), not close(): close() starts a graceful closing handshake that waits for
      //  the peer to acknowledge -- but a peer we just detected as unresponsive (that's the
      //  whole reason we're here) may never send that acknowledgement, so the 'close' event
      //  this depends on to fire deletePeer() (via 'leave_error') could be delayed indefinitely
      //  or never fire at all, leaking this peer's transports/producers/consumers in media.ts
      //  forever. terminate() destroys the underlying socket immediately, unconditionally.
      //  Same reasoning already applied to the worker ping/pong timeout below and to media.ts's
      //  own reconnect-to-main timeout -- this was the one inconsistent spot.
      peer.ws.terminate()
    }
    if (peer.ws.readyState === peer.ws.OPEN){ peer.ws.ping() }
    //  send pong packet when no packet sent to peer for long time.
    if (now-peer.lastSent > PEER_TIMEOUT/4){
      const msg:MSMessage = {
        type:'pong'
      }
      peer.lastSent = now
      sendMSMessage(msg, peer.ws)
    }
  }, PEER_TIMEOUT/4)

  peer.ws.addEventListener('close', (ev) =>{
    if (peer.interval){
      clearInterval(peer.interval)
      peer.interval = undefined
    }
    const mp:MessageAndPeer={
      msg:{type:'leave_error'},
      peer
    }
    Object.assign(mp.msg, {code: ev.code, reason: ev.reason})
    peerQueue.push(mp)
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
      const id = (pingPong as MedServer).id
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
export function addWorkerListener(worker: MedServer){
  addPingPongListner(worker)
  worker.ws.addEventListener('close', () =>{
    consoleDebug(`WS for worker ${worker.id} closed.`)
    deleteWorker(worker)
  })
  worker.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    workerQueue.push({msg, worker})
  })
}

//--------------------------------------------------
//  utilities
export function makeUniqueId(id:string, map: Map<string, any>){
  if (!map.has(id)){
    return id
  }
  for(var i=1;; ++i){
    const unique = `${id}${i}`
    if (!map.has(unique)){
      return unique
    }
  }
}


var messageNumber = 0
function setMessageSerialNumber(msg: MSMessage){
  messageNumber++;
  if (msg.sn !== undefined){
    console.log(`setMessageSerialNumber error: msg ${msg.type} already have sn`, msg)
  }
  msg.sn = messageNumber
}

interface PromisePack {
  worker: MedServer,
  resolve: (worker:MedServer, base:MSMessage, a:any)=>void,
  reject?: (reson:any)=>void,
  arg: any
}
const promises = new Map<number, PromisePack>()
function setMessagePromise(worker:MedServer, msg:MSMessage, resolve:(worker:MedServer, base:MSMessage, a:any)=>void, reject?:(reson:any)=>void, arg?:any){
  setMessageSerialNumber(msg)
  promises.set(msg.sn!, {worker, resolve, reject, arg})
}
export function sendWithPromise(worker: MedServer, msg:MSMessage, resolve:(worker:MedServer, base:MSMessage, a:any)=>void, reject?:(reson:any)=>void, arg?:any){
  setMessagePromise(worker, msg, resolve, reject, arg)
  worker.ws.send(JSON.stringify(msg))
}
export function resolveMessage(m: MSMessage){
  const sn = m.sn
  delete m.sn
  if (sn){
    const p = promises.get(sn)
    if (p){
      p.resolve(p.worker, m, p.arg)
    }
    promises.delete(sn)
  }
}
