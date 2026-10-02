//  Speech-to-text backends and the selector that decides which one to use for each utterance.
//  See the workspace doc `stt-translation#stt-backend` / `#fallback` for the design and for why
//  this never takes a GPU lock.
//
//  Every backend takes a 16kHz mono WAV and answers with JSON holding a `text` field; the
//  details around that differ per service and are configuration, not code:
//    POST <endpoint>?<langParam>=<hint>   raw WAV body, or multipart `file` with `upload`
//    -> {"text": "...", "lang"|"language": "ja"}
//  bm/stt-sidecars takes a raw body and `lang`, and treats an absent value as "detect it";
//  SenseVoice takes multipart and `language`, for which "auto" is a valid value.
//  A backend that sits on a shared GPU additionally names a `gpuStatus` base URL whose
//  `GET <gpuStatus>/lock/status` returns `{"locked": bool}`; we only ever read it.
import axios from 'axios'
import {guessLang} from './SttLanguage'
import {GpuLockReader, GPU_API_TIMEOUT_MS, groupIntoRungs, orderPool} from './GpuPool'

//  Local, like media.ts's own helpers: MainServer/utils.ts opens a log file at import time,
//  which has no business happening in the media worker process.
//  Set BM_STT_DEBUG=1 to trace why no subtitle appeared: which segments the VAD opened,
//  what the audio actually measured, and which backend answered.
const STT_DEBUG = !!process.env.BM_STT_DEBUG
const sttDebug = STT_DEBUG ? console.log : (..._: any[]) => {}
const sttLog = console.log

export interface SttBackendConfig{
  kind: string                //  free-form label used in logs ('sensevoice', 'cpuWhisper', ...)
  name?: string               //  label in logs when several entries share a kind (default: kind)
  pool?: string               //  entries naming the same pool are one rung, load-balanced (GpuPool.ts)
  endpoint: string            //  POST target for transcription
  gpuStatus?: string          //  base URL of the GPU's switch/lock API, when it shares a GPU
  gpuMode?: string            //  the mode that runs this recognizer; switched into when idle
  upload?: 'raw' | 'multipart'//  how the audio is sent (default: raw body)
  langParam?: string          //  query parameter carrying the language hint (default: 'lang')
  langAuto?: string           //  what to send for "detect it"; omitted from the request if unset
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

//  SenseVoice marks events and emotions inline with emoji (\ud83c\udfbc for music, faces for
//  emotion). They are not words anybody said, they make no sense in a subtitle, and a translator
//  handed them produces nonsense, so they come out before anything else sees the text.
export function stripEventTags(text: string){
  return text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim()
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
  //  Gets the backend ready before anyone speaks (stt-translation#warmup). Optional: a backend
  //  with nothing to warm simply lacks it.
  warmUp?(): Promise<void>
}

//  A warm-up is one throwaway request; doing it again within this window would only add load.
//  It also absorbs the burst of sttStarts when a room turns subtitles on (one per participant).
export const WARM_INTERVAL_MS = 5 * 60 * 1000

//  One second of faint noise: enough for a recognizer to run its encoder and a few decoder
//  steps. Whatever it "hears" is discarded.
export function warmUpPcm(): Buffer{
  const pcm = Buffer.alloc(SAMPLE_RATE * 2)
  let seed = 1
  for (let i = 0; i < SAMPLE_RATE; i += 1){
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pcm.writeInt16LE((seed % 64) - 32, i * 2)
  }

  return pcm
}

//  Switching modes restarts a service and reloads a model, so asking again a few seconds later
//  achieves nothing but noise. One attempt, then leave the GPU alone for a while.
const ACTIVATE_RETRY_MS = 3 * 60 * 1000

export class HttpSttBackend implements SttBackend{
  readonly name: string
  private cfg: SttBackendConfig
  private lock?: GpuLockReader
  private activatedAt = 0
  private warmedAt = 0

  constructor(cfg: SttBackendConfig){
    this.cfg = cfg
    this.name = cfg.name || cfg.kind
    if (cfg.gpuStatus){ this.lock = new GpuLockReader(cfg.gpuStatus, () => this.headers) }
  }

  private get headers(){
    const headers: {[key: string]: string} = {...(this.cfg.headers || {})}
    const key = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined
    if (key){ headers.Authorization = `Bearer ${key}` }

    return headers
  }

  //  Reads the GPU's lock state; never acquires it. A lock means somebody is working there, so
  //  we stay out of the way entirely (GpuLockReader: an unreadable lock counts as free).
  async usable(){
    if (!this.lock){ return true }
    const now = Date.now()
    if (await this.lock.locked(now)){
      sttDebug(`stt: ${this.name} skipped, GPU locked by someone else`)

      return false
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
      const res = await axios.get(`${this.cfg.gpuStatus}/status`,
        {timeout: GPU_API_TIMEOUT_MS, headers: this.headers})
      active = Array.isArray(res.data?.active_modes) ? res.data.active_modes : []
    }catch(e){
      //  Unlike the lock check, an unanswered status is a reason to skip: this backend only
      //  exists while its mode runs, and finding out by posting audio costs a whole timeout
      //  out of an utterance's budget, every utterance.
      sttDebug(`stt: ${this.name} skipped, cannot read the GPU's mode`)

      return false
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

  //  Only GPU backends are warmed: they are the ones that may be in another mode (switching takes
  //  a model load, far longer than an utterance) or freshly started. usable() is the gate, so the
  //  rules of `#fallback` hold here too: a locked GPU is left alone, an idle one in another mode
  //  is asked to switch (at most once per ACTIVATE_RETRY_MS) -- its recognizer warms itself up
  //  when it starts -- and one already in our mode gets a throwaway request.
  async warmUp(){
    if (!this.lock){ return }
    const now = Date.now()
    if (now - this.warmedAt < WARM_INTERVAL_MS){ return }
    this.warmedAt = now
    try{
      if (!await this.usable()){ return }
      await this.transcribe(warmUpPcm(), 'ja')
      sttDebug(`stt: warmed up backend '${this.name}' in ${Date.now() - now}ms`)
    }catch(e: any){
      sttDebug(`stt: warm-up of '${this.name}' failed: ${e?.message}`)
    }
  }

  async transcribe(pcm: Buffer, lang: string): Promise<SttResult>{
    //  'auto' is BM's own word for "no hint". Some recognizers accept a word for that and some
    //  error out on anything that is not a language code, so it is per-backend whether to send
    //  something or nothing at all.
    const hint = lang && lang !== 'auto' ? lang : ''
    const param = this.cfg.langParam || 'lang'
    const value = hint || this.cfg.langAuto || ''
    const wav = wavFromPcm16(pcm)
    let body: any = wav
    const headers: {[key: string]: string} = {...this.headers}
    if (this.cfg.upload === 'multipart'){
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], {type: 'audio/wav'}), 'audio.wav')
      body = form   //  axios fills in the boundary itself
    }else{
      headers['Content-Type'] = 'audio/wav'
    }
    const res = await axios.post(this.cfg.endpoint, body, {
      params: value ? {[param]: value} : {},
      timeout: this.cfg.timeoutMs || 3000,
      headers,
      maxBodyLength: Infinity,
    })
    const text = stripEventTags(typeof res.data?.text === 'string' ? res.data.text : '')
    //  With no hint, what the recognizer detected is the only source of the language, and
    //  translation needs it: falling back to 'auto' here would make every utterance untranslatable
    //  (collectTargetLangs() treats an unknown source language as "do not translate"). Some
    //  services echo the request's "auto" back instead of naming what they heard -- that is the
    //  same as not knowing.
    const reported = res.data?.lang ?? res.data?.language
    const detected = typeof reported === 'string' && reported.trim() !== 'auto' ? reported.trim() : ''

    return {text, lang: detected || hint || guessLang(text)}
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
  private rungs: number[][]
  private labels: string[]      //  what transition logs name: the pool, or the backend itself
  private inFlight: number[]
  private rotation = 0
  private lastUsed = ''

  constructor(configs: SttBackendConfig[], breakerCfg: BreakerConfig = defaultBreakerConfig,
    make: (cfg: SttBackendConfig) => SttBackend = cfg => new HttpSttBackend(cfg)){
    this.backends = configs.map(make)
    this.states = configs.map(() => newBreakerState())
    this.breakerCfg = breakerCfg
    this.rungs = groupIntoRungs(configs.map(c => c.pool))
    this.labels = configs.map((c, i) => c.pool ? `pool ${c.pool}` : this.backends[i].name)
    this.inFlight = configs.map(() => 0)
  }

  get configured(){ return this.backends.length > 0 }

  //  Warms every backend at once (each decides for itself whether it needs it and whether it may
  //  touch its GPU). Never throws and never blocks STT: callers fire and forget.
  async warmUp(){
    await Promise.all(this.backends.map(b => b.warmUp?.().catch(() => {})))
  }

  //  A rung's members in the order to try them. A lone backend is simply itself; a pool keeps
  //  only its free members (all checked at once, so a machine that is merely idle in another
  //  mode gets asked to switch even while its sibling answers) and puts the least busy first.
  private async candidates(rung: number[], now: number): Promise<number[]>{
    const open = rung.filter(i => !breakerShouldSkip(this.states[i], now))
    if (rung.length === 1){ return open }
    const usable = await Promise.all(open.map(i => this.backends[i].usable().catch(() => false)))
    const free = open.filter((_, k) => usable[k])
    this.rotation += 1

    return orderPool(free, this.inFlight, this.rotation)
  }

  //  Tries each rung in priority order and returns the first result. Returns undefined when
  //  every backend is skipped or failing -- the caller drops the utterance and the call itself
  //  is unaffected (STT is the only thing that degrades).
  async transcribe(pcm: Buffer, lang: string): Promise<SelectorResult|undefined>{
    const now = Date.now()
    for (const rung of this.rungs){
      const pooled = rung.length > 1
      for (const i of await this.candidates(rung, now)){
        const backend = this.backends[i]
        this.inFlight[i] += 1
        try{
          //  Pool members were already checked by candidates().
          if (!pooled && !await backend.usable()){ continue }
          const result = await backend.transcribe(pcm, lang)
          this.states[i] = breakerOnSuccess(this.states[i])
          //  Log only transitions: a meeting that silently drops from GPU to CPU changes its
          //  recognition quality with nothing else to show for it (`stt-translation#limits`).
          //  A pool counts as one, or an evenly shared load would log every utterance.
          if (this.lastUsed !== this.labels[i]){
            sttLog(`stt: using backend '${this.labels[i]}'` +
              (this.lastUsed ? ` (was '${this.lastUsed}')` : ''))
            this.lastUsed = this.labels[i]
          }
          if (pooled){ sttDebug(`stt: ${this.labels[i]} answered by '${backend.name}'`) }

          return {...result, backend: backend.name}
        }catch(e: any){
          this.states[i] = breakerOnFailure(this.states[i], now, this.breakerCfg)
          sttDebug(`stt: backend '${backend.name}' failed: ${e?.message}`)
        }finally{
          this.inFlight[i] -= 1
        }
      }
    }

    return undefined
  }
}
