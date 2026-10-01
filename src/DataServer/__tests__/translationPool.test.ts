import {describe, it, expect, afterEach} from 'vitest'
import http from 'http'
import {callBackend} from '../translation'

//  translation.ts reads config.translation on every call, so a test can swap it in place.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../config')
const saved = config.translation

afterEach(() => { config.translation = saved })

//  A stand-in translator (or GPU switch API, for /lock/status) that counts what it was asked.
function serve(handler: (path: string) => [number, any]){
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const path = new URL(req.url!, 'http://x').pathname
      hits.push(path)
      const [status, body] = handler(path)
      res.writeHead(status, {'content-type': 'application/json'})
      res.end(JSON.stringify(body))
    })
  })

  return new Promise<{url: string, hits: string[], close: () => void}>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({url: `http://127.0.0.1:${(server.address() as any).port}`, hits,
        close: () => server.close()})
    })
  })
}
const translator = (word: string) => (path: string): [number, any] =>
  path === '/lock/status' ? [200, {locked: false}] : [200, {zh: [word]}]

describe('pooled translation endpoints', () => {
  it('shares the load between two free machines', async () => {
    const a = await serve(translator('A'))
    const b = await serve(translator('B'))
    try{
      config.translation = {endpoints: [{endpoint: `${a.url}/translate`, pool: 'gpu'},
        {endpoint: `${b.url}/translate`, pool: 'gpu'}]}
      const answers = []
      for (let n = 0; n < 4; n += 1){ answers.push((await callBackend(`t${n}`, 'ja', ['zh'])).zh) }
      expect(answers.filter(x => x === 'A').length).toBe(2)
      expect(answers.filter(x => x === 'B').length).toBe(2)
    }finally{ a.close(); b.close() }
  })

  it('leaves a locked machine alone while its sibling answers', async () => {
    const locked = await serve(path => path === '/lock/status' ? [200, {locked: true}] : [200, {zh: ['L']}])
    const free = await serve(translator('F'))
    try{
      config.translation = {endpoints: [
        {endpoint: `${locked.url}/translate`, pool: 'gpu', gpuStatus: locked.url},
        {endpoint: `${free.url}/translate`, pool: 'gpu', gpuStatus: free.url}]}
      for (let n = 0; n < 3; n += 1){ expect((await callBackend(`u${n}`, 'ja', ['zh'])).zh).toBe('F') }
      expect(locked.hits.filter(h => h === '/translate').length).toBe(0)
    }finally{ locked.close(); free.close() }
  })

  it('retries the sibling when one member fails', async () => {
    const down = await serve(() => [500, {}])
    const up = await serve(translator('U'))
    try{
      config.translation = {endpoints: [{endpoint: `${down.url}/translate`, pool: 'gpu'},
        {endpoint: `${up.url}/translate`, pool: 'gpu'}]}
      for (let n = 0; n < 3; n += 1){ expect((await callBackend(`v${n}`, 'ja', ['zh'])).zh).toBe('U') }
    }finally{ down.close(); up.close() }
  })

  it('asks a pool only for what the rung before it left missing', async () => {
    const fugu = await serve(() => [200, {en: ['english']}])
    const a = await serve(translator('A'))
    try{
      config.translation = {endpoints: [{endpoint: `${fugu.url}/translate`},
        {endpoint: `${a.url}/translate`, pool: 'gpu'}, {endpoint: `${a.url}/translate2`, pool: 'gpu'}]}
      expect(await callBackend('w', 'ja', ['en', 'zh'])).toEqual({en: 'english', zh: 'A'})
    }finally{ fugu.close(); a.close() }
  })
})
