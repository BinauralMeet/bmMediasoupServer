import websocket from 'ws'
import * as mediasoup from 'mediasoup'
import debugModule from 'debug'
import {MSCreateTransportMessage, MSMessage, MSMessageType, MSCreateTransportReply, MSRTPCapabilitiesReply,
   MSConnectTransportMessage, MSConnectTransportReply, MSProduceTransportReply, MSProduceTransportMessage,
   MSPeerMessage, MSConsumeTransportMessage, MSConsumeTransportReply, MSResumeConsumerMessage,
   MSResumeConsumerReply, MSCloseProducerMessage, MSCloseProducerReply, MSWorkerUpdateMessage,
   MSStreamingStartMessage, MSStreamingStopMessage} from './MediaServer/MediaMessages'
import * as os from 'os'
import {streamingStart, streamingStop} from './MediaServer/streaming'

const log = debugModule('bmMsE');
const warn = debugModule('bmMsE:WARN');
const err = debugModule('bmMsE:ERROR');
const config = require('../config');

//  const consoleDebug = console.debug
const consoleDebug = (... arg:any[]) => {}
const consoleLog = console.log
const consoleError = console.log

let ws = new websocket.WebSocket(null)
let workerId = ''
let workerLoad = 0
const transports = new Map<string, mediasoup.types.Transport>()
export const producers = new Map<string, mediasoup.types.Producer>()
const consumers = new Map<string, mediasoup.types.Consumer>()
const handlers = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()

const fqdn = os.hostname()
const hostinfo={
  fqdn,
  name:fqdn.substring(0, fqdn.indexOf('.')),
  ip:getIpAddress()
}

// start mediasoup
consoleLog('starting mediasoup')
startMediasoup().then(({worker, router}) => {
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
    const {
      listenIps,
      initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport
    if (listenIps.length === 0){
      let ip = hostinfo.ip
      if (!ip) ip = '127.0.0.1'
      listenIps.push({ ip, announcedIp: null })
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
            urls: `turn:${hostinfo.fqdn}`,
            username: 'binauralmeet',
            credential: 'binauralmeet_mediasoup_server',
          },
          {
            urls: `turns:${hostinfo.fqdn}:443`,
            username: 'binauralmeet',
            credential: 'binauralmeet_mediasoup_server',
          },
        ]
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
        consoleError(`connect-transport: server-side transport ${msg.transport} not found`)
        sendMsg.error = `server-side transport ${msg.transport} not found`
        send(sendMsg, ws)
      }else{
        transport.connect({dtlsParameters: msg.dtlsParameters}).then(()=>{
          send(sendMsg, ws)
        })
      }
    } catch (e) {
      consoleError('error in /signaling/connect-transport', e);
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
        consoleError(`consume-transport: for producer ${msg.producer} failed`)
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

  //  handler for streaming
  handlers.set('streamingStart',(base, ws)=>{
    const msg = base as MSStreamingStartMessage
    streamingStart(router, msg)
  })
  handlers.set('streamingStop',(base, ws)=>{
    const msg = base as MSStreamingStopMessage
    streamingStop(router, msg)
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
      send(msg, ws)
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
  }

  consoleLog('connecting to main server');
  setInterval(()=>{
    if (ws.readyState !== ws.OPEN){
      consoleLog('Try to connect to main server.')
      connectToMain()
    }
  }, 5000)
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

