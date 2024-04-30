import websocket from 'ws'
import https from 'https'
import fs from 'fs'
import debugModule from 'debug'
import {MSConnectMessage, MSAuthMessage, MSRoomsListMessage} from './MediaServer/MediaMessages'
import {Worker, Peer, mainServer, sendMSMessage, processPeer, processWorker, addPeerListener, addWorkerListener} from './mainServer'
import {addDataListener, DataSocket, processData} from './DataServer/dataServer'
import {dataServer} from './DataServer/Stores'
import {addPositionListener} from './PositionServer/positionServer'
import {restApp} from './rest'
import {Console} from 'console'
import { GoogleServer } from "./GoogleServer/GoogleServer";

const err = debugModule('bmMsM:ERROR');
const config = require('../config');

const CONSOLE_DEBUG = false
const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.log
let roomsList: string[] = []
const userLogFile = fs.createWriteStream('/var/log/pm2/main_user.log', {flags:'a', encoding:'utf8'});
export const userLog = new Console(userLogFile)
export function stamp(){
  const date = new Date()
  return `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}, `
    + `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}:${date.getSeconds().toString().padStart(2,'0')}.${date.getMilliseconds().toString().padStart(3,'0')}`
}

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

// check if room name is matched with the login file info.
function isRoomNameMatch(roomNames: string[], input: string): boolean {
  for (const roomName of roomNames) {
    if (roomName.endsWith('*')) {
      const baseRoomName = roomName.slice(0, -1);
      if (input.startsWith(baseRoomName)) {
        return true;
      }
    } else {
      if (roomName === input) {
        return true;
      }
    }
  }
  return false;
}


//--------------------------------------------------
//  First websocket message handler
//  After connection, this handler judge kind of the websocket and add appropriate handlers.
function onFirstMessage(messageData: websocket.MessageEvent){
  const ws = messageData.target
  const msg = JSON.parse(messageData.data.toString()) as MSConnectMessage
  consoleDebug(`PeerMsg ${msg.type} from ${msg.peer}`)
  const gd = new GoogleServer();

  // Get room list from google drive before user login to save loading time.
  if(msg.type === 'roomsList'){
    console.log('roomsList called from main.ts')
    const msg = JSON.parse(messageData.data.toString()) as MSRoomsListMessage
    gd.login().then((logined) => {
      gd.dowloadJsonFile().then((roomData) => {
        const roomsInfo = JSON.parse(roomData as string)
        roomsList = roomsInfo.rooms.map((room: any) => room.roomName)
        msg.rooms = []
        sendMSMessage(msg, ws)
      }).catch((err) => {
        console.log('Error in dowloadJsonFile', err)
        msg.error = "error in dowloadJsonFile"
        sendMSMessage(msg, ws)});
    })
  }
  else if(msg.type === 'auth'){
    const msg = JSON.parse(messageData.data.toString()) as MSAuthMessage
    // check with google drive json file
    const nameMatchResult = isRoomNameMatch(roomsList, msg.room)
    // if room name is not found in the list, user can login without using Oauth2
    if(!nameMatchResult){
      msg.role = 'guest'
      sendMSMessage(msg, ws)
    }
    else{
      // load google Oauth2
      gd.login().then((logined) => {
        gd.dowloadJsonFile().then((roomData) => {
          gd.authorizeRoom(msg.room, msg.email, JSON.parse(roomData as string)).then((role) => {
            if (!role){
              msg.error = 'auth error'
            }
            else if(role === 'guest'){
              msg.role = 'guest'
            }
            else if(role === 'admin'){
              msg.role = 'admin'
            }
            sendMSMessage(msg, ws)
          })
        })
      })
    }
  } else if (msg.type === 'connect'){
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
    const now = Date.now()
    const peer:Peer = {peer:unique, ws, producers:[], transports:[], lastSent:now, lastReceived:now}
    mainServer.peers.set(unique, peer)
    ws.removeEventListener('message', onFirstMessage)
    addPeerListener(peer)
    consoleDebug(`${unique} connected: ${JSON.stringify(Array.from(mainServer.peers.keys()))}`)
  }else if (msg.type === 'dataConnect'){
    ws.removeEventListener('message', onFirstMessage)
    const ds:DataSocket = {ws, lastReceived:Date.now()}
    addDataListener(ds)
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

export let messageLoad = 0

function main() {
  Object.assign(global, {d:{mainServer, dataServer}})
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
    httpsServer.on('request', (req, res) =>{
      //console.log(`request: ${JSON.stringify(req.headers)}`)
      restApp(req, res)
    })
    wss.on('connection', ws => {
      consoleDebug(`onConnection() `)
      ws.addEventListener('message', onFirstMessage)
    })

    return new Promise<void>((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        consoleLog(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
        //  Start process to handle queued messages
        const INTERVAL = 100
        setInterval(()=>{
          const start = Date.now()
          let now = start
          while(now - start < INTERVAL/2){
            let processed = processData()
            processed ||= processWorker()
            if (!processed) processed = processPeer()
            if (!processed) break
            now = Date.now()
          }
          messageLoad = (now - start) / INTERVAL
          //utilization = performance.eventLoopUtilization(utilization)
          //console.log(`Process load: ${messageLoad.toPrecision(2)} utilization: ${JSON.stringify(utilization)}`)
    }, INTERVAL)

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
