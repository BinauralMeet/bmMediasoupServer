//  Translates finished utterances for the room and broadcasts the result. Runs on the main server
//  because this is where the room's participants -- and therefore the set of languages anybody
//  actually wants -- are known. Design: the bm workspace doc `stt-translation#ingest`.
//
//  Only final utterances are translated. Interim text is re-sent several times per second and
//  would multiply the cost while making the subtitle flicker between rewrites.
import axios from 'axios'
import {MessageType, SpeechTranslation, SttLangInfo} from './DataMessageType'
import {RoomStore} from './Stores'
import {collectTargetLangs, normalizeLang, TranslationCache} from './TranslationTargets'
import {consoleDebug} from '../MainServer/utils'

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
      return (JSON.parse(stored.v) as SttLangInfo).show
    }catch{
      return undefined
    }
  })
}

async function callBackend(text: string, src: string, dsts: string[]): Promise<{[lang: string]: string}>{
  const endpoint = config.translation?.endpoint
  const headers: {[key: string]: string} = {}
  const keyEnv = config.translation?.apiKeyEnv
  const key = keyEnv ? process.env[keyEnv] : undefined
  if (key){ headers.Authorization = `Bearer ${key}` }
  const res = await axios.post(endpoint, {texts: [text], src, dsts},
    {timeout: config.translation?.timeoutMs || 5000, headers})

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

//  Fire-and-forget: the caller has already broadcast the original text, and a translation that
//  fails or is skipped simply never arrives -- subtitles stay in the original language.
export function translateUtterance(room: RoomStore, sid: string, pid: string, text: string,
  srcLang: string, broadcast: (payload: SpeechTranslation) => void){
  if (!config.translation?.endpoint){ return }
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
