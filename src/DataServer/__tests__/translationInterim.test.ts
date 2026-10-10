import {describe, it, expect, afterEach} from 'vitest'
import http from 'http'
import {markFinal, translateInterim} from '../translation'
import {MessageType, SpeechTranslation} from '../DataMessageType'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../config')
const saved = config.translation

afterEach(() => { config.translation = saved })

//  A translator that answers after `delayMs`, echoing the text it was given.
function slowTranslator(delayMs: number){
  const asked: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const text = JSON.parse(body).texts[0]
      asked.push(text)
      setTimeout(() => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({zh: [`zh:${text}`]}))
      }, delayMs)
    })
  })

  return new Promise<{url: string, asked: string[], close: () => void}>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({url: `http://127.0.0.1:${(server.address() as any).port}`, asked, close: () => server.close()})
    })
  })
}

//  Just enough of a RoomStore for wantedLangs(): one reader who wants Chinese subtitles.
const room: any = {participants: [{storedMessages: new Map([[MessageType.PARTICIPANT_STT_LANG,
  {t: MessageType.PARTICIPANT_STT_LANG, v: JSON.stringify({speak: 'zh', show: 'zh', on: true})}]])}]}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('interim translation', () => {
  it('translates the newest hypothesis, skipping the ones overtaken while busy', async () => {
    const t = await slowTranslator(150)
    try{
      config.translation = {endpoints: [{endpoint: `${t.url}/translate`, pool: 'gpu'},
        {endpoint: `${t.url}/translate2`, pool: 'gpu'}]}
      const got: SpeechTranslation[] = []
      translateInterim(room, 's1', 'p', 'こん', 'ja', p => got.push(p))
      translateInterim(room, 's1', 'p', 'こんに', 'ja', p => got.push(p))
      translateInterim(room, 's1', 'p', 'こんにちは', 'ja', p => got.push(p))
      await sleep(500)
      expect(t.asked).toEqual(['こん', 'こんにちは'])
      expect(got.map(p => p.texts.zh)).toEqual(['zh:こん', 'zh:こんにちは'])
    }finally{ t.close() }
  })

  it('drops a result that comes back after the final text', async () => {
    const t = await slowTranslator(150)
    try{
      config.translation = {endpoints: [{endpoint: `${t.url}/translate`}]}
      const got: SpeechTranslation[] = []
      translateInterim(room, 's2', 'p', 'さよう', 'ja', p => got.push(p))
      markFinal('s2')
      translateInterim(room, 's2', 'p', 'さようなら', 'ja', p => got.push(p))
      await sleep(400)
      expect(t.asked).toEqual(['さよう'])
      expect(got).toEqual([])
    }finally{ t.close() }
  })

  it('can be switched off', async () => {
    const t = await slowTranslator(10)
    try{
      config.translation = {endpoints: [{endpoint: `${t.url}/translate`}], interim: false}
      translateInterim(room, 's3', 'p', 'はい', 'ja', () => undefined)
      await sleep(100)
      expect(t.asked).toEqual([])
    }finally{ t.close() }
  })
})
