import websocket from 'ws'
import https from 'https'
import fs from 'fs'
import debugModule from 'debug'
import {MSPeerMessage, MSConnectMessage} from './MediaServer/MediaMessages'
import {PingPong, Worker, Peer, mainServer, sendMSMessage} from './mainServer'
import {addDataListener} from './DataServer/dataServer'
import { addPositionListener } from './PositionServer/positionServer'

const err = debugModule('bmMsM:ERROR');
const config = require('../config');

const CONSOLE_DEBUG = false
const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.log

//--------------------------------------------------
//  utilities
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


//--------------------------------------------------
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
  console.log(`addPeerListener ${peer.peer} called.`)
  addCommonListner(peer)
  peer.ws.addEventListener('close', () =>{
    consoleDebug(`WS for peer ${peer.peer} closed.`)
    mainServer.deletePeer(peer)
  })
  peer.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    const handler = mainServer.handlersForPeer.get(msg.type)
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
    mainServer.deleteWorker(worker)
  })
  worker.ws.addEventListener('message', (messageData: websocket.MessageEvent)=>{
    const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage
    const handler = mainServer.handlersForWorker.get(msg.type)
    if (handler){
      handler(msg, worker)
    }else{
      console.warn(`Unhandle workder message ${msg.type} received from ${msg.peer}`)
    }
  })
}

//  After connection, this handler judge kind of the websocket and add appropriate handlers.
function onFirstMessage(messageData: websocket.MessageEvent){
  const ws = messageData.target
  const msg = JSON.parse(messageData.data.toString()) as MSConnectMessage
  consoleDebug(`PeerMsg ${msg.type} from ${msg.peer}`)

  //Here makes the connection to the WS
  if (msg.type === 'connect'){



    const { roomInfo } = msg;
    // Assuming you have a function that gets a room object by its ID
    let room = getRoomById(roomInfo.roomId);

    if (room) {
      // Apply the new info to the room
      room.name = roomInfo.roomName;
      room.owner = roomInfo.roomOwner;
      room.password = roomInfo.roomPassword;
      room.requiredLogin = roomInfo.requiredLogin;

      // Save changes to the room. Implementation will depend on your application
      saveRoom(room);
    }



    let unique = ''
    let justBefore

    if (msg.peerJustBefore && (justBefore = mainServer.peers.get(msg.peerJustBefore))) {
      mainServer.deletePeer(justBefore)
      consoleLog(`New connection removes ${justBefore.peer} from room ${justBefore.room?.id}` +
        `${justBefore.room ? JSON.stringify(Array.from(justBefore.room.peers.keys()).map(p=>p.peer)):'[]'}`)
      unique = makeUniqueId(justBefore.peer, mainServer.peers)
    } else {
      unique = makeUniqueId(msg.peer, mainServer.peers)
    }
    msg.peer = unique
    sendMSMessage(msg, ws)

    //  create peer
    const peer:Peer = {peer:unique, ws, producers:[], transports:[], pongWait:0}
    mainServer.peers.set(unique, peer)
    ws.removeEventListener('message', onFirstMessage)
    addPeerListener(peer)
    consoleDebug(`${unique} connected: ${JSON.stringify(Array.from(mainServer.peers.keys()))}`)

  }else if (msg.type === 'dataConnect'){
    ws.removeEventListener('message', onFirstMessage)
    addDataListener(ws)
  }else if (msg.type === 'positionConnect'){
    ws.removeEventListener('message', onFirstMessage)
    addPositionListener(ws, msg.peer)
  }else if (msg.type === 'workerAdd'){
    const unique = makeUniqueId(msg.peer, mainServer.workers)
    msg.peer = unique
    sendMSMessage(msg, ws)
    const {type, peer, ...msg_} = msg
    const worker:Worker = {...msg_, id:msg.peer, ws, stat:{load:0}, pongWait: 0}
    mainServer.workers.set(msg.peer, worker)
    consoleLog(`addWorker ${msg.peer}`)
    ws.removeEventListener('message', onFirstMessage)
    addWorkerListener(worker)
  }else{
    console.warn(`invalid first message ${msg.type} received from ${msg.peer}.`)
  }
}

function main() {
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

    return new Promise<void>((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        consoleLog(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
        resolve();
      });
    })
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
