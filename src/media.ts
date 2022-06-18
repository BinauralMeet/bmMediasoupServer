import websocket from 'ws'
import * as mediasoup from 'mediasoup'
import debugModule from 'debug'
import {MSCreateTransportMessage, MSMessage, MSMessageType, MSCreateTransportReply, MSRTPCapabilitiesReply,
   MSConnectTransportMessage, MSConnectTransportReply, MSProduceTransportReply, MSProduceTransportMessage, MSPeerMessage, MSConsumeTransportMessage, MSConsumeTransportReply} from './MediaMessages'

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


let workerId = ''
const transports = new Map<string, mediasoup.types.Transport>()
const producers = new Map<string, mediasoup.types.Producer>()
const handlers = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()

function closeProducer(producer:mediasoup.types.Producer) {
  console.log('closing producer', producer.id, producer.appData);
  try {
    producer.close()
    // remove this producer from our list
    producers.delete(producer.id)
  } catch (e) {
    err(e);
  }
}
function closeConsumer(consumer: mediasoup.types.Consumer) {
  console.log('closing consumer', consumer.id, consumer.appData);
  consumer.close();
}

function send(base: MSMessage, ws: websocket.WebSocket){
  ws.send(JSON.stringify(base))
}

async function main() {
  // start mediasoup
  console.log('starting mediasoup')
  const {worker, router, audioLevelObserver} = await startMediasoup()

  handlers.set('addWorker',(base)=>{
    const msg = base as MSPeerMessage
    workerId = msg.peer
    console.log(`workerId: ${workerId}`)
  })

  handlers.set('rtpCapabilities',(base, ws)=>{
    const msg = base as MSPeerMessage
    const sendMsg:MSRTPCapabilitiesReply = {
      ...msg,
      rtpCapabilities: router.rtpCapabilities
    }
    send(sendMsg, ws)
  });

  handlers.set('createTransport',(base, ws)=>{
    const msg = base as MSCreateTransportMessage
    const {
      listenIps,
      initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport
    router.createWebRtcTransport({
      listenIps: listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
      appData: {peer: msg.peer, dir: msg.dir}
    }).then(transport=>{
      const sendMsg:MSCreateTransportReply = {
        type :'createTransport',
        peer: msg.peer,
        sn: msg.sn,
        transport: transport.id,
        iceCandidates: transport.iceCandidates,
        iceParameters: transport.iceParameters,
        dtlsParameters: transport.dtlsParameters,
        dir: msg.dir,
      }
      transports.set(transport.id, transport)
      send(sendMsg, ws)
    });
  })

  handlers.set('connectTransport', (base, ws) => {
    const msg = base as MSPeerMessage
    const sendMsg:MSConnectTransportReply = {
      type: 'connectTransport',
      peer: msg.peer,
      sn: msg.sn,
      error: ''
    }
    try {
      const msg = base as MSConnectTransportMessage
      const transport = transports.get(msg.transport)
      if (!transport) {
        console.error(`connect-transport: server-side transport ${msg.transport} not found`)
        sendMsg.error = `server-side transport ${msg.transport} not found`
        send(sendMsg, ws)
      }else{
        transport.connect({dtlsParameters: msg.dtlsParameters}).then(()=>{
          send(sendMsg, ws)
        })
      }
    } catch (e) {
      console.error('error in /signaling/connect-transport', e);
      sendMsg.error = `${e}`
      send(sendMsg, ws)
    }
  })

  handlers.set('produceTransport', (base) => {
    const msg = base as MSProduceTransportMessage
    const {rtpParameters, paused, ...msg_} = msg
    const sendMsg:MSProduceTransportReply = msg_
    const transport = transports.get(msg.transport)
    if (!transport) {
      console.error(`produce-transport: server-side transport ${msg.transport} not found`)
      sendMsg.error = `server-side transport ${msg.transport} not found`
      send(sendMsg, ws)
    }else{
      transport.produce({
        kind:msg.kind,
        rtpParameters: msg.rtpParameters,
        paused:msg.paused,
        appData: { peer:msg.peer, transportId: transport.id}
      }).then((producer)=>{
        producer.on('transportclose', () => {
          console.log('producer\'s transport closed', producer.id);
          closeProducer(producer);
        });
        // monitor audio level of this producer. we call addProducer() here,
        // but we don't ever need to call removeProducer() because the core
        // AudioLevelObserver code automatically removes closed producers
        if (producer.kind === 'audio') {
          audioLevelObserver.addProducer({ producerId: producer.id });
        }

        producers.set(producer.id, producer)
        sendMsg.producer = producer.id
        send(sendMsg, ws)
      })
    }
  })

  handlers.set('consumeTransport', (base) => {
    const msg = base as MSConsumeTransportMessage
    const {rtpCapabilities, ...msg_} = msg
    const sendMsg:MSConsumeTransportReply = {...msg_}
    const transport = transports.get(msg.transport)
    if (!transport) {
      console.error(`consume-transport: server-side transport ${msg.transport} not found`)
      sendMsg.error = `server-side transport ${msg.transport} not found`
      send(sendMsg, ws)
    }else{
      transport.consume({
        producerId: msg.producer,
        rtpCapabilities: msg.rtpCapabilities,
        paused:true,
        appData: { peer:msg.peer, transportId: transport.id}
      }).then((consumer)=>{
        consumer.on('transportclose', () => {
          log(`consumer's transport closed`, consumer.id)
          closeConsumer(consumer)
        })
          consumer.on('producerclose', () => {
            log(`consumer's producer closed`, consumer.id);
            closeConsumer(consumer)
        })
        sendMsg.consumer = consumer.id
        sendMsg.rtpParameters = consumer.rtpParameters
        sendMsg.kind = consumer.kind
        send(sendMsg, ws)
      })
    }
  })


  // start https server, falling back to http if https fails
  console.log('connecting to main server');
  const ws = new websocket.WebSocket(config.mainServer)
    ws.onopen = (ev) => {
        let ip = getIpAddress()
        if (!ip) ip = 'localhost'
        const msg:MSPeerMessage = {
            type:'addWorker',
            peer:`${ip}_${worker.pid}`
        }
        console.log(`send ${JSON.stringify(msg)}`)
        send(msg, ws)
    }
    ws.onmessage = (ev)=>{
        const base = JSON.parse(ev.data.toString()) as MSMessage
        const handler = handlers.get(base.type)
        if (handler){
            handler(base, ws)
        }
    }
}

main()
