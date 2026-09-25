//  Server-side speech-to-text: turns one peer's audio Producer into SPEECH_* text messages.
//  Design and rationale: the bm workspace doc `stt-translation` (`#audio-tap`, `#vad`).
//
//  The RTP path here is the same one rtsp-streaming uses -- PlainTransport, a paused Consumer and
//  a local UDP port from port.ts -- with ffmpeg decoding to raw PCM instead of pushing RTSP.
//  Audio only ever exists in memory: a bounded ring buffer of recent frames plus the open speech
//  segment. Nothing is written to disk.
import * as mediasoup from 'mediasoup'
import {RtpCapabilities, RtpCodecCapability} from 'mediasoup/node/lib/types'
import {getPort, releasePort} from './port'
import {SttFFmpeg} from './ffmpeg'
import {RtpInfo} from './streaming'
import {VadLogic, frameRms} from './SttVadLogic'
import {SttBackendSelector, SAMPLE_RATE} from './SttBackend'
import {LanguageTally} from './SttLanguage'
import {MSSttStartMessage, MSSttStopMessage, MSSttResultMessage} from './MediaMessages'
import {producers} from '../media'

const config = require('../../config')

//  Set BM_STT_DEBUG=1 to trace why no subtitle appeared: which segments the VAD opened,
//  what the audio actually measured, and which backend answered.
const STT_DEBUG = !!process.env.BM_STT_DEBUG
const sttDebug = STT_DEBUG ? console.log : (..._: any[]) => {}
const sttLog = console.log

const FRAME_MS = 20
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000     //  320
const FRAME_BYTES = FRAME_SAMPLES * 2
//  Speech detected on frame N started slightly before frame N; without this the first consonant
//  of every utterance is clipped, which recognizers handle badly.
const PRE_ROLL_MS = 300
const PRE_ROLL_FRAMES = PRE_ROLL_MS / FRAME_MS

type ResultSender = (msg: MSSttResultMessage) => void
let sendResult: ResultSender = () => {}
//  media.ts owns the websocket to the main server; it injects the sender rather than this module
//  importing the socket, which keeps the RTP/VAD logic independent of how results travel.
export function setSttResultSender(sender: ResultSender){ sendResult = sender }

let selector: SttBackendSelector|undefined
function getSelector(){
  if (!selector){ selector = new SttBackendSelector(config.stt?.backends || []) }

  return selector
}

const sessions = new Map<string, SttSession>()    //  key: peer id (one mic per peer)

function maxSessions(){ return config.stt?.maxSessions || 8 }
function interimMs(){ return config.stt?.interimIntervalMs || 1500 }
function hangoverMs(){ return config.stt?.hangoverMs || 800 }

interface Segment{
  sid: string
  closed: boolean
}

class SttSession{
  readonly peer: string
  readonly room: string
  lang: string
  private producerId = ''
  private transport?: mediasoup.types.PlainTransport
  private consumer?: mediasoup.types.Consumer
  private process?: SttFFmpeg
  private port = -1
  private vad = new VadLogic({frameMs: FRAME_MS, interimMs: interimMs(), hangoverMs: hangoverMs()})
  //  bytes of an incomplete frame left over from the last chunk (ArrayBufferLike: subarray() of a
  //  concat result is not necessarily backed by a plain ArrayBuffer)
  private residual: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private preRoll: Buffer[] = []
  private segmentChunks: Buffer[] = []
  private segment?: Segment
  private seq = 0
  //  One recognition at a time per speaker, finals queued behind each other. Without this the
  //  segments of continuous speech all go out at once and, on a backend that is barely faster
  //  than realtime, every one of them times out -- the speaker gets no subtitle at all precisely
  //  when they are saying the most.
  private work: Promise<void> = Promise.resolve()
  private busy = false
  //  Interim re-decodes are pure overhead on a backend that cannot outrun the speech: they are
  //  discarded anyway (the final overtakes them), but they eat the capacity the finals need.
  private interimWorthTrying = true
  //  Only used when the speaker asked for 'auto': what language this session has settled on.
  private tally = new LanguageTally()
  private stopped = false
  private statFrames = 0
  private statPeak = 0
  private statSum = 0
  private statLoggedAt = 0

  constructor(msg: MSSttStartMessage){
    this.peer = msg.peer
    this.room = msg.room
    this.lang = msg.lang || 'auto'
  }

  async start(router: mediasoup.types.Router, producer: mediasoup.types.Producer){
    this.producerId = producer.id
    const transport = await router.createPlainTransport(config.mediasoup.plainTransport)
    this.transport = transport
    this.port = getPort()
    await transport.connect({ip: '127.0.0.1', port: this.port})

    const codecs: RtpCodecCapability[] = []
    const routerCodec = router.rtpCapabilities.codecs?.find(c => c.kind === 'audio')
    if (routerCodec){ codecs.push(routerCodec) }
    const rtpCapabilities: RtpCapabilities = {codecs}
    const consumer = await transport.consume({producerId: producer.id, rtpCapabilities, paused: true})
    this.consumer = consumer

    const info: RtpInfo = {
      remoteRtpPort: this.port,
      remoteRtcpPort: -1,
      localRtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
      rtpCapabilities,
      rtpParameters: consumer.rtpParameters,
    }
    this.process = new SttFFmpeg(info, SAMPLE_RATE)
    this.process._observer.on('pcm', (chunk: Buffer) => this.onPcm(chunk))
    this.process._observer.on('process-close', () => {
      //  ffmpeg dying must tear the session down rather than leave a transport and a UDP port
      //  leaked behind a session that can never produce text again.
      if (!this.stopped){ this.stop() }
    })
    //  No keyframe loop here (unlike streaming.ts): audio has no keyframes, one resume is enough.
    await consumer.resume()
    sttLog(`stt: session started for peer ${this.peer} (producer ${producer.id}, lang ${this.lang})`)
  }

  private onPcm(chunk: Buffer){
    if (this.stopped){ return }
    const buf = this.residual.length ? Buffer.concat([this.residual, chunk]) : chunk
    let offset = 0
    while (offset + FRAME_BYTES <= buf.length){
      this.onFrame(buf.subarray(offset, offset + FRAME_BYTES))
      offset += FRAME_BYTES
    }
    this.residual = buf.subarray(offset)
  }

  private onFrame(frame: Buffer){
    //  Int16Array over the same bytes, only when the slice is 2-byte aligned; Buffer slices out of
    //  a concat often are not, so copy in that case.
    const samples = frame.byteOffset % 2 === 0
      ? new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES)
      : new Int16Array(Uint8Array.from(frame).buffer)
    const rms = frameRms(samples)
    this.trace(rms)

    if (this.segment && !this.segment.closed){
      this.segmentChunks.push(Buffer.from(frame))
    }else{
      this.preRoll.push(Buffer.from(frame))
      if (this.preRoll.length > PRE_ROLL_FRAMES){ this.preRoll.shift() }
    }

    for (const ev of this.vad.push(rms)){
      if (ev.type === 'start'){
        this.seq += 1
        this.segment = {sid: `${this.peer}-${this.seq}`, closed: false}
        this.segmentChunks = [...this.preRoll, Buffer.from(frame)]
        this.preRoll = []
        sttDebug(`stt: segment ${this.segment.sid} opened`)
      }else if (ev.type === 'interim'){
        this.requestInterim()
      }else if (ev.type === 'end'){
        this.closeSegment(this.vad.isUtterance(ev), false, ev.durationMs)
      }
    }
  }

  //  Nothing here runs unless BM_STT_DEBUG is set. "Audio arrives but no subtitle" has two very
  //  different causes -- silence never reaching the VAD's threshold, or recognition failing --
  //  and telling them apart from the outside is otherwise guesswork.
  private trace(rms: number){
    if (!STT_DEBUG){ return }
    this.statFrames += 1
    this.statSum += rms
    this.statPeak = Math.max(this.statPeak, rms)
    const now = Date.now()
    if (!this.statLoggedAt){ this.statLoggedAt = now }
    if (now - this.statLoggedAt < 2000){ return }
    sttDebug(`stt[${this.peer}]: ${this.statFrames} frames, ` +
      `avg rms ${(this.statSum / this.statFrames).toFixed(0)}, peak ${this.statPeak.toFixed(0)}, ` +
      `speech needs > ${this.vad.threshold.toFixed(0)}, ` +
      `${this.vad.speaking ? 'in speech' : 'idle'}`)
    this.statFrames = 0
    this.statSum = 0
    this.statPeak = 0
    this.statLoggedAt = now
  }

  //  Once the session has settled on a language, tell the recognizer: auto-detection per
  //  utterance is where the flapping comes from, and a told language also recognizes better.
  private hint(){
    return this.lang !== 'auto' ? this.lang : (this.tally.language || 'auto')
  }

  private requestInterim(){
    const segment = this.segment
    //  Skip whenever anything else is already running: a hypothesis that has to wait its turn is
    //  stale by the time it is answered, and the wait is taken from the finals.
    if (!segment || this.busy || !this.interimWorthTrying || !getSelector().configured){ return }
    this.busy = true
    const pcm = Buffer.concat(this.segmentChunks)
    const startedAt = Date.now()
    getSelector().transcribe(pcm, this.hint()).then((res) => {
      this.busy = false
      //  Slower than the audio it transcribed: with this backend the interim can never arrive
      //  before the final it belongs to, so stop paying for them until a faster one takes over.
      const audioMs = pcm.length / 2 / SAMPLE_RATE * 1000
      if (Date.now() - startedAt > audioMs){
        this.interimWorthTrying = false
        sttDebug(`stt: interim results off for ${this.peer} -- the backend is slower than speech`)
      }
      //  Drop a result that lost the race with the segment's final: the client would otherwise
      //  see the finished text replaced by an older, partial hypothesis.
      if (!res || !res.text || segment.closed || this.stopped){ return }
      this.emit(segment.sid, res.text, this.tally.resolve(res.lang), false)
    }).catch(() => { this.busy = false })
  }

  //  `afterStop` is set by the final flush in stop(): the session is already stopped, but this one
  //  last transcription is exactly what stopping must not throw away.
  private closeSegment(isUtterance: boolean, afterStop = false, durationMs = 0){
    const segment = this.segment
    if (!segment){ return }
    //  Stamped now, not when the transcription comes back: this is when the speaking stopped.
    const endedAt = Date.now()
    segment.closed = true
    this.segment = undefined
    const pcm = Buffer.concat(this.segmentChunks)
    this.segmentChunks = []
    if (!isUtterance){
      sttDebug(`stt: segment ${segment.sid} dropped (too short to be speech)`)

      return
    }
    if (!getSelector().configured){ return }
    //  Queued, not fired: finals wait for each other instead of competing, so a backend that is
    //  only just fast enough still answers all of them.
    this.work = this.work.then(async () => {
      this.busy = true
      try{
        const res = await getSelector().transcribe(pcm, this.hint())
        if (!res || !res.text || (this.stopped && !afterStop)){ return }
        //  Finals are the evidence: interim text is provisional and often shorter.
        this.tally.add(res.lang, res.text)
        this.emit(segment.sid, res.text, this.tally.resolve(res.lang), true, durationMs, endedAt)
      }catch(e: any){
        sttDebug(`stt: final transcription failed: ${e?.message}`)
      }finally{
        this.busy = false
      }
    })
  }

  //  durationMs travels with the final result so clients can tell continuous speech from a
  //  pause: recognition lags by seconds, so arrival times say nothing about the speech itself.
  private emit(sid: string, text: string, lang: string, final: boolean, durationMs = 0, ts = 0){
    sendResult({type: 'sttResult', peer: this.peer, room: this.room, sid, text, lang, final,
      durationMs, ts})
  }

  stop(){
    if (this.stopped){ return }
    this.stopped = true
    //  Transcribe whatever was still open so the tail of a sentence is not lost with the session.
    for (const ev of this.vad.flush()){
      if (ev.type === 'end' && this.vad.isUtterance(ev)){
        this.closeSegment(true, true, ev.durationMs)
      }
    }
    this.process?.kill()
    this.consumer?.close()
    this.transport?.close()
    if (this.port >= 0){ releasePort(this.port) }
    sessions.delete(this.peer)
    sttLog(`stt: session stopped for peer ${this.peer}`)
  }
}

//  Returns an error string when the request was refused, undefined when it was accepted.
export function sttStart(router: mediasoup.types.Router, msg: MSSttStartMessage): string|undefined{
  sttStop({type: 'sttStop', peer: msg.peer, room: msg.room})    //  restart is a stop + start
  if (!getSelector().configured){ return 'stt is not configured on this server' }
  if (sessions.size >= maxSessions()){ return 'too many stt sessions on this server' }

  const producerId = msg.producers?.[0]
  const producer = producerId ? producers.get(producerId) : undefined
  if (!producer){ return 'producer not found' }
  if (producer.kind !== 'audio'){ return 'producer is not audio' }
  //  Transcribing someone else's microphone is eavesdropping, so unlike streamingStart (see
  //  `bmMediasoupServer-rtsp-streaming#security`) the owner is checked here.
  if (producer.appData?.peer !== msg.peer){ return 'producer does not belong to the peer' }

  const session = new SttSession(msg)
  sessions.set(msg.peer, session)
  session.start(router, producer).catch((e) => {
    console.error(`stt: failed to start session for ${msg.peer}:`, e)
    session.stop()
  })

  return undefined
}

export function sttStop(msg: MSSttStopMessage){
  sessions.get(msg.peer)?.stop()
}

//  Called when the peer or its producer goes away: the session owns a UDP port and an ffmpeg
//  process, neither of which the mediasoup teardown would release on its own.
export function sttStopByPeer(peer: string){
  sessions.get(peer)?.stop()
}
