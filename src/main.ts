import websocket from 'ws'
import https from 'https'
import fs from 'fs'
import debugModule from 'debug'
import {MSConnectTransportMessage, MSMessage, MSMessageType, MSRoomMessage, MSCreateTransportReply,
  MSPeerMessage, MSProduceTransportReply, MSRemoteProducer, MSRemotePeer, MSRemoteUpdateMessage, MSCloseTransportMessage} from './MediaMessages'
import { exit } from 'process'

const log = debugModule('bmMsM');
const warn = debugModule('bmMsM:WARN');
const err = debugModule('bmMsM:ERROR');
const config = require('../config');

/*
    main server only for signaling
      knows peers=endpoints, rooms, producers and consumers
      a peer can join to only one room.

    each media server has 1 worker and router
    media server 1 has producer1 and consumers
    media server 2 has producer2 and consumers
    see https://mediasoup.org/documentation/v3/mediasoup/design/#architecture
 */
interface Worker{
  id: string
  ws: websocket.WebSocket
  stat:{
    load: number
  }
}
const workers = new Map<string, Worker>()

function getVacantWorker(){
  if (workers.size){
    return Array.from(workers.values()).reduce((prev, cur)=> prev.stat.load < prev.stat.load ? prev : cur)
  }
  return undefined
}

interface Peer extends MSRemotePeer{
  ws: websocket.WebSocket
  room?: Room
  worker?: Worker
  transports:string[]
}
function toMSRemotePeer(peer: Peer):MSRemotePeer{
  const {ws, room, worker, ...ms} = peer
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
  for(const peer of room.peers.values()){
    peer.ws.send(JSON.stringify(msg))
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
    console.error(`Peer ${id} not found.`)
    exit()
  }
  if (!peer.worker) peer.worker = getVacantWorker()
  return peer
}
const handlersForPeer = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()
const handlersForWorker = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()

function getPeer(id: string):Peer{
  const peer = peers.get(id)
  if (!peer){
    console.error(`peer ${id} not found.`)
    return {peer:'', producers:[], transports:[], ws:new websocket.WebSocket('')}
  }
  return peer
}
function deletePeer(id: string){
  const peer = getPeer(id)
  peer.room?.peers.delete(peer)
  checkDeleteRoom(peer.room)
}
function checkDeleteRoom(room?: Room){
  if (room && room.peers.size === 0){
    rooms.delete(room.id)
  }
}

handlersForPeer.set('connect',(base, ws)=>{
  const msg = base as MSPeerMessage
  const unique = makeUniqueId(msg.peer, peers)
  msg.peer = unique
  send(msg, ws)
  peers.set(unique, {peer:unique, ws, producers:[], transports:[]})
  console.log(`${unique} connected: ${JSON.stringify(Array.from(peers.keys()))}`)
})
handlersForPeer.set('join',(base, ws)=>{
  const msg = base as MSPeerMessage
  const peer = getPeer(msg.peer)
  const join = base as MSRoomMessage
  let room = rooms.get(join.room)
  console.log(`${peer.peer} joined to room ${join.room}`)
  if (room) {
    room.peers.add(peer)
  }else{
    room = {id:join.room, peers:new Set<Peer>([peer])}
    rooms.set(room.id, room)
    console.log(`room ${join.room} created: ${JSON.stringify(Array.from(rooms.keys()))}`)
  }
  peer.room = room
  //  notify the room's remotes
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: Array.from(peer.room.peers).map(peer => toMSRemotePeer(peer))
  }
  send(remoteUpdateMsg, ws)
})
handlersForPeer.set('leave',(base)=>{
  const msg = base as MSPeerMessage
  deletePeer(msg.peer)
})
handlersForPeer.set('addWorker',(base, ws)=>{
  const msg = base as MSPeerMessage
  const unique = makeUniqueId(msg.peer, workers)
  msg.peer = unique
  send(msg, ws)
  const {type, peer, ...msg_minus} = msg
  workers.set(msg.peer, {...msg_minus, id:msg.peer, ws, stat:{load:0}})
  ws.removeEventListener('message', onWsMessagePeer)
  ws.addEventListener('message', onWsMessageWorker)
  console.log(`addWorker ${msg.peer}`)
})
handlersForWorker.set('deleteWorker',(base, ws)=>{
  const msg = base as MSPeerMessage
  workers.delete(msg.peer)
})

function relayPeerToWorker(base: MSMessage){
  const msg = base as MSPeerMessage
  const peer = getPeerAndWorker(msg.peer)
  if (peer.worker){
    send(msg, peer.worker.ws)
  }
}
function relayWorkerToPeer(base: MSMessage){
  const msg = base as MSPeerMessage
  const peer = peers.get(msg.peer)
  if (peer){
    send(msg, peer.ws)
  }
}
function setRelayHandlers(mt: MSMessageType){
  handlersForPeer.set(mt, relayPeerToWorker)
  handlersForWorker.set(mt, relayWorkerToPeer)
}
setRelayHandlers('rtpCapabilities')
handlersForPeer.set('createTransport', relayPeerToWorker)
handlersForWorker.set('createTransport', (base, ws)=>{
  const msg = base as MSCreateTransportReply
  const peer = getPeer(msg.peer)
  if (msg.transport){ peer.transports.push(msg.transport) }
  send(base, peer.ws)
})

setRelayHandlers('connectTransport')
handlersForPeer.set('produceTransport', relayPeerToWorker)
handlersForWorker.set('produceTransport', (base, ws)=>{
  const msg = base as MSProduceTransportReply
  const peer = getPeer(msg.peer)
  if (msg.producer){
    if (peer.producers.find(p => p.role === msg.role && p.kind === msg.kind)){
      console.error(`A producer for the same role ${msg.role} and kind ${msg.kind} already exists.`)
    }
    peer.producers.push({id:msg.producer, kind: msg.kind, role: msg.role})
  }
  send(base, peer.ws)
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: [toMSRemotePeer(peer)]
  }
  sendRoom(remoteUpdateMsg, peer.room!)
})
setRelayHandlers('consumeTransport')

function onWsMessagePeer(messageData: websocket.MessageEvent){
  const ws = messageData.target
  console.log(`onMessagePeer(${messageData.data.toString()})`)
  const base = JSON.parse(messageData.data.toString()) as MSMessage
  const handler = handlersForPeer.get(base.type)
  if (handler){
    handler(base, ws)
  }else{
    const msg = base as MSPeerMessage
    console.log(`Unhandle peer message ${msg.type} received from ${msg.peer}`)
  }
}
function onWsMessageWorker(messageData: websocket.MessageEvent){
  const ws = messageData.target
  console.log(`onMessageWorker(${messageData.data.toString()})`)
  const base = JSON.parse(messageData.data.toString()) as MSMessage
  const handler = handlersForWorker.get(base.type)
  if (handler){
    handler(base, ws)
  }else{
    const msg = base as MSPeerMessage
    console.log(`Unhandle worker message ${msg.type} received from ${msg.peer}`)
  }
}

async function main() {
  // start https server
  console.log('starting wss server');
  try {
    const tls = {
      cert: fs.readFileSync(config.sslCrt),
      key: fs.readFileSync(config.sslKey),
    };
    const httpsServer = https.createServer(tls);
    httpsServer.on('error', (e) => {
      console.error('https server error,', e.message);
    });

    const wss = new websocket.Server({server: httpsServer})
    wss.on('connection', ws => {
      console.log(`onConnection() `)
      ws.addEventListener('message', onWsMessagePeer)
      ws.addEventListener('close', (ev) =>{
        const peer = Array.from(peers.values()).find(p => p.ws === ws)
        if (peer){
          peer.transports.forEach(transport => {
            const msg: MSCloseTransportMessage= {
              type: 'closeTransport',
              transport,
            }
            send(msg, peer.worker!.ws)
          })
          peers.delete(peer.peer)
        }
      })
    })

    await new Promise<void>((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        console.log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
        resolve();
      });
    });
  } catch (e :any) {
    if (e.code === 'ENOENT') {
      console.error('no certificates found (check config.js)');
      console.error('  could not start https server ... trying http');
    } else {
      err('could not start https server', e);
    }
  }
}

main()
