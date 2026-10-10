//  Translates finished utterances for the room and broadcasts the result. Runs on the main server
//  because this is where the room's participants -- and therefore the set of languages anybody
//  actually wants -- are known. Design: the bm workspace doc `stt-translation#ingest`.
//
//  Final utterances are always translated. Interim text is translated too, but only while a GPU
//  is idle (translateInterim below): it is re-sent about once a second, so translating every
//  rewrite would multiply the cost, and it must never take capacity the finals need.
import axios from 'axios'
import {MessageType, SpeechTranslation, SttLangInfo} from './DataMessageType'
import {RoomStore} from './Stores'
import {collectTargetLangs, normalizeLang, TranslationCache} from './TranslationTargets'
import {consoleDebug} from '../MainServer/utils'
import {GpuLockReader, groupIntoRungs, orderPool} from '../MediaServer/GpuPool'
import {BreakerState, breakerOnFailure, breakerOnSuccess, breakerShouldSkip, newBreakerState}
  from '../MediaServer/SttBackend'

const config = require('../../config')

const cache = new TranslationCache(config.translation?.cacheSize || 2000)
let inFlight = 0

function maxConcurrent(){ return config.translation?.maxConcurrent || 4 }

//  Reads each participant's announced subtitle language out of the stored PARTICIPANT_STT_LANG
//  message. Nothing new has to be tracked server-side: stored messages already exist so that a
//  late joiner learns everyone's state.
export function wantedLangs(room: RoomStore): (string|undefined)[]{
  return room.participants.map((p) => {
    const stored = p.storedMessages.get(MessageType.PARTICIPANT_STT_LANG)
    if (!stored){ return undefined }
    try{
      const info = JSON.parse(stored.v) as SttLangInfo
      //  Somebody who is not showing subtitles is not a reason to translate anything. `on`
      //  missing means a client older than that field, which is read as showing them.
      return info.on === false ? undefined : info.show
    }catch{
      return undefined
    }
  })
}

interface TranslationEndpoint{
  endpoint: string
  apiKeyEnv?: string
  timeoutMs?: number
  //  Endpoints naming the same pool are interchangeable copies of one service on different GPU
  //  machines: one rung, load-balanced, the sibling retried if one fails (MediaServer/GpuPool.ts).
  pool?: string
  //  The GPU's switch/lock API. A pooled endpoint whose GPU is locked is left alone while a
  //  sibling answers; it is only read, never acquired, same as for STT.
  gpuStatus?: string
}

function authHeaders(target: TranslationEndpoint){
  const headers: {[key: string]: string} = {}
  const key = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined
  if (key){ headers.Authorization = `Bearer ${key}` }

  return headers
}

//  Per-endpoint bookkeeping for pools, keyed by URL (config is read fresh on every call).
interface EndpointState{
  inFlight: number
  breaker: BreakerState
  lock?: GpuLockReader
}
const states = new Map<string, EndpointState>()
let rotation = 0

function stateOf(target: TranslationEndpoint): EndpointState{
  let st = states.get(target.endpoint)
  if (!st){
    st = {inFlight: 0, breaker: newBreakerState(),
      lock: target.gpuStatus ? new GpuLockReader(target.gpuStatus, () => authHeaders(target)) : undefined}
    states.set(target.endpoint, st)
  }

  return st
}

//  A lone endpoint is always tried, as before pools existed. A pool keeps its members that are
//  neither tripped nor locked, least busy first.
async function candidates(rung: TranslationEndpoint[], now: number): Promise<TranslationEndpoint[]>{
  if (rung.length === 1){ return rung }
  const open = rung.filter(t => !breakerShouldSkip(stateOf(t).breaker, now))
  const locked = await Promise.all(open.map(t => stateOf(t).lock?.locked(now) ?? false))
  const free = open.filter((_, k) => !locked[k])
  rotation += 1
  const order = orderPool(free.map((_, k) => k), free.map(t => stateOf(t).inFlight), rotation)

  return order.map(k => free[k])
}

//  One entry, or several tried in order. Several is how a deployment gets both quality and
//  coverage: a dedicated ja<->en model translates that pair better than any multilingual one,
//  while the multilingual one behind it answers the pairs the first has never heard of. Each is
//  asked only for what is still missing, and an endpoint that is down costs the languages only
//  it could serve.
function endpoints(): TranslationEndpoint[]{
  const t = config.translation
  if (!t){ return [] }
  if (Array.isArray(t.endpoints)){ return t.endpoints.filter((e: TranslationEndpoint) => e?.endpoint) }

  return t.endpoint ? [{endpoint: t.endpoint, apiKeyEnv: t.apiKeyEnv, timeoutMs: t.timeoutMs}] : []
}

async function callOne(target: TranslationEndpoint, text: string, src: string, dsts: string[]){
  const headers = authHeaders(target)
  const res = await axios.post(target.endpoint, {texts: [text], src, dsts},
    {timeout: target.timeoutMs || config.translation?.timeoutMs || 5000, headers})

  //  Accept both {en: "..."} and {en: ["..."]} so a backend that answers per-input-text (the
  //  natural shape for the batch API above) does not need an adapter of its own.
  const out: {[lang: string]: string} = {}
  for (const lang of dsts){
    const value = res.data?.[lang]
    const translated = Array.isArray(value) ? value[0] : value
    if (typeof translated === 'string' && translated.trim()){ out[lang] = translated.trim() }
  }

  return out
}

//  `idleOnly`: ask only the first rung, and only a member with nothing in flight -- the
//  "is a GPU free right now" test interim translation runs under. Nothing is sent otherwise.
export async function callBackend(text: string, src: string, dsts: string[], idleOnly = false):
  Promise<{[lang: string]: string}>{
  const out: {[lang: string]: string} = {}
  let missing = dsts
  const all = endpoints()
  const now = Date.now()
  const rungs = groupIntoRungs(all.map(t => t.pool))
  for (const indices of idleOnly ? rungs.slice(0, 1) : rungs){
    const rung = indices.map(i => all[i])
    let members = await candidates(rung, now)
    if (idleOnly){ members = members.filter(t => stateOf(t).inFlight === 0).slice(0, 1) }
    //  The first member that answers settles the rung: its siblings run the same model, so a
    //  language it left out (low confidence, unsupported pair) would be left out by them too.
    for (const target of members){
      const st = stateOf(target)
      st.inFlight += 1
      try{
        const got = await callOne(target, text, src, missing)
        st.breaker = breakerOnSuccess(st.breaker)
        Object.assign(out, got)
        missing = missing.filter(lang => out[lang] === undefined)
        break
      }catch(e: any){
        if (rung.length > 1){ st.breaker = breakerOnFailure(st.breaker, now) }
        consoleDebug(`translation: ${target.endpoint} failed: ${e?.message}`)
      }finally{
        st.inFlight -= 1
      }
    }
    if (!missing.length){ break }
  }

  return out
}

//  Fire-and-forget: the caller has already broadcast the original text, and a translation that
//  fails or is skipped simply never arrives -- subtitles stay in the original language.
export function translateUtterance(room: RoomStore, sid: string, pid: string, text: string,
  srcLang: string, broadcast: (payload: SpeechTranslation) => void){
  if (!endpoints().length){ return }
  const src = normalizeLang(srcLang)
  if (!src){ return }
  const targets = collectTargetLangs(wantedLangs(room), src)
  if (!targets.length){ return }

  const texts: {[lang: string]: string} = {}
  const missing: string[] = []
  for (const dst of targets){
    const hit = cache.get(src, dst, text)
    if (hit !== undefined){ texts[dst] = hit }else{ missing.push(dst) }
  }
  if (!missing.length){
    broadcast({sid, pid, texts})

    return
  }
  //  Shedding load here means a subtitle stays in its original language for one utterance --
  //  far better than queuing translations that arrive after the conversation has moved on.
  if (inFlight >= maxConcurrent()){
    consoleDebug(`translation: dropped ${sid} (${inFlight} in flight)`)
    if (Object.keys(texts).length){ broadcast({sid, pid, texts}) }

    return
  }

  inFlight += 1
  callBackend(text, src, missing).then((got) => {
    inFlight -= 1
    for (const lang of Object.keys(got)){
      cache.set(src, lang, text, got[lang])
      texts[lang] = got[lang]
    }
    if (Object.keys(texts).length){ broadcast({sid, pid, texts}) }
  }).catch((e) => {
    inFlight -= 1
    consoleDebug(`translation: failed for ${sid}: ${e?.message}`)
    if (Object.keys(texts).length){ broadcast({sid, pid, texts}) }
  })
}

//  Interim translation. At most one request per utterance is in flight; text that arrives while
//  it runs replaces whatever was waiting, so the next request translates the newest hypothesis.
interface InterimJob{
  room: RoomStore
  pid: string
  text: string
  srcLang: string
  broadcast: (payload: SpeechTranslation) => void
}
const interimRunning = new Map<string, InterimJob|undefined>()   //  sid -> the job waiting behind it
let interimInFlight = 0
//  Utterances whose final text has arrived. An interim translation that comes back after that is
//  stale and must not reach the clients; bounded, oldest forgotten first.
const finalized = new Set<string>()
const FINALIZED_MAX = 2000

function interimEnabled(){ return config.translation?.interim !== false }

export function markFinal(sid: string){
  finalized.add(sid)
  if (finalized.size > FINALIZED_MAX){ finalized.delete(finalized.values().next().value as string) }
  interimRunning.delete(sid)
}

export function translateInterim(room: RoomStore, sid: string, pid: string, text: string,
  srcLang: string, broadcast: (payload: SpeechTranslation) => void){
  if (!interimEnabled() || !endpoints().length || finalized.has(sid)){ return }
  const job: InterimJob = {room, pid, text, srcLang, broadcast}
  if (interimRunning.has(sid)){
    interimRunning.set(sid, job)

    return
  }
  runInterim(sid, job)
}

function runInterim(sid: string, job: InterimJob){
  const src = normalizeLang(job.srcLang)
  if (!src){ return }
  const targets = collectTargetLangs(wantedLangs(job.room), src)
  if (!targets.length){ return }
  const texts: {[lang: string]: string} = {}
  const missing = targets.filter((dst) => {
    const hit = cache.get(src, dst, job.text)
    if (hit !== undefined){ texts[dst] = hit }

    return hit === undefined
  })
  if (!missing.length){
    job.broadcast({sid, pid: job.pid, texts})

    return
  }
  //  Half the slots at most, and never while finals are waiting for them.
  if (inFlight > 0 || interimInFlight >= Math.max(1, Math.floor(maxConcurrent() / 2))){ return }

  interimRunning.set(sid, undefined)
  interimInFlight += 1
  //  Not cached: hypotheses are rewritten every second and would push finals out of the cache.
  callBackend(job.text, src, missing, true).then((got) => {
    Object.assign(texts, got)
  }).catch((e) => {
    consoleDebug(`translation: interim failed for ${sid}: ${e?.message}`)
  }).finally(() => {
    interimInFlight -= 1
    if (finalized.has(sid)){ return }
    const next = interimRunning.get(sid)
    interimRunning.delete(sid)
    if (Object.keys(texts).length){ job.broadcast({sid, pid: job.pid, texts}) }
    if (next){ runInterim(sid, next) }
  })
}
