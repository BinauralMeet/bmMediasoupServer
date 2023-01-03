import websocket from 'ws'
import https from 'https'
import fs from 'fs'
import debugModule from 'debug'
import {MSMessage, MSMessageType, MSRoomMessage, MSCreateTransportReply, MSPeerMessage,
  MSConnectMessage, MSProduceTransportReply, MSRemotePeer, MSRemoteUpdateMessage,
  MSCloseTransportMessage, MSCloseProducerMessage, MSRemoteLeftMessage, MSWorkerUpdateMessage} from './MediaMessages'
import { exit } from 'process'

const log = debugModule('bmMsM');
const warn = debugModule('bmMsM:WARN');
const err = debugModule('bmMsM:ERROR');
const config = require('../config');

const CONSOLE_DEBUG = false
const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.log

/*
    main server only for signaling
      knows peers=endpoints, rooms, producers and consumers
      a peer can join to only one room.

    each media server has 1 worker and router
    media server 1 has producer1 and consumers
    media server 2 has producer2 and consumers
    see https://mediasoup.org/documentation/v3/mediasoup/design/#architecture
 */
interface PingPong {
  ws: websocket.WebSocket
  interval?: NodeJS.Timeout
  pongWait: number
}

interface Worker extends PingPong{
  id: string
  stat:{
    load: number
  }
}
const workers = new Map<string, Worker>()
function deleteWorker(worker: Worker){
  clearInterval(worker.interval)
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


interface Peer extends PingPong, MSRemotePeer{
  room?: Room
  worker?: Worker
  transports:string[]
}
function toMSRemotePeer(peer: Peer):MSRemotePeer{
  const {ws, room, worker, interval, pongWait, ...ms} = peer
  return ms
}
const peers = new Map<string, Peer>()

interface Room{
  id: string
  peers: Set<Peer>
}
const rooms = new Map<string, Room>()

function send<MSM extends MSMessage>(msg: MSM, ws: websocket.WebSocket){
  ws.send(JSON.stringify(msg))
}
function sendRoom<MSM extends MSMessage>(msg: MSM, room:Room){
  if (room?.peers){
    for(const peer of room.peers.values()){
      peer.ws.send(JSON.stringify(msg))
    }
  }
}

function makeUniqueId(id:string, map: Map<string, any>){
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

function getPeerAndWorker(id: string){
  const peer = peers.get(id)
  if (!peer) {
    consoleError(`Peer ${id} not found.`)
    exit()
  }
  if (!peer.worker) peer.worker = getVacantWorker()
  return peer
}
const handlersForPeer = new Map<MSMessageType, (base:MSMessage, peer: Peer)=>void>()
const handlersForWorker = new Map<MSMessageType, (base:MSMessage, worker: Worker)=>void>()

function getPeer(id: string):Peer{
  const peer = peers.get(id)
  if (!peer){
    consoleError(`peer ${id} not found.`)
    return {peer:'', producers:[], transports:[], ws:new websocket.WebSocket(''), pongWait:0}
  }
  return peer
}
function deletePeer(peer: Peer){
  clearInterval(peer.interval)

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
      send(msg, peer.worker.ws)
    }
  })
  peer.transports.forEach(transport => {
    const msg: MSCloseTransportMessage= {
      type: 'closeTransport',
      transport,
    }
    send(msg, peer.worker!.ws)
  })
  remoteLeft([peer.peer], peer.room!)
  peers.delete(peer.peer)
  if (CONSOLE_DEBUG){
    const peerList = Array.from(peers.keys()).reduce((prev, cur) => `${prev} ${cur}`, '')
    consoleDebug(`Peers: ${peerList}`)
  }
}
function checkDeleteRoom(room?: Room){
  if (room && room.peers.size === 0){
    rooms.delete(room.id)
  }
}


//-------------------------------------------------------
//  handlers for worker
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

function relayPeerToWorker(base: MSMessage){
  const msg = base as MSPeerMessage
  const remoteOrPeer = getPeerAndWorker(msg.remote? msg.remote : msg.peer)
  if (remoteOrPeer.worker){
    consoleDebug(`P=>W ${msg.type} from ${msg.peer} relayed to ${remoteOrPeer.worker.id}`)
    const {remote, ...msg_} = msg
    send(msg_, remoteOrPeer.worker.ws)
  }
}
function relayWorkerToPeer(base: MSMessage){
  const msg = base as MSPeerMessage
  const peer = peers.get(msg.peer)
  if (peer){
    consoleDebug(`W=>P ${msg.type} from ${peer.worker?.id} relayed to ${peer.peer}`)
    send(msg, peer.ws)
  }
}


//-------------------------------------------------------
//  handlers for peer
handlersForPeer.set('ping', (msg, peer)=>{
  send(msg, peer.ws)
})

handlersForPeer.set('join',(base, peer)=>{
  const msg = base as MSPeerMessage
  const join = base as MSRoomMessage
  let room = rooms.get(join.room)
  if (room?.peers) {
    room.peers.add(peer)
  }else{
    room = {id:join.room, peers:new Set<Peer>([peer])}
    rooms.set(room.id, room)
    consoleLog(`room ${join.room} created: ${JSON.stringify(Array.from(rooms.keys()))}`)
  }
  peer.room = room
  consoleLog(`${peer.peer} joined to room ${join.room} ${JSON.stringify(Array.from(room.peers.keys()).map(p=>p.peer))}`)

  //  Notify (reply) the room's remotes
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: Array.from(peer.room.peers).map(peer => toMSRemotePeer(peer))
  }
  send(remoteUpdateMsg, peer.ws)
})
handlersForPeer.set('leave', (_base, peer)=>{
  peer.ws.close()
  deletePeer(peer)
  consoleLog(`${peer.peer} left from room ${peer.room?.id} ${peer.room ?
     JSON.stringify(Array.from(peer.room.peers.keys()).map(p=>p.peer)):'[]'}`)
})

function setRelayHandlers(mt: MSMessageType){
  handlersForPeer.set(mt, relayPeerToWorker)
  handlersForWorker.set(mt, relayWorkerToPeer)
}
setRelayHandlers('rtpCapabilities')
handlersForPeer.set('createTransport', relayPeerToWorker)
handlersForWorker.set('createTransport', (base)=>{
  const msg = base as MSCreateTransportReply
  const peer = getPeer(msg.peer)
  if (msg.transport){ peer.transports.push(msg.transport) }
  send(base, peer.ws)
})

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

setRelayHandlers('connectTransport')

handlersForPeer.set('produceTransport', relayPeerToWorker)
handlersForWorker.set('produceTransport', (base)=>{
  const msg = base as MSProduceTransportReply
  const peer = getPeer(msg.peer)
  if (msg.producer){
    if (peer.producers.find(p => p.role === msg.role && p.kind === msg.kind)){
      consoleError(`A producer for the same role "${msg.role}" and kind "${msg.kind}" already exists for peer "${peer.peer}".`)
    }else{
      consoleDebug(`new producer, role "${msg.role}" and kind "${msg.kind}" created for peer "${peer.peer}".`)
    }
    peer.producers.push({id:msg.producer, kind: msg.kind, role: msg.role})
  }
  send(base, peer.ws)
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


//  Websocket message handlers
function addCommonListner(pingPong: PingPong){
  pingPong.ws.on('ping', () =>{ pingPong.ws.pong() })
  pingPong.ws.on('pong', (ev) =>{
    pingPong.pongWait --
    consoleDebug(`pong ${pingPong.pongWait}`)
  })
  pingPong.interval = setInterval(()=>{
    if (pingPong.pongWait){
      const id = (pingPong as Worker).id || (pingPong as Peer).peer
      console.warn(`WS for '${id}' timed out. pong wait count = ${pingPong.pongWait}.`)
      pingPong.ws.close()
      clearInterval(pingPong.interval)
      return
    }
    pingPong.ws.ping()
    pingPong.pongWait ++
  }, 20 * 1000)
}
function addPeerListener(peer: Peer){
  addCommonListner(peer)
  peer.ws.addEventListener('close', () =>{
    consoleDebug(`WS for peer ${peer.peer} closed.`)
    deletePeer(peer)
  })
  peer.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    const handler = handlersForPeer.get(msg.type)
    if (handler){
      handler(msg, peer)
    }else{
      console.warn(`Unhandle peer message ${msg.type} received from ${msg.peer}`)
    }
  })
}
function addWorkerListener(worker: Worker){
  addCommonListner(worker)
  worker.ws.addEventListener('close', () =>{
    consoleDebug(`WS for worker ${worker.id} closed.`)
    deleteWorker(worker)
  })
  worker.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    const handler = handlersForWorker.get(msg.type)
    if (handler){
      handler(msg, worker)
    }else{
      console.warn(`Unhandle workder message ${msg.type} received from ${msg.peer}`)
    }
  })
}

function onFirstMessage(messageData: websocket.MessageEvent){
  const ws = messageData.target
  const msg = JSON.parse(messageData.data.toString()) as MSConnectMessage
  consoleDebug(`PeerMsg ${msg.type} from ${msg.peer}`)
  if (msg.type === 'connect'){
    let unique = ''
    let justBefore
    if (msg.peerJustBefore && (justBefore = peers.get(msg.peerJustBefore))) {
      deletePeer(justBefore)
      consoleLog(`New connection removes ${justBefore.peer} from room ${justBefore.room?.id}` +
        `${justBefore.room ? JSON.stringify(Array.from(justBefore.room.peers.keys()).map(p=>p.peer)):'[]'}`)
      unique = makeUniqueId(justBefore.peer, peers)
    }else{
      unique = makeUniqueId(msg.peer, peers)
    }
    msg.peer = unique
    send(msg, ws)
    //  create peer
    const peer:Peer = {peer:unique, ws, producers:[], transports:[], pongWait:0}
    peers.set(unique, peer)
    ws.removeEventListener('message', onFirstMessage)
    addPeerListener(peer)
    consoleDebug(`${unique} connected: ${JSON.stringify(Array.from(peers.keys()))}`)
  }else if (msg.type === 'workerAdd'){
    const unique = makeUniqueId(msg.peer, workers)
    msg.peer = unique
    send(msg, ws)
    const {type, peer, ...msg_} = msg
    const worker:Worker = {...msg_, id:msg.peer, ws, stat:{load:0}, pongWait: 0}
    workers.set(msg.peer, worker)
    consoleLog(`addWorker ${msg.peer}`)
    ws.removeEventListener('message', onFirstMessage)
    addWorkerListener(worker)
  }else{
    console.warn(`invalid first message ${msg.type} received from ${msg.peer}.`)
  }
}

async function main() {
  // start https server
  consoleLog('starting wss server');
  try {
    const tls = {
      cert: fs.readFileSync(config.sslCrt),
      key: fs.readFileSync(config.sslKey),
    };
    const httpsServer = https.createServer(tls);
    httpsServer.on('error', (e) => {
      consoleError('https server error,', e.message);
    });

    const wss = new websocket.Server({server: httpsServer})
    wss.on('connection', ws => {
      consoleDebug(`onConnection() `)
      ws.addEventListener('message', onFirstMessage)
    })

    await new Promise<void>((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        consoleLog(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
        resolve();
      });
    });
  } catch (e :any) {
    if (e.code === 'ENOENT') {
      consoleError('no certificates found (check config.js)');
      consoleError('  could not start https server ... trying http');
    } else {
      err('could not start https server', e);
    }
  }
}

main()
