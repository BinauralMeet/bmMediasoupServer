import {MSStartStreamingMessage} from './MediaMessages'
import {FFmpeg} from './ffmpeg'
import {GStreamer} from './gstreamer'
import {getPort, releasePort} from './port'
import * as mediasoup from 'mediasoup'
import { producers } from '../media';
import { Producer } from 'mediasoup/node/lib/Producer';

const config = require('../../config');

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
  remotePorts: number[] = []
  transports: mediasoup.types.PlainTransport[] = []
  consumers: mediasoup.types.Consumer[] = []
  process?: FFmpeg | GStreamer
  info?: RtpInfo
  constructor(peer_: string){
    this.peer = peer_
  }
  remove(){
    streamers.delete(this.peer)
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

export function streamingStart(router: mediasoup.types.Router, msg: MSStartStreamingMessage){
  const streamerOld = streamers.get(msg.peer)
  if (streamerOld){
    streamerOld.remove()
  }

  const ps:Producer[] = msg.producers.map(pid => producers.get(pid)).filter(p => p) as Producer[]
  ps.forEach(producer => {
    publishProducerRtpStream(msg.peer, router, producer).then(streamer => {
      streamers.set(msg.peer, streamer)
    })
  })
}
export function streamingStop(router: mediasoup.types.Router, msg: MSStartStreamingMessage){
  const streamer = streamers.get(msg.peer)
  if (streamer){
    streamer.remove()
  }
}

export function publishProducerRtpStream(peer:string, router:mediasoup.types.Router, producer:mediasoup.types.Producer){
  console.log(`publishProducerRtpStream(${producer.kind})`);
  const promise = new Promise<Streamer>((resolve, reject)=>{
    // Create the mediasoup RTP Transport used to send media to the GStreamer process
    const rtpTransportConfig = config.plainTransport;

    // If the process is set to GStreamer set rtcpMux to false
    if (PROCESS_NAME === 'GStreamer') {
      rtpTransportConfig.rtcpMux = false;
    }

    router.createPlainTransport(rtpTransportConfig).then(rtpTransport=>{
      // Set the receiver RTP ports
      const remoteRtpPort = getPort();
      const streamer = new Streamer(peer)
      streamer.remotePorts.push(remoteRtpPort);

      let remoteRtcpPort = -1
      // If rtpTransport rtcpMux is false also set the receiver RTCP ports
      if (!rtpTransportConfig.rtcpMux) {
        remoteRtcpPort = getPort();
        streamer.remotePorts.push(remoteRtcpPort);
      }

      // Connect the mediasoup RTP transport to the ports used by GStreamer
      rtpTransport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        rtcpPort: remoteRtcpPort
      }).then(()=>{
        streamer.transports.push(rtpTransport)
        // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
        const routerCodec = router.rtpCapabilities.codecs?.find(codec => codec.kind === producer.kind)
        const rtpCapabilities: mediasoup.types.RtpCapabilities = {
          codecs:[routerCodec!],
        };
        // Start the consumer paused
        // Once the gstreamer process is ready to consume resume and send a keyframe
        rtpTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true
        }).then((rtpConsumer)=>{
          streamer.consumers.push(rtpConsumer)
          streamer.info = {
            remoteRtpPort,
            remoteRtcpPort,
            localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
            rtpCapabilities,
            rtpParameters: rtpConsumer.rtpParameters
          }
          resolve(streamer)
        })
      })
    })
  })
  return promise
}
