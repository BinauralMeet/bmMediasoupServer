import websocket from 'ws'
import * as mediasoup from 'mediasoup'
import debugModule from 'debug'
import {MSCreateTransportMessage, MSMessage, MSMessageType, MSCreateTransportReply, MSRTPCapabilitiesReply,
   MSConnectTransportMessage, MSConnectTransportReply, MSProduceTransportReply, MSProduceTransportMessage,
   MSPeerMessage, MSConsumeTransportMessage, MSConsumeTransportReply, MSResumeConsumerMessage, MSCloseConsumerMessage,
   MSResumeConsumerReply, MSCloseProducerMessage, MSCloseProducerReply, MSWorkerUpdateMessage,
   MSStreamingStartMessage, MSStreamingStopMessage, MSCloseTransportMessage,
   MSServerStatusMessage,
   TransportStatus,
   ProducerStatus,
   ConsumerStatus,
   MSServerStatusStream,
   MSRestartIceMessage,
   MSRestartIceReply,
   MSSttStartMessage,
   MSSttStopMessage} from './MediaServer/MediaMessages'
import * as os from 'os'
import {streamingStart, streamingStop} from './MediaServer/streaming'
import {sttStart, sttStop, sttStopByPeer, setSttResultSender} from './MediaServer/stt'
import { debuglog } from 'util'
import {Peers} from './MediaServer/Peers'

const log = debugModule('bmMsE');
const warn = debugModule('bmMsE:WARN');
const err = debugModule('bmMsE:ERROR');
const config = require('../config');


const CONSOLE_DEBUG = false
const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.error

let ws : websocket.WebSocket
let workerId = ''
let workerLoad = 0
let lastPingTimestamp = 0

const transports = new Map<string, mediasoup.types.WebRtcTransport>()
const peers = new Peers()
export const producers = new Map<string, mediasoup.types.Producer>()
const consumers = new Map<string, mediasoup.types.Consumer>()
const handlers = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()

const fqdn = os.hostname()
const hostinfo={
  fqdn,
  name:fqdn.substring(0, fqdn.indexOf('.')),
}
//  TURN server handed to clients with each transport. coturn normally runs on this host; a media
//  server without coturn names the host that has one in config.js (turnHost).
const turnHost:string = config.turnHost || fqdn

// start mediasoup
consoleLog('starting mediasoup')
startMediasoup().then(({worker, router}) => {
  Object.assign(global, {d:{
      worker,
      router,
      transports,
      producers,
      consumers,
    }}
  )
  //  set message handlers
  handlers.set('workerAdd',(base)=>{
    const msg = base as MSPeerMessage
    workerId = msg.peer
    consoleLog(`workerId: ${workerId}`)
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
    const {initialAvailableOutgoingBitrate} = config.mediasoup.webRtcTransport
    //  Looked up per transport, not once at start: pm2 starts this right after boot, sometimes
    //  before the interface has its address, and the 127.0.0.1 it then settled on for good made
    //  every send transport on this server fail ICE until a restart (found 2026-10-16).
    let listenIps = config.mediasoup.webRtcTransport.listenIps
    if (listenIps.length === 0){
      const ip = getIpAddress()
      listenIps = ip ? [{ip, announcedIp: null}] : []
    }
    if (listenIps.length === 0){
      consoleError(`createTransport for peer ${msg.peer}: this host has no IPv4 address yet`)
      const errMsg: MSCreateTransportReply = {
        type: 'createTransport',
        peer: msg.peer,
        sn: msg.sn,
        dir: msg.dir,
        error: 'media server has no network address',
      }
      send(errMsg, ws)
      return
    }

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
        iceServers: [
          {
            urls: `turn:${turnHost}`,
            username: 'binauralmeet',
            credential: 'binauralmeet_mediasoup_server',
          },
          {
            urls: `turns:${turnHost}:443`,
            username: 'binauralmeet',
            credential: 'binauralmeet_mediasoup_server',
          },
        ]
      }
      transports.set(transport.id, transport)
      peers.addTransport(msg.peer, transport.id)
      send(sendMsg, ws)
    }).catch((e) => {
      consoleError(`createTransport failed for peer ${msg.peer}:`, e);
      const errMsg: MSCreateTransportReply = {
        type: 'createTransport',
        peer: msg.peer,
        sn: msg.sn,
        dir: msg.dir,
        error: `${e}`,
      }
      send(errMsg, ws)
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
        consoleError(`connect-transport: server-side transport ${msg.transport} not found`)
        sendMsg.error = `server-side transport ${msg.transport} not found`
        send(sendMsg, ws)
      }else{
        transport.connect({dtlsParameters: msg.dtlsParameters}).then(()=>{
          send(sendMsg, ws)
        }).catch((e) => {
          consoleError('error in connect-transport', e);
          sendMsg.error = `${e}`
          send(sendMsg, ws)
        })
      }
    } catch (e) {
      consoleError('error in /signaling/connect-transport', e);
      sendMsg.error = `${e}`
      send(sendMsg, ws)
    }
  })
  handlers.set('restartIce', (base, ws) => {
    const msg = base as MSRestartIceMessage
    const reply:MSRestartIceReply = {
      type: 'restartIce',
      peer: msg.peer,
      sn: msg.sn,
      transport: msg.transport,
    }
    const transport = transports.get(msg.transport)
    if (!transport) {
      reply.error = `server-side transport ${msg.transport} not found`
      send(reply, ws)
      return
    }
    transport.restartIce().then((iceParameters) => {
      reply.iceParameters = iceParameters
      send(reply, ws)
    }).catch((e) => {
      reply.error = `${e}`
      send(reply, ws)
    })
  })
  handlers.set('closeTransport', (base, ws) => {
    const msg = base as MSCloseTransportMessage
    try {
      const transport = transports.get(msg.transport)
      if (!transport) {
        consoleError(`closetransport: server-side transport ${msg.transport} not found`)
      }else{
        consoleDebug(`Transport ${msg.transport} closed.`, msg)
        peers.removeTransport(msg.peer, msg.transport)
        transports.delete(msg.transport)
        transport.close()
      }
    } catch (e) {
      consoleError('error in /signaling/closeTransport', e);
    }
  })
  handlers.set('peerLeft', (base, ws) => {
    const msg = base as MSPeerMessage
    try {
      //  A session holds a UDP port and an ffmpeg child process; closing the peer's transports
      //  below would not release either of them.
      sttStopByPeer(msg.peer)
      const peer = peers.get(msg.peer)
      if (peer){
        peer.transports.forEach((transId) => {
          const transport = transports.get(transId)
          transports.delete(transId)
          transport?.close()
        })
        peers.delete(msg.peer)
      }
    } catch (e) {
      consoleError('error in /signaling/peerLeft', e);
    }
  })

  handlers.set('produceTransport', (base) => {
    const msg = base as MSProduceTransportMessage
    const {rtpParameters, paused, ...msg_} = msg
    const sendMsg:MSProduceTransportReply = msg_
    const transport = transports.get(msg.transport)
    if (!transport) {
      consoleError(`produce-transport: server-side transport ${msg.transport} not found`)
      sendMsg.error = `server-side transport ${msg.transport} not found`
      send(sendMsg, ws)
    }else{
      transport.produce({
        kind:msg.kind,
        rtpParameters: msg.rtpParameters,
        paused:msg.paused,
        appData: { peer:msg.peer, transportId: transport.id}
      }).then((producer)=>{
        if(producer.type === 'simulcast'){
          producer.close()
          consoleLog(`Simulcast producer ${producer.id} created but closed`)
        }else{
          consoleDebug(`${producer.type} producer ${producer.id} created`)
          producer.on('transportclose', () => {
            consoleDebug('producer\'s transport closed', producer.id);
            closeProducer(producer);
          })
          producers.set(producer.id, producer)
          sendMsg.producer = producer.id
          send(sendMsg, ws)
          updateWorkerLoad()
        }
      }).catch((e) => {
        consoleError(`produceTransport failed for peer ${msg.peer}:`, e);
        sendMsg.error = `${e}`
        send(sendMsg, ws)
      })
    }
  })
  handlers.set('closeProducer', (base) => {
    const msg = base as MSCloseProducerMessage
    const producerObject = producers.get(msg.producer)
    const {producer, ...msg_} = msg
    const reply:MSCloseProducerReply = {
      ...msg,
    }
    if (producerObject){
      producers.delete(producer)
      producerObject.close()
      updateWorkerLoad()
    }else{
      reply.error = 'producer not found.'
    }
    send(reply, ws)
  })

  handlers.set('consumeTransport', (base) => {
    const msg = base as MSConsumeTransportMessage
    const {rtpCapabilities, ...msg_} = msg
    const sendMsg:MSConsumeTransportReply = {...msg_}
    const transport = transports.get(msg.transport)
    if (!transport) {
      consoleError(`consume-transport: server-side transport ${msg.transport} not found`)
      sendMsg.error = `server-side transport ${msg.transport} not found`
      send(sendMsg, ws)
    }else{
      transport.consume({
        producerId: msg.producer,
        rtpCapabilities: msg.rtpCapabilities,
        paused:true,
        appData: { peer:msg.peer, transportId: transport.id}
      }).then((consumer)=>{
        consumers.set(consumer.id, consumer)
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
      }).catch((e)=>{
        //  The reason matters: "producer not found" (a remote that just left or reconnected) is
        //  routine, anything else is not.
        consoleError(`consume-transport: for producer ${msg.producer} failed: ${e?.message ?? e}`)
        sendMsg.error = `consume for ${msg.producer} failed`
        send(sendMsg, ws)
      })
    }
  })

  handlers.set('resumeConsumer', (base) => {
    const msg = base as MSResumeConsumerMessage
    const consumerObject = consumers.get(msg.consumer)
    const {consumer, ...msg_} = msg
    const reply:MSResumeConsumerReply = {
      ...msg_,
    }
    if (consumerObject){
      consumerObject.resume().then(()=>{
        consoleDebug(`consumer.resume() for ${consumer} succeed.`)
        send(reply, ws)
      }).catch(()=>{
        reply.error = `consumer.resume() for ${consumer} failed.`
        send(reply, ws)
      })
    }else{
      reply.error = `consumer ${consumer} not found.`
      send(reply, ws)
    }
  })

  //  mediasoup-client's consumer.close() only closes the client's end; without this the server's
  //  consumer keeps forwarding that media to a client that dropped it -- and each time the client
  //  picks the producer up again (priority changes as people move), yet another one is added.
  //  Only the peer the consumer was created for may close it.
  handlers.set('closeConsumer', (base) => {
    const msg = base as MSCloseConsumerMessage
    const consumerObject = consumers.get(msg.consumer)
    if (consumerObject && consumerObject.appData?.peer === msg.peer){
      closeConsumer(consumerObject)
    }
  })

  //  handler for streaming
  handlers.set('streamingStart',(base, ws)=>{
    const msg = base as MSStreamingStartMessage
    streamingStart(router, msg)
  })
  handlers.set('streamingStop',(base, ws)=>{
    const msg = base as MSStreamingStopMessage
    streamingStop(router, msg)
  })

  //  handler for speech-to-text (see the bm workspace doc `stt-translation`)
  handlers.set('sttStart',(base, ws)=>{
    const msg = base as MSSttStartMessage
    setSttResultSender((result) => { send(result, ws) })
    const error = sttStart(router, msg)
    //  Reply either way: a client whose request was refused (no backend, too many sessions,
    //  not its own producer) must be able to tell that from "accepted but nobody is talking".
    const {producers:_p, ...reply} = msg
    send({...reply, error} as MSSttStartMessage, ws)
  })
  handlers.set('sttStop',(base, ws)=>{
    sttStop(base as MSSttStopMessage)
  })

  //  hander for debug log
  handlers.set('serverStatus', (base, ws) => {
    const msg = base as MSServerStatusMessage
    if (msg.statusType === 'streams'){
      const status:MSServerStatusStream = {
        transports: Array.from(transports.values()).map<TransportStatus>(v =>
          ({id:v.id, appData: v.appData})),
        producers: Array.from(producers.values()).map<ProducerStatus>(v =>
          ({id:v.id, appData: v.appData,
            closed: v.closed, paused: v.paused, kind: v.kind, type: v.type})),
        consumers: Array.from(consumers.values()).map<ConsumerStatus>(v =>
          ({id:v.id, appData: v.appData,
            closed: v.closed, paused: v.paused, kind: v.kind, type: v.type,
            producerId: v.producerId}))
      }
      msg.status = status
      send(msg, ws)
    }
  })

  //  function defines which use worker etc.
  function connectToMain(){
    clearMediasoup()
    ws = new websocket.WebSocket(config.mainServer)
    ws.onopen = (ev) => {
      let name = hostinfo.name
      if (!name) name = 'localhost'
      const msg:MSPeerMessage = {
          type:'workerAdd',
          peer:`${name}_${worker.pid}`
      }
      consoleDebug(`send ${JSON.stringify(msg)}`)
      send(msg, ws)   //  the socket is OPEN inside onopen
    }
    ws.onmessage = (ev)=>{
      const text = ev.data.toString()
      //  consoleLog(text)
      const base = JSON.parse(text) as MSMessage
      consoleDebug(`${base.type} received from ${(base as any).peer}.`)
      const handler = handlers.get(base.type)
      if (handler){
          handler(base, ws)
      }
    }
    ws.onerror = (ev)=>{
      consoleLog(`ws error ${ev.message}, state:${ws.readyState}`)
    }
    ws.on('ping', ()=>{
      debuglog('ping received.')
      ws.pong()
      lastPingTimestamp = Date.now()
    })
  }

  lastPingTimestamp = Date.now()
  consoleLog('connecting to main server')
  const TIMEOUT = config.workerWebsocketTimeout
  setInterval(()=>{
    if (ws && ws.readyState && ws.readyState === ws.OPEN){
      if (lastPingTimestamp + TIMEOUT < Date.now()){
        consoleLog('Ping timeout. Terminate websocket.')
        ws.terminate()
      }
    }else{
      consoleLog('Try to connect to main server.')
      connectToMain()
    }
  }, TIMEOUT/2)
})


function updateWorkerLoad(){
  if (workerLoad !== producers.size){
    workerLoad = producers.size
    const msg:MSWorkerUpdateMessage = {
      type:'workerUpdate',
      peer:workerId,
      load:workerLoad
    }
    send(msg, ws)
  }
}

function clearMediasoup(){
  consumers.forEach(c => c.close())
  consumers.clear()
  producers.forEach(p => p.close())
  producers.clear()
  transports.forEach(t => t.close())
  transports.clear()
  updateWorkerLoad()
}

function closeProducer(producer:mediasoup.types.Producer) {
  consoleDebug('closing producer', producer.id, producer.appData);
  //  The mic this session was transcribing is going away (mute-by-close, reconnect, leave).
  if (typeof producer.appData?.peer === 'string'){ sttStopByPeer(producer.appData.peer) }
  try {
    producer.close()
    // remove this producer from our list
    producers.delete(producer.id)
  } catch (e) {
    err(e);
  }
  updateWorkerLoad()
}
function closeConsumer(consumer: mediasoup.types.Consumer) {
  consoleDebug('closing consumer', consumer.id, consumer.appData);
  consumers.delete(consumer.id)
  consumer.close();
}

function send(base: MSMessage, ws: websocket.WebSocket){
  ws.send(JSON.stringify(base))
}

function getIpAddress() {
  const nets = os.networkInterfaces();
  //consoleLog(JSON.stringify(nets))
  for(const key in nets){
    const net = nets[key]?.find(n => n?.internal===false && n?.family === 'IPv4')
    if (net){
      return net.address
    }
  }
  return undefined
}
async function startMediasoup() {
  const worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    consoleError('mediasoup worker died (this should never happen)');
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

