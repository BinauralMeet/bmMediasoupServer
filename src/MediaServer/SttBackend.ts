//  Speech-to-text backends and the selector that decides which one to use for each utterance.
//  See the workspace doc `stt-translation#stt-backend` / `#fallback` for the design and for why
//  this never takes a GPU lock.
//
//  Every backend speaks the same tiny HTTP contract, so adding one is a config entry, not code:
//    POST <endpoint>?lang=<hint>   body: a 16kHz mono 16-bit WAV      -> {"text": "...", "lang": "ja"}
//  A backend that sits on a shared GPU additionally names a `gpuStatus` base URL whose
//  `GET <gpuStatus>/lock/status` returns `{"locked": bool}`; we only ever read it.
import axios from 'axios'

//  Local, like media.ts's own helpers: MainServer/utils.ts opens a log file at import time,
//  which has no business happening in the media worker process.
const STT_DEBUG = false
const sttDebug = STT_DEBUG ? console.debug : (..._: any[]) => {}
const sttLog = console.log

export interface SttBackendConfig{
  kind: string                //  free-form label used in logs ('sensevoice', 'cpuWhisper', ...)
  endpoint: string            //  POST target for transcription
  gpuStatus?: string          //  base URL of the GPU's switch/lock API, when it shares a GPU
  gpuMode?: string            //  the mode that runs this recognizer; switched into when idle
  timeoutMs?: number
  headers?: {[key: string]: string}
  apiKeyEnv?: string          //  env var holding a bearer token (keys never live in config.js)
}

export interface SttResult{
  text: string
  lang: string
}

export const SAMPLE_RATE = 16000

//  ---------------------------------------------------------------- pure helpers (unit-tested)

//  Wraps raw 16kHz mono s16le PCM in a WAV header. Sidecars accept a file far more often than a
//  naked byte stream, and a 44-byte header is cheaper than making every backend agree on
//  sample rate/endianness out of band.
export function wavFromPcm16(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = 1): Buffer{
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)          //  PCM fmt chunk size
  header.writeUInt16LE(1, 20)           //  format = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32)//  block align
  header.writeUInt16LE(16, 34)          //  bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

export interface BreakerConfig{
  failuresToOpen: number
  openMs: number
}
export const defaultBreakerConfig: BreakerConfig = {failuresToOpen: 3, openMs: 60 * 1000}

export interface BreakerState{
  failures: number
  openUntil: number
}
export function newBreakerState(): BreakerState{ return {failures: 0, openUntil: 0} }

//  A backend that failed `failuresToOpen` times in a row is skipped for `openMs`. The next
//  utterance after that tries it again, which is what lets a meeting recover to the GPU backend
//  on its own once the GPU frees up -- nothing else ever re-enables it.
export function breakerShouldSkip(state: BreakerState, now: number){
  return now < state.openUntil
}
export function breakerOnSuccess(state: BreakerState): BreakerState{
  return {failures: 0, openUntil: 0}
}
export function breakerOnFailure(state: BreakerState, now: number,
  cfg: BreakerConfig = defaultBreakerConfig): BreakerState{
  const failures = state.failures + 1

  return {failures, openUntil: failures >= cfg.failuresToOpen ? now + cfg.openMs : state.openUntil}
}

//  ---------------------------------------------------------------- backends

export interface SttBackend{
  readonly name: string
  //  Cheap pre-check. False means "someone else is using the GPU" -- not an error, just skip.
  usable(): Promise<boolean>
  transcribe(pcm: Buffer, lang: string): Promise<SttResult>
}

const LOCK_STATUS_CACHE_MS = 10 * 1000
//  Switching modes restarts a service and reloads a model, so asking again a few seconds later
//  achieves nothing but noise. One attempt, then leave the GPU alone for a while.
const ACTIVATE_RETRY_MS = 3 * 60 * 1000

export class HttpSttBackend implements SttBackend{
  readonly name: string
  private cfg: SttBackendConfig
  private lockCheckedAt = 0
  private lockedCached = false
  private activatedAt = 0

  constructor(cfg: SttBackendConfig){
    this.cfg = cfg
    this.name = cfg.kind
  }

  private get headers(){
    const headers: {[key: string]: string} = {...(this.cfg.headers || {})}
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined
    if (key){ headers.Authorization = `Bearer ${key}` }

    return headers
  }

  //  Reads the GPU's lock state; never acquires it. A lock means somebody is working there, so
  //  we stay out of the way entirely. If the status endpoint itself is unreachable we assume
  //  usable and let the transcribe call be the real test -- a monitoring endpoint being down is
  //  not a reason to refuse a GPU that may well be idle.
  async usable(){
    if (!this.cfg.gpuStatus){ return true }
    const now = Date.now()
    if (now - this.lockCheckedAt < LOCK_STATUS_CACHE_MS){ return !this.lockedCached }
    this.lockCheckedAt = now
    try{
      const res = await axios.get(`${this.cfg.gpuStatus}/lock/status`,
        {timeout: 2000, headers: this.headers})
      this.lockedCached = !!res.data?.locked
      if (this.lockedCached){
        sttDebug(`stt: ${this.name} skipped, GPU locked by someone else`)

        return false
      }
    }catch(e){
      this.lockedCached = false
    }

    return this.cfg.gpuMode ? await this.modeReady(now) : true
  }

  //  With nobody holding the lock, the GPU is fair game: if it is running something else, ask it
  //  to switch to the mode this recognizer lives in. The switch restarts a service and loads a
  //  model, which takes far longer than an utterance can wait, so this one goes to the next
  //  backend and the switch pays off for the ones after it.
  private async modeReady(now: number){
    let active: string[] = []
    try{
      const res = await axios.get(`${this.cfg.gpuStatus}/status`, {timeout: 2000, headers: this.headers})
      active = Array.isArray(res.data?.active_modes) ? res.data.active_modes : []
    }catch(e){
      //  Same reasoning as the lock check: a status endpoint that will not answer is not
      //  evidence about the GPU, so let transcribe() find out.
      return true
    }
    if (active.indexOf(this.cfg.gpuMode!) >= 0){ return true }
    if (now - this.activatedAt < ACTIVATE_RETRY_MS){ return false }
    this.activatedAt = now
    try{
      await axios.post(`${this.cfg.gpuStatus}/activate/${this.cfg.gpuMode}`, undefined,
        {timeout: 5000, headers: this.headers})
      //  Worth a plain log, not a debug one: this stops whatever else was using that GPU.
      sttLog(`stt: asked the GPU to switch to '${this.cfg.gpuMode}' ` +
        `(was ${active.length ? active.join(',') : 'idle'}) for backend '${this.name}'`)
    }catch(e: any){
      sttDebug(`stt: could not switch the GPU to '${this.cfg.gpuMode}': ${e?.message}`)
    }

    return false
  }

  async transcribe(pcm: Buffer, lang: string): Promise<SttResult>{
    //  'auto' is BM's own word for "no hint" -- it is not a language code, and a recognizer
    //  handed it as one errors out. The contract is an absent/empty `lang` (see the sidecar's
    //  own docstring), so send nothing at all in that case.
    const hint = lang && lang !== 'auto' ? lang : ''
    const res = await axios.post(this.cfg.endpoint, wavFromPcm16(pcm), {
      params: hint ? {lang: hint} : {},
      timeout: this.cfg.timeoutMs || 3000,
      headers: {...this.headers, 'Content-Type': 'audio/wav'},
      maxBodyLength: Infinity,
    })
    const text = typeof res.data?.text === 'string' ? res.data.text : ''
    //  With no hint, what the recognizer detected is the only source of the language, and
    //  translation needs it: falling back to 'auto' here would make every utterance untranslatable
    //  (collectTargetLangs() treats an unknown source language as "do not translate").
    const detected = typeof res.data?.lang === 'string' ? res.data.lang.trim() : ''

    return {text: text.trim(), lang: detected || hint}
  }
}

//  ---------------------------------------------------------------- selector

export interface SelectorResult extends SttResult{
  backend: string
}

export class SttBackendSelector{
  private backends: SttBackend[]
  private states: BreakerState[]
  private breakerCfg: BreakerConfig
  private lastUsed = ''

  constructor(configs: SttBackendConfig[], breakerCfg: BreakerConfig = defaultBreakerConfig,
    make: (cfg: SttBackendConfig) => SttBackend = cfg => new HttpSttBackend(cfg)){
    this.backends = configs.map(make)
    this.states = configs.map(() => newBreakerState())
    this.breakerCfg = breakerCfg
  }

  get configured(){ return this.backends.length > 0 }

  //  Tries each backend in priority order and returns the first result. Returns undefined when
  //  every backend is skipped or failing -- the caller drops the utterance and the call itself
  //  is unaffected (STT is the only thing that degrades).
  async transcribe(pcm: Buffer, lang: string): Promise<SelectorResult|undefined>{
    const now = Date.now()
    for (let i = 0; i < this.backends.length; i += 1){
      const backend = this.backends[i]
      if (breakerShouldSkip(this.states[i], now)){ continue }
      try{
        if (!await backend.usable()){ continue }
        const result = await backend.transcribe(pcm, lang)
        this.states[i] = breakerOnSuccess(this.states[i])
        //  Log only transitions: a meeting that silently drops from GPU to CPU changes its
        //  recognition quality with nothing else to show for it (`stt-translation#limits`).
        if (this.lastUsed !== backend.name){
          sttLog(`stt: using backend '${backend.name}'` +
            (this.lastUsed ? ` (was '${this.lastUsed}')` : ''))
          this.lastUsed = backend.name
        }

        return {...result, backend: backend.name}
      }catch(e: any){
        this.states[i] = breakerOnFailure(this.states[i], now, this.breakerCfg)
        sttDebug(`stt: backend '${backend.name}' failed: ${e?.message}`)
      }
    }

    return undefined
  }
}
