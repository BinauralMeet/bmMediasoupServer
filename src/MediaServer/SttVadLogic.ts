//  Pure logic for stt.ts's speech segmentation, deliberately free of any mediasoup/ffmpeg/network
//  import so it's unit-testable in isolation (same split as DataConnectionQueueLogic.ts on the
//  binaural-meet side). Callers feed it one frame's RMS at a time and act on the events it returns;
//  it never touches audio buffers itself.
//
//  The threshold adapts to the room: a noise floor is tracked while nobody is speaking and speech
//  is anything sufficiently louder than it, so a noisy mic raises its own bar instead of producing
//  one endless "speech" segment. `absMinRms` keeps a dead-silent line from treating its own hiss as
//  speech once the floor decays towards zero.

export interface VadConfig{
  frameMs: number         //  duration one push() represents
  hangoverMs: number      //  silence needed to close a segment
  minSpeechMs: number     //  segments with less speech than this are noise, not utterances
  maxSegmentMs: number    //  force a cut so a long monologue still produces text
  interimMs: number       //  how often to emit 'interim' while a segment is open (0 = never)
  thresholdRatio: number  //  speech when rms > noiseFloor * this
  absMinRms: number       //  ...and also > this, regardless of the floor
  floorAttack: number     //  noise floor adaptation rate (0..1), per silent frame
  warmupMs: number        //  calibrate the floor this long before any segment may open
}

export const defaultVadConfig: VadConfig = {
  frameMs: 20,
  //  Long enough to sit through the pause inside a sentence. Shorter cuts mid-clause, which
  //  costs the recognizer the context it needs -- and context is most of what decides whether a
  //  loanword or a name comes out right.
  hangoverMs: 800,
  minSpeechMs: 200,
  maxSegmentMs: 30 * 1000,
  interimMs: 1500,
  thresholdRatio: 2.5,
  absMinRms: 250,         //  ~ -42dBFS for int16
  floorAttack: 0.05,
  warmupMs: 500,
}

//  'start'   : a segment opened with this frame -- start buffering audio
//  'interim' : the open segment should be re-transcribed now (growing-window re-decode)
//  'end'     : the segment closed. `speechMs` lets the caller drop noise-only blips.
export type VadEvent =
  {type: 'start'} |
  {type: 'interim', durationMs: number} |
  {type: 'end', durationMs: number, speechMs: number, reason: 'silence'|'maxLength'}

export function frameRms(frame: Int16Array): number{
  if (!frame.length){ return 0 }
  let sum = 0
  for (let i = 0; i < frame.length; i += 1){ sum += frame[i] * frame[i] }

  return Math.sqrt(sum / frame.length)
}

export class VadLogic{
  private cfg: VadConfig
  private noiseFloor = 0
  private inSpeech = false
  private durationMs = 0      //  length of the open segment
  private speechMs = 0        //  how much of it was actually speech
  private silenceMs = 0       //  trailing silence within the open segment
  private sinceInterimMs = 0
  private warmedMs = 0        //  audio seen since the session started

  constructor(cfg: Partial<VadConfig> = {}){
    this.cfg = {...defaultVadConfig, ...cfg}
  }

  get config(){ return this.cfg }
  //  For diagnostics: the level speech has to beat right now.
  get threshold(){ return Math.max(this.noiseFloor * this.cfg.thresholdRatio, this.cfg.absMinRms) }
  get speaking(){ return this.inSpeech }

  //  Returns every event this frame produced. A frame can both close a segment and open the next
  //  one only via separate push() calls, so at most one 'start'/'end' is returned per frame.
  push(rms: number): VadEvent[]{
    const cfg = this.cfg
    const isSpeech = rms > Math.max(this.noiseFloor * cfg.thresholdRatio, cfg.absMinRms)
    const events: VadEvent[] = []

    if (!this.inSpeech){
      //  Only adapt the floor while idle. Adapting during speech would let a long utterance
      //  pull the threshold up above itself and cut the speaker off mid-sentence.
      //  The floor starts at 0, so until it has seen `warmupMs` of audio every frame above
      //  absMinRms would look like speech -- a constantly noisy line would open one endless
      //  segment at t=0. Calibrate fast and stay shut during that window instead.
      const warming = this.warmedMs < cfg.warmupMs
      const attack = warming ? Math.max(cfg.floorAttack, 0.3) : cfg.floorAttack
      this.noiseFloor = this.noiseFloor * (1 - attack) + rms * attack
      this.warmedMs += cfg.frameMs
      if (warming){ return events }
      if (isSpeech){
        this.inSpeech = true
        this.durationMs = 0
        this.speechMs = 0
        this.silenceMs = 0
        this.sinceInterimMs = 0
        events.push({type: 'start'})
      }else{
        return events
      }
    }

    this.durationMs += cfg.frameMs
    this.sinceInterimMs += cfg.frameMs
    if (isSpeech){
      this.speechMs += cfg.frameMs
      this.silenceMs = 0
    }else{
      this.silenceMs += cfg.frameMs
    }

    if (this.silenceMs >= cfg.hangoverMs){
      events.push({type: 'end', durationMs: this.durationMs, speechMs: this.speechMs,
        reason: 'silence'})
      this.inSpeech = false

      return events
    }
    if (this.durationMs >= cfg.maxSegmentMs){
      events.push({type: 'end', durationMs: this.durationMs, speechMs: this.speechMs,
        reason: 'maxLength'})
      this.inSpeech = false

      return events
    }
    if (cfg.interimMs > 0 && this.sinceInterimMs >= cfg.interimMs){
      this.sinceInterimMs = 0
      events.push({type: 'interim', durationMs: this.durationMs})
    }

    return events
  }

  //  Close whatever is open (producer paused, session stopping, ...) so the tail of a sentence
  //  still gets transcribed instead of being dropped with the session.
  flush(): VadEvent[]{
    if (!this.inSpeech){ return [] }
    this.inSpeech = false

    return [{type: 'end', durationMs: this.durationMs, speechMs: this.speechMs, reason: 'silence'}]
  }

  //  A segment whose speech was shorter than minSpeechMs is a cough/door/keyboard, not an
  //  utterance -- the caller drops it instead of paying for a transcription.
  isUtterance(ev: {speechMs: number}){
    return ev.speechMs >= this.cfg.minSpeechMs
  }
}
