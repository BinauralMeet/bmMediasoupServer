import websocket from 'ws'
import https from 'https'
import fs from 'fs'
import debugModule from 'debug'
import {ConnectTransportMessage, Message, MessageType, RoomMessage, TransportCreatedMessage} from './MediaMessages'

const log = debugModule('bmMsM');
const warn = debugModule('bmMsM:WARN');
const err = debugModule('bmMsM:ERROR');
const config = require('../config');

/*
    main server only for signaling
      knows endpoints, producers and consumers
    
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

interface Transport{
  id: string
  ws: websocket.WebSocket
}
const transports = new Map<string, Transport>()

function getVacantWorker(){
  return Array.from(workers.values()).reduce((prev, cur)=> prev.stat.load < prev.stat.load ? prev : cur)
}

interface Peer{
  id: string
  ws: websocket.WebSocket
  producers: string[]
}
const peers = new Map<string, Peer>()
interface Room{
  id: string
  peers: Set<string>
}
const rooms = new Map<string, Room>()

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

const handlers = new Map<MessageType, (ws:websocket.WebSocket, base:Message)=>void>()
handlers.set('connect',(ws, base)=>{
  const unique = makeUniqueId(base.peer, peers)
  base.peer = unique
  ws.send(JSON.stringify(base))
  peers.set(unique, {id:unique, ws, producers:[]})
  console.log(`${unique} connected: ${JSON.stringify(Array.from(peers.keys()))}`)
})
handlers.set('join',(ws, base)=>{
  const join = base as RoomMessage
  const room = rooms.get(join.room)
  console.log(`${join.peer} joined to room ${join.room}`)
  if (room) {
    room.peers.add(join.peer)
  }else{
    rooms.set(join.room, {id:join.room, peers:new Set<string>([join.peer])})
    console.log(`room ${join.room} created: ${JSON.stringify(Array.from(rooms.keys()))}`)
  }
})
handlers.set('leave',(ws, base)=>{
  const leave = base as RoomMessage
  const room = rooms.get(leave.room)
  if (room) {
    room.peers.delete(leave.peer)
  }
})
handlers.set('addWorker',(ws, base)=>{
  const unique = makeUniqueId(base.peer, workers)
  base.peer = unique
  ws.send(JSON.stringify(base))
  const {type, peer, ...msg_minus} = base
  workers.set(base.peer, {...msg_minus, id:base.peer, ws, stat:{load:0}})
  console.log(`addWorker ${base.peer}`)
})
handlers.set('deleteWorker',(ws, base)=>{
  workers.delete(base.peer)
})
handlers.set('createTransport', (ws, base) => {
  const worker = getVacantWorker()
  worker.ws.send(JSON.stringify(base))
})
handlers.set('transportCreated', (ws, base) => {
  const msg = base as TransportCreatedMessage
  const peer = peers.get(msg.peer)
  if (peer){
    peer.ws.send(JSON.stringify(msg))
  }
})
handlers.set('connectTransport', (ws, base) => {
  const msg = base as ConnectTransportMessage
  const wws = transports.get(msg.transportId)?.ws
  if (wws){ wws.send(JSON.stringify(msg)) }
})


function onWsConnection(ws: websocket.WebSocket){
  console.log(`onConnection() `)
  ws.on('message', messageData => {
    console.log(`onMessage(${messageData.toString()})`)
    const base = JSON.parse(messageData.toString()) as Message
    const handler = handlers.get(base.type)
    if (handler){
      handler(ws, base)
    }else{
      console.log(`unhandle message type ${base.type} received from ${base.peer}`)
    }
  })
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
      onWsConnection(ws)
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
