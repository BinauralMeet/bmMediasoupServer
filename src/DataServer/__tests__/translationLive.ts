//  Manual check (not part of `vitest run`): drives translation.ts against a running translation
//  sidecar, to verify the wire contract end to end -- the request body, the per-language response
//  shape, unsupported pairs, and that the cache keeps a repeat from hitting the backend twice.
//
//      npx ts-node src/DataServer/__tests__/translationLive.ts [http://127.0.0.1:8191/translate]
//
//  The endpoint argument overrides config.js, so a mock and the real sidecar can both be checked.
import {MessageType, SttLangInfo} from '../DataMessageType'
import {ParticipantStore, RoomStore} from '../Stores'
import {translateUtterance, wantedLangs} from '../translation'
import websocket from 'ws'

const config = require('../../../config')
if (process.argv[2]){ config.translation.endpoint = process.argv[2] }
console.log(`endpoint: ${config.translation.endpoint}`)

//  A room whose participants have announced the languages they read. Only the stored
//  PARTICIPANT_STT_LANG message matters here, so the socket is never used.
function makeRoom(langs: (SttLangInfo|undefined)[]){
  const room = new RoomStore('live')
  langs.forEach((lang, i) => {
    const p = new ParticipantStore(`p${i}`, undefined as unknown as websocket.WebSocket)
    if (lang){
      p.storedMessages.set(MessageType.PARTICIPANT_STT_LANG,
        {t: MessageType.PARTICIPANT_STT_LANG, v: JSON.stringify(lang), p: p.id})
    }
    room.participantsMap.set(p.id, p)
    room.participants.push(p)
  })

  return room
}

function translated(room: RoomStore, text: string, src: string){
  return new Promise<any>((resolve) => {
    const timer = setTimeout(() => resolve('(nothing was broadcast)'), 10000)
    translateUtterance(room, 'sid-1', 'p0', text, src, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

async function main(){
  const jaAndEn = makeRoom([{speak: 'ja', show: 'ja'}, {speak: 'en', show: 'en-US'}])
  console.log('wanted langs:', JSON.stringify(wantedLangs(jaAndEn)))

  const first = await translated(jaAndEn, 'これは翻訳のテストです。', 'ja')
  console.log('ja -> en:', JSON.stringify(first))

  const started = Date.now()
  const cached = await translated(jaAndEn, 'これは翻訳のテストです。', 'ja')
  console.log(`same text again (${Date.now() - started}ms, should be ~0 and never reach the ` +
    `backend):`, JSON.stringify(cached))

  //  Korean has no model in the sidecar: the key is omitted and nothing is broadcast, so the
  //  subtitle stays in its original language.
  console.log('ko -> en (unsupported pair):',
    JSON.stringify(await translated(jaAndEn, '안녕하세요.', 'ko')))

  //  Everyone reads the language it was spoken in: no backend call at all.
  const jaOnly = makeRoom([{speak: 'ja', show: 'ja'}, {speak: 'ja', show: 'ja'}])
  console.log('single-language room:',
    JSON.stringify(await translated(jaOnly, 'これは翻訳のテストです。', 'ja')))
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1) })
