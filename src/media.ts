import websocket from 'ws'
import * as mediasoup from 'mediasoup'
import debugModule from 'debug'
import {MSCreateTransportMessage, MSMessage, MSMessageType, MSCreateTransportReply, MSRTPCapabilitiesReply,
   MSConnectTransportMessage, MSConnectTransportReply, MSProduceTransportReply, MSProduceTransportMessage, MSPeerMessage, MSConsumeTransportMessage, MSConsumeTransportReply, MSResumeConsumerMessage, MSResumeConsumerReply, MSCloseProducerMessage, MSCloseProducerReply, MSWorkerUpdateMessage} from './MediaMessages'
import * as os from 'os'
import * as dns from 'dns'


interface FqdnAndIp{
  fqdn: string, ip: string
}

function getIpAddress() {
  const nets = os.networkInterfaces();
  const net = nets["en0"]?.find((v) => v.family == "IPv4");
  return !!net ? net.address : null;
}

function getFqdnAndIp(){
  const promise = new Promise<FqdnAndIp>((resolve, reject)=>{
    var h = os.hostname()
    console.log(`hostname: ${h}`)
    dns.lookup(h, { hints: dns.ADDRCONFIG }, function(err, ip) {
      console.log('IP: ' + ip)
      dns.lookupService(ip, 0, function (err, hostname, service) {
        if (err) {
          console.log(err)
          reject()
          return
        }
        //console.log('FQDN: ' + hostname)
        //console.log('Service: ' + service)
        resolve({fqdn:hostname, ip})
      })
    })
  })
  return promise
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


let ws = new websocket.WebSocket(null)
let workerId = ''
let workerLoad = 0
const transports = new Map<string, mediasoup.types.Transport>()
const producers = new Map<string, mediasoup.types.Producer>()
const consumers = new Map<string, mediasoup.types.Consumer>()
const handlers = new Map<MSMessageType, (base:MSMessage, ws:websocket.WebSocket)=>void>()

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
  console.log('closing producer', producer.id, producer.appData);
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
  console.log('closing consumer', consumer.id, consumer.appData);
  consumers.delete(consumer.id)
  consumer.close();
}

function send(base: MSMessage, ws: websocket.WebSocket){
  ws.send(JSON.stringify(base))
}

let hostinfo:FqdnAndIp
//  get host info
getFqdnAndIp().then(info => {
  hostinfo = info
  start()
})

// start mediasoup
function start(){
  console.log('starting mediasoup')
  startMediasoup().then(({worker, router}) => {
    //  set message handlers
    handlers.set('workerAdd',(base)=>{
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
              credentialType:'password'
            },
            {
              urls: `turns:${hostinfo.fqdn}:443`,
              username: 'binauralmeet',
              credential: 'binauralmeet_mediasoup_server',
              credentialType:'password'
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
          if(producer.type === 'simulcast'){
            producer.close()
            console.log(`Simulcast producer ${producer.id} created but closed`)
          }else{
            console.log(`${producer.type} producer ${producer.id} created`)
            producer.on('transportclose', () => {
              console.log('producer\'s transport closed', producer.id);
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
          console.error(`consume-transport: for producer ${msg.producer} failed`)
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
          console.log(`consumer.resume() for ${consumer} succeed.`)
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

    //  function defines which use worker etc.
    function connectToMain(){
      clearMediasoup()
      ws = new websocket.WebSocket(config.mainServer)
      ws.onopen = (ev) => {
        let ip = hostinfo.ip
        if (!ip) ip = 'localhost'
        const msg:MSPeerMessage = {
            type:'workerAdd',
            peer:`${ip}_${worker.pid}`
        }
        console.log(`send ${JSON.stringify(msg)}`)
        send(msg, ws)
      }
      ws.onmessage = (ev)=>{
        const text = ev.data.toString()
        //  console.log(text)
        const base = JSON.parse(text) as MSMessage
        console.log(`${base.type} received from ${(base as any).peer}.`)
        const handler = handlers.get(base.type)
        if (handler){
            handler(base, ws)
        }
      }
      ws.onerror = (ev)=>{
        console.log(`ws error ${ev.message}, state:${ws.readyState}`)
      }
    }

    console.log('connecting to main server');
    setInterval(()=>{
      if (ws.readyState !== ws.OPEN){
        console.log('Try to connect to main server.')
        connectToMain()
      }
    }, 5000)
  })
}