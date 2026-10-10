import {MSStreamingStartMessage, MSStreamingStopMessage} from './MediaMessages'
import {FFmpeg} from './ffmpeg'
import {GStreamer} from './gstreamer'
import {getPort, releasePort} from './port'
import * as mediasoup from 'mediasoup'
import { producers } from '../media';
import { assert } from 'console'
import { RtpCapabilities, RtpCodecCapability } from 'mediasoup/node/lib/types'

const config = require('../../config');
//console.log(JSON.stringify(config))

const PROCESS_NAME:string = 'FFmpeg'
const SERVER_PORT = 3030
export interface RtpInfo{
  remoteRtpPort:number
  remoteRtcpPort:number
  localRtcpPort?:number
  rtpCapabilities:mediasoup.types.RtpCapabilities
  rtpParameters: mediasoup.types.RtpParameters
}
export interface RtpInfos{
  audio?: RtpInfo
  video?: RtpInfo
  fileName: string
}
class Streamer {
  peer: string
  id: string
  remotePorts: number[] = []
  transports: mediasoup.types.PlainTransport[] = []
  consumers: mediasoup.types.Consumer[] = []
  process?: FFmpeg | GStreamer
  infos: RtpInfos
  constructor(msg:MSStreamingStartMessage){
    this.peer = msg.peer
    this.id = msg.id
    this.infos = {fileName: msg.id}
  }
  //  Re-sends resume + key frame to the consumers every few seconds while streaming.
  keyFrameTimer?: NodeJS.Timeout
  removed = false
  remove(){
    //  Without this the timer outlived the stream and kept resuming its closed consumers forever:
    //  one more such timer per stream ever started, ~300 failing resumes a second after a month
    //  of normal use on vrc.jp (bm workspace CHANGELOG, 2026-10-10).
    if (this.keyFrameTimer){ clearInterval(this.keyFrameTimer); this.keyFrameTimer = undefined }
    this.removed = true
    //  Keyed by stream id (see streamingStart); deleting by peer id left every stream in the map.
    if (streamers.get(this.id) === this){ streamers.delete(this.id) }
    for(const port of this.remotePorts){ releasePort(port) }
    this.consumers.forEach(c => c.close())
    this.transports.forEach(t => t.close())
    this.process?.kill()
  }
}
const streamers = new Map<string, Streamer>()

function getProcess(recordInfo:RtpInfos){
  switch (PROCESS_NAME) {
    case 'GStreamer':
      return new GStreamer(recordInfo);
    case 'FFmpeg':
    default:
      return new FFmpeg(recordInfo);
  }
}

export function streamingStart(router: mediasoup.types.Router, msg: MSStreamingStartMessage){
  const streamerOld = streamers.get(msg.id)
  if (streamerOld){
    streamerOld.remove()
  }
  const streamer = new Streamer(msg)
  streamers.set(msg.id, streamer)
  const ps = msg.producers.map(pid => producers.get(pid)) as mediasoup.types.Producer[]
  let count = ps.length
  ps.forEach(producer => {
    publishProducer(streamer, router, producer).then(() => {
      count--
      //  Stopped (or replaced) while its producers were still being published: start nothing.
      if (count === 0 && !streamer.removed){
        streamer.process = getProcess(streamer.infos);
        streamer.process._observer.on('process-close', () => {
          streamer.remove()
        })
        streamer.keyFrameTimer = setInterval(()=>{
          for (const consumer of streamer.consumers) {
            if (consumer.closed){ continue }
            //  request key frame every 3 seconds.
            consumer.resume().then(()=>{
              consumer.requestKeyFrame()
            }).catch(() => { /* closed in the meantime; remove() clears this timer */ })
          }
        }, 3*1000)
      }
    }).catch(() => {
      //  publishProducer logged why; leave nothing half-built behind.
      streamer.remove()
    })
  })
}
export function streamingStop(router: mediasoup.types.Router, msg: MSStreamingStopMessage){
  const streamer = streamers.get(msg.id)
  if (streamer){
    streamer.remove()
  }
}

export function publishProducer(streamer:Streamer, router:mediasoup.types.Router, producer:mediasoup.types.Producer){
  //console.log(`publishProducer(${producer.kind})`);
  const promise = new Promise<undefined>((resolve, reject)=>{
    //  Each step used to fail silently -- the stream simply never started, with nothing logged.
    const fail = (step: string) => (e: any) => {
      console.error(`streaming: ${step} for ${producer.kind} producer ${producer.id} failed: ${e?.message ?? e}`)
      reject(e)
    }
    // Create the mediasoup RTP Transport used to send media to the GStreamer process
    const rtpTransportConfig = config.mediasoup.plainTransport;

    // If the process is set to GStreamer set rtcpMux to false
    if (PROCESS_NAME === 'GStreamer') {
      rtpTransportConfig.rtcpMux = false;
    }

    //console.log(`createPlainTransport( ${JSON.stringify(rtpTransportConfig)} )`)
    router.createPlainTransport(rtpTransportConfig).then(rtpTransport=>{
      // Set the receiver RTP ports
      const remoteRtpPort = getPort()
      streamer.remotePorts.push(remoteRtpPort)

      let remoteRtcpPort = -1
      // If rtpTransport rtcpMux is false also set the receiver RTCP ports
      if (!rtpTransportConfig.rtcpMux) {
        remoteRtcpPort = getPort();
        streamer.remotePorts.push(remoteRtcpPort);
      }

      // Connect the mediasoup RTP transport to the ports used by GStreamer
      //console.log(`rtpTransport.connect()`)
      //  rtcpPort only without rtcp-mux: mediasoup 3.19 rejects it otherwise ("cannot set rtcpPort
      //  with rtcpMux enabled"), which broke every stream after the upgrade from 3.11 (2026-10-10).
      rtpTransport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        ...(rtpTransportConfig.rtcpMux ? {} : {rtcpPort: remoteRtcpPort}),
      }).then(()=>{
        //console.log(`streamer.transports.push(${JSON.stringify(rtpTransport)})`)
        streamer.transports.push(rtpTransport)

        // Start the consumer paused
        // Once the gstreamer process is ready to consume resume and send a keyframe
        const codecs:RtpCodecCapability[] = [];
        // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
        const routerCodec = router.rtpCapabilities.codecs?.find(
          codec => codec.kind === producer.kind && (producer.kind!=='video' || codec.mimeType==='video/H264')
        )
        if (routerCodec) codecs.push(routerCodec)

        const rtpCapabilities:RtpCapabilities = {
          codecs,
        }
        rtpTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true
        }).then((rtpConsumer)=>{
          //console.log(`streamer.consumers.push(${JSON.stringify(rtpConsumer)})`)
          streamer.consumers.push(rtpConsumer)
          const info:RtpInfo = {
            remoteRtpPort,
            remoteRtcpPort,
            localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
            rtpCapabilities,
            rtpParameters: rtpConsumer.rtpParameters
          }
          if (producer.kind === 'audio'){
            streamer.infos.audio = info
          }else if (producer.kind === 'video'){
            streamer.infos.video = info
          }else{
            assert(false)
          }
          resolve(undefined)
        }).catch(fail('consume'))
      }).catch(fail('plainTransport.connect'))
    }).catch(fail('createPlainTransport'))
  })
  return promise
}
