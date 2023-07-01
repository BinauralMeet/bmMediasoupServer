import websocket from 'ws'
import {MSMessage, MSMessageType, MSRoomMessage, MSCreateTransportReply, MSPeerMessage,
  MSProduceTransportReply, MSRemotePeer, MSRemoteUpdateMessage, MSRoomJoinMessage,
  MSCloseTransportMessage, MSCloseProducerMessage, MSRemoteLeftMessage, MSWorkerUpdateMessage} from './MediaServer/MediaMessages'
import {exit} from 'process'



//------------- Custom Code ------------------------
import express from 'express';
const app = express();
const cors = require('cors');
app.use(express.json()); // for parsing application/json
app.use(cors()); // enable CORS

// Endpoint to get a room by its ID
app.get('/rooms/:RoomName', (req, res) => {
  const RoomName = req.params.RoomName;
  let foundRoom = null;

  // Iterate over your rooms collection to find a match
  for (let room of rooms.values()) {
    if (room.RoomName === RoomName) {
      foundRoom = room;
      break;
    }
  }

  if (foundRoom) {
    res.json(foundRoom);
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
})


// Endpoint to create a new room
app.post('/rooms', (req, res) => {
  // TODO: Validate the request body to make sure it has the correct format
  const newRoom = req.body;
  rooms.set(newRoom.id, newRoom);
  res.status(201).json(newRoom);
});


app.post('/checkPassword', (req, res) => {
  const { roomId, password } = req.body;
  console.log('Received:', { roomId, password });

  const room = getRoomById(roomId);
  console.log('Room:', rooms);

  if (!room) {
    return res.status(404).json({ error: rooms });
  }

  if (room.RoomPassword !== password) {
    console.log('Password mismatch:', { entered: password, actual: room.RoomPassword });
    return res.status(401).json({ error: 'Password is incorrect' });
  }

  // If everything checks out, return a 200 status code with room details
  return res.status(200).json(room);
});




// [3200 is the port for REST]
// TODO: Add more endpoints to update and delete rooms, if necessary
app.listen(3200, () => console.log('REST listening on port 3200'))
//------------- Custom Code ------------------------



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


export interface Peer extends PingPong, MSRemotePeer{
  room?: Room
  worker?: Worker
  transports:string[]
}
function toMSRemotePeer(peer: Peer):MSRemotePeer{
  const {ws, room, worker, interval, pongWait, ...ms} = peer
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

function printExistingRooms() {
  if (rooms.size === 0) {
    consoleLog('No existing rooms.');
  } else {
    consoleLog('Existing rooms:', rooms);
    /*for (const room of rooms.values()) {
      (room.id);
    }*/
  }
}

/*function joinRoom(roomId: string, peerId: string) {
  const existingRoom = rooms.get(roomId);
  if (existingRoom) {
    consoleLog(`Exist: ${roomId}`);
  } else {
    consoleLog(`Creating room: ${roomId}`);
    const room: Room = { id: roomId, peers: new Set<Peer>() };
    rooms.set(room.id, room);
  }*/


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
    exit()
  }
  if (!peer.worker) peer.worker = getVacantWorker()
  return peer
}
function getPeer(id: string):Peer{
  const peer = peers.get(id)
  if (!peer){
    consoleError(`peer ${id} not found.`)
    return {peer:'', producers:[], transports:[], ws:new websocket.WebSocket(''), pongWait:0}
  }
  return peer
}
export function deletePeer(peer: Peer){
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
      sendMSMessage(msg, peer.worker.ws)
    }
  })
  peer.transports.forEach(transport => {
    const msg: MSCloseTransportMessage= {
      type: 'closeTransport',
      transport,
    }
    sendMSMessage(msg, peer.worker!.ws)
  })
  remoteLeft([peer.peer], peer.room!)
  peers.delete(peer.peer)
  if (CONSOLE_DEBUG){
    const peerList = Array.from(peers.keys()).reduce((prev, cur) => `${prev} ${cur}`, '')
    consoleDebug(`Peers: ${peerList}`)
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
handlersForPeer.set('ping', (msg, peer)=>{
  sendMSMessage(msg, peer.ws)
})


// --------------> This is where join to the Server
handlersForPeer.set('join',(base, peer)=>{
  const msg = base as MSPeerMessage;
  const join = base as MSRoomJoinMessage;
  let room = rooms.get(join.room);

  printExistingRooms(); //Print me all the existing rooms.
  //consoleLog("Room Object Info: ", room)

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
    consoleLog(`room ${join.room} created: ${JSON.stringify(Array.from(rooms.keys()))}`);
  }

  peer.room = room;
  consoleLog(`${peer.peer} joined to room ${join.room} ${JSON.stringify(Array.from(room.peers.keys()).map(p=>p.peer))}`);

  //  Notify (reply) the room's remotes
  const remoteUpdateMsg:MSRemoteUpdateMessage = {
    type:'remoteUpdate',
    remotes: Array.from(peer.room.peers).map(peer => toMSRemotePeer(peer))
  };
  sendMSMessage(remoteUpdateMsg, peer.ws);
})
handlersForPeer.set('leave', (_base, peer)=>{
  peer.ws.close()
  deletePeer(peer)
  consoleLog(`${peer.peer} left from room ${peer.room?.id} ${peer.room ?
     JSON.stringify(Array.from(peer.room.peers.keys()).map(p=>p.peer)):'[]'}`)
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
  if (remoteOrPeer.worker){
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
handlersForWorker.set('createTransport', (base)=>{
  const msg = base as MSCreateTransportReply
  const peer = getPeer(msg.peer)
  if (msg.transport){ peer.transports.push(msg.transport) }
  sendMSMessage(base, peer.ws)
})


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
