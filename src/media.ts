import websocket from 'ws'
import * as mediasoup from 'mediasoup'
import fs from 'fs'
import debugModule from 'debug'
import { argv } from 'process'
import {Message, MessageType} from './MediaMessages'

import { networkInterfaces } from "os";
function getIpAddress() {
  const nets = networkInterfaces();
  const net = nets["en0"]?.find((v) => v.family == "IPv4");
  return !!net ? net.address : null;
}

const log = debugModule('bmMsE');
const warn = debugModule('bmMsE:WARN');
const err = debugModule('bmMsE:ERROR');
const config = require('../config');

/*
    main server only for signaling
      knows endpoints, producers and consumers
    
    each media server has 1 worker and router
    media server 1 has producer1 and consumers
    media server 2 has producer2 and consumers
    see https://mediasoup.org/documentation/v3/mediasoup/design/#architecture
 */


async function startMediasoup() {
  const worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  const router = await worker.createRouter({ mediaCodecs });

  // audioLevelObserver for signaling active speaker
  //
  const audioLevelObserver = await router.createAudioLevelObserver({
    interval: 800
  });
  audioLevelObserver.on('volumes', (volumes) => {
    const { producer, volume } = volumes[0];
    log('audio-level volumes event', producer.appData.peerId, volume);
  });
  audioLevelObserver.on('silence', () => {
    log('audio-level silence event');
  });

  return { worker, router, audioLevelObserver };
}

const handlers = new Map<MessageType, (ws:websocket.WebSocket, base:Message)=>void>()
handlers.set('addWorker',(ws, base)=>{
    workerId = base.peer
    console.log(`workerId: ${workerId}`)
})
  

let workerId = ''
async function main() {
  // start mediasoup
  console.log('starting mediasoup')
  const {worker, router, audioLevelObserver} = await startMediasoup()  

  // start https server, falling back to http if https fails
  console.log('connecting to main server');
  const ws = new websocket.WebSocket(config.mainServer)
    ws.onopen = (ev) => {
        let ip = getIpAddress()
        if (!ip) ip = 'localhost'
        const msg:Message = {
            type:'addWorker',
            peer:`${ip}_${worker.pid}`
        }
        ws.send(JSON.stringify(msg))
    }
    ws.onmessage = (ev)=>{
        const base = JSON.parse(ev.data.toString()) as Message
        const handler = handlers.get(base.type)
        if (handler){
            handler(ws, base)
        }
    }
}

main()
