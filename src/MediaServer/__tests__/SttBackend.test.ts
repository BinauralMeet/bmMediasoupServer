import {describe, it, expect, vi, afterEach} from 'vitest'
import http from 'http'
import {stripEventTags, wavFromPcm16, breakerShouldSkip, breakerOnFailure, breakerOnSuccess, newBreakerState,
  SttBackendSelector, SttBackend, SttResult, HttpSttBackend, WARM_INTERVAL_MS} from '../SttBackend'

//  A scriptable stand-in for an HTTP backend: each call takes the next entry of `script`
//  ('ok' | 'fail' | 'busy') so a test can describe a sequence of GPU availability.
class FakeBackend implements SttBackend{
  readonly name: string
  calls = 0
  private script: string[]
  constructor(name: string, script: string[]){
    this.name = name
    this.script = script
  }
  private next(){ return this.script.length > 1 ? this.script.shift()! : this.script[0] }
  async usable(){ return this.next() !== 'busy' }
  async transcribe(): Promise<SttResult>{
    this.calls += 1
    if (this.next() === 'fail'){ throw new Error('backend down') }

    return {text: `${this.name} text`, lang: 'ja'}
  }
}

//  usable() and transcribe() each consume an entry, so a one-entry script repeats forever.
function backend(name: string, mode: 'ok'|'fail'|'busy'){
  return new FakeBackend(name, [mode])
}
function selectorOf(...backends: SttBackend[]){
  let i = 0

  return new SttBackendSelector(backends.map(b => ({kind: b.name, endpoint: ''})),
    {failuresToOpen: 2, openMs: 1000}, () => backends[i++])
}

afterEach(() => { vi.useRealTimers() })

describe('wavFromPcm16', () => {
  it('prepends a 44-byte RIFF/WAVE header describing the payload', () => {
    const pcm = Buffer.alloc(320 * 2)
    const wav = wavFromPcm16(pcm, 16000, 1)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.readUInt16LE(22)).toBe(1)          //  mono
    expect(wav.readUInt32LE(24)).toBe(16000)      //  sample rate
    expect(wav.readUInt32LE(28)).toBe(32000)      //  byte rate = 16000 * 1 * 2
    expect(wav.readUInt16LE(34)).toBe(16)         //  bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length) //  data size
  })
})

describe('stripEventTags', () => {
  it('removes the event and emotion markers SenseVoice mixes into the text', () => {
    expect(stripEventTags('🎼Yeah.')).toBe('Yeah.')
    expect(stripEventTags('😊 こんにちは 👏')).toBe('こんにちは')
  })
  it('leaves ordinary text alone', () => {
    expect(stripEventTags('And so, my fellow Americans.')).toBe('And so, my fellow Americans.')
    expect(stripEventTags('これは翻訳のテストです。')).toBe('これは翻訳のテストです。')
  })
})

describe('breaker', () => {
  it('stays closed until failuresToOpen consecutive failures', () => {
    const cfg = {failuresToOpen: 3, openMs: 1000}
    let s = newBreakerState()
    s = breakerOnFailure(s, 0, cfg)
    s = breakerOnFailure(s, 0, cfg)
    expect(breakerShouldSkip(s, 0)).toBe(false)
    s = breakerOnFailure(s, 0, cfg)
    expect(breakerShouldSkip(s, 0)).toBe(true)
  })

  it('re-enables the backend once openMs has passed, which is how GPU recovery happens', () => {
    const cfg = {failuresToOpen: 1, openMs: 1000}
    const s = breakerOnFailure(newBreakerState(), 5000, cfg)
    expect(breakerShouldSkip(s, 5999)).toBe(true)
    expect(breakerShouldSkip(s, 6000)).toBe(false)
  })

  it('a success clears the failure streak', () => {
    const cfg = {failuresToOpen: 2, openMs: 1000}
    let s = breakerOnFailure(newBreakerState(), 0, cfg)
    s = breakerOnSuccess(s)
    s = breakerOnFailure(s, 0, cfg)
    expect(breakerShouldSkip(s, 0)).toBe(false)
  })
})

describe('HttpSttBackend', () => {
  //  A recognizer sidecar that records what it was asked, so the request itself can be asserted.
  //  Its contract is the real one (bm/stt-sidecars): an unknown `lang` is an error, not a hint.
  function serve(handler: (url: URL, body: Buffer) => [number, any]){
    const seen: {url: URL, body: Buffer}[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x')
        const body = Buffer.concat(chunks)
        seen.push({url, body})
        const [status, payload] = handler(url, body)
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(payload))
      })
    })

    return new Promise<{port: number, seen: typeof seen, close: () => void}>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const {port} = server.address() as any
        resolve({port, seen, close: () => server.close()})
      })
    })
  }

  const ok = (url: URL) => {
    const lang = url.searchParams.get('lang')
    if (lang && !['ja', 'en'].includes(lang)){ return [500, {text: '', lang}] as [number, any] }

    return [200, {text: ' recognized ', lang: lang || 'ja'}] as [number, any]
  }

  it("sends no lang parameter for 'auto', which is BM's word for a hint it does not have", async () => {
    const sidecar = await serve(ok)
    try{
      const backend = new HttpSttBackend({kind: 'x', endpoint: `http://127.0.0.1:${sidecar.port}/asr`})
      const result = await backend.transcribe(Buffer.alloc(320 * 2), 'auto')
      expect(sidecar.seen[0].url.searchParams.has('lang')).toBe(false)
      //  ...and the language the recognizer detected is what comes back, since nothing else knows it.
      expect(result).toEqual({text: 'recognized', lang: 'ja'})
    }finally{ sidecar.close() }
  })

  it('passes a real language code through as a hint', async () => {
    const sidecar = await serve(ok)
    try{
      const backend = new HttpSttBackend({kind: 'x', endpoint: `http://127.0.0.1:${sidecar.port}/asr`})
      await backend.transcribe(Buffer.alloc(320 * 2), 'en')
      expect(sidecar.seen[0].url.searchParams.get('lang')).toBe('en')
    }finally{ sidecar.close() }
  })

  it('sends the audio as a well-formed 16kHz mono WAV', async () => {
    const sidecar = await serve(ok)
    try{
      const backend = new HttpSttBackend({kind: 'x', endpoint: `http://127.0.0.1:${sidecar.port}/asr`})
      await backend.transcribe(Buffer.alloc(16000 * 2), 'ja')
      const body = sidecar.seen[0].body
      expect(body.toString('ascii', 0, 4)).toBe('RIFF')
      expect(body.readUInt32LE(24)).toBe(16000)
      expect(body.readUInt16LE(22)).toBe(1)
      expect(body.length).toBe(44 + 16000 * 2)
    }finally{ sidecar.close() }
  })
})

describe('HttpSttBackend GPU handling', () => {
  //  Stands in for the GPU's switch/lock API: /lock/status, /status and /activate/<mode>.
  function gpu(opts: {locked: boolean, modes: string[]}){
    const calls: string[] = []
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://x')
      calls.push(`${req.method} ${url.pathname}`)
      let body: any = {}
      if (url.pathname === '/lock/status'){ body = {locked: opts.locked} }
      if (url.pathname === '/status'){ body = {active_modes: opts.modes} }
      if (url.pathname.startsWith('/activate/')){
        opts.modes = [url.pathname.slice('/activate/'.length)]
        body = {status: 'switching'}
      }
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify(body))
    })

    return new Promise<{port: number, calls: string[], setModes: (m: string[]) => void,
      close: () => void}>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({port: (server.address() as any).port, calls,
          setModes: (m: string[]) => { opts.modes = m },
          close: () => server.close()})
      })
    })
  }

  it('stays out of the way entirely while someone holds the lock', async () => {
    const api = await gpu({locked: true, modes: ['something-else']})
    try{
      const backend = new HttpSttBackend({kind: 'gpu', endpoint: 'http://127.0.0.1:1/asr',
        gpuStatus: `http://127.0.0.1:${api.port}`, gpuMode: 'conversation'})
      expect(await backend.usable()).toBe(false)
      //  No mode was inspected and nothing was switched: a held lock ends the conversation.
      expect(api.calls).toEqual(['GET /lock/status'])
    }finally{ api.close() }
  })

  it('uses the GPU when it is already in the right mode', async () => {
    const api = await gpu({locked: false, modes: ['conversation']})
    try{
      const backend = new HttpSttBackend({kind: 'gpu', endpoint: 'http://127.0.0.1:1/asr',
        gpuStatus: `http://127.0.0.1:${api.port}`, gpuMode: 'conversation'})
      expect(await backend.usable()).toBe(true)
      expect(api.calls.some(c => c.startsWith('POST /activate'))).toBe(false)
    }finally{ api.close() }
  })

  it('asks an unlocked GPU to switch, and uses it once it has', async () => {
    const api = await gpu({locked: false, modes: ['hidream']})
    try{
      const backend = new HttpSttBackend({kind: 'gpu', endpoint: 'http://127.0.0.1:1/asr',
        gpuStatus: `http://127.0.0.1:${api.port}`, gpuMode: 'conversation'})
      //  The switch takes longer than an utterance can wait, so this one goes elsewhere...
      expect(await backend.usable()).toBe(false)
      expect(api.calls).toContain('POST /activate/conversation')
      //  ...and the next one, after the lock-status cache expires, finds the mode running.
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 60000)
      expect(await backend.usable()).toBe(true)
    }finally{ api.close() }
  })

  it('does not keep asking a GPU that stays in another mode', async () => {
    const api = await gpu({locked: false, modes: ['hidream']})
    try{
      const backend = new HttpSttBackend({kind: 'gpu', endpoint: 'http://127.0.0.1:1/asr',
        gpuStatus: `http://127.0.0.1:${api.port}`, gpuMode: 'conversation'})
      await backend.usable()
      api.calls.length = 0
      //  Someone switched it back; we do not fight over it once every ten seconds.
      api.setModes(['hidream'])
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 30000)
      expect(await backend.usable()).toBe(false)
      expect(api.calls.some(c => c.startsWith('POST /activate'))).toBe(false)
    }finally{ api.close() }
  })

  it('ignores the GPU API entirely when no gpuStatus is configured', async () => {
    const backend = new HttpSttBackend({kind: 'cpu', endpoint: 'http://127.0.0.1:1/asr'})
    expect(await backend.usable()).toBe(true)
  })
})

describe('SttBackendSelector', () => {
  it('uses the first backend when it works', async () => {
    const gpu = backend('gpu', 'ok')
    const cpu = backend('cpu', 'ok')
    const res = await selectorOf(gpu, cpu).transcribe(Buffer.alloc(0), 'ja')
    expect(res).toEqual({text: 'gpu text', lang: 'ja', backend: 'gpu'})
    expect(cpu.calls).toBe(0)
  })

  it('falls through to the next backend when the GPU is locked by someone else', async () => {
    const gpu = backend('gpu', 'busy')
    const cpu = backend('cpu', 'ok')
    const res = await selectorOf(gpu, cpu).transcribe(Buffer.alloc(0), 'ja')
    expect(res?.backend).toBe('cpu')
    expect(gpu.calls).toBe(0)     //  never even attempted -- no lock was taken or waited for
  })

  it('falls through when the first backend errors', async () => {
    const res = await selectorOf(backend('gpu', 'fail'), backend('cpu', 'ok'))
      .transcribe(Buffer.alloc(0), 'ja')
    expect(res?.backend).toBe('cpu')
  })

  it('returns undefined when every backend is unavailable, rather than throwing', async () => {
    const res = await selectorOf(backend('gpu', 'fail'), backend('cpu', 'fail'))
      .transcribe(Buffer.alloc(0), 'ja')
    expect(res).toBeUndefined()
  })

  it('stops retrying a failing backend until its breaker reopens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const gpu = backend('gpu', 'fail')
    const cpu = backend('cpu', 'ok')
    const selector = selectorOf(gpu, cpu)
    await selector.transcribe(Buffer.alloc(0), 'ja')
    await selector.transcribe(Buffer.alloc(0), 'ja')   //  2 failures -> breaker opens
    expect(gpu.calls).toBe(2)
    await selector.transcribe(Buffer.alloc(0), 'ja')
    expect(gpu.calls).toBe(2)                          //  skipped, not retried

    vi.setSystemTime(1000)
    await selector.transcribe(Buffer.alloc(0), 'ja')
    expect(gpu.calls).toBe(3)                          //  retried once the window passed
  })

  it('has nothing configured when the config list is empty', async () => {
    const selector = new SttBackendSelector([])
    expect(selector.configured).toBe(false)
    expect(await selector.transcribe(Buffer.alloc(0), 'ja')).toBeUndefined()
  })
})

describe('SttBackendSelector with a pool', () => {
  //  Like selectorOf, but each backend is given the pool named at the same position.
  function pooledOf(entries: [SttBackend, string|undefined][]){
    let i = 0

    return new SttBackendSelector(entries.map(([b, pool]) => ({kind: b.name, endpoint: '', pool})),
      {failuresToOpen: 2, openMs: 1000}, () => entries[i++][0])
  }

  it('alternates between two free machines instead of always using the first', async () => {
    const a = backend('gpuA', 'ok')
    const b = backend('gpuB', 'ok')
    const cpu = backend('cpu', 'ok')
    const selector = pooledOf([[a, 'gpu'], [b, 'gpu'], [cpu, undefined]])
    for (let n = 0; n < 4; n += 1){ await selector.transcribe(Buffer.alloc(0), 'ja') }
    expect(a.calls).toBe(2)
    expect(b.calls).toBe(2)
    expect(cpu.calls).toBe(0)
  })

  it('sends everything to the free machine while the other one is locked', async () => {
    const a = backend('gpuA', 'busy')
    const b = backend('gpuB', 'ok')
    const selector = pooledOf([[a, 'gpu'], [b, 'gpu']])
    for (let n = 0; n < 3; n += 1){
      expect((await selector.transcribe(Buffer.alloc(0), 'ja'))?.backend).toBe('gpuB')
    }
    expect(a.calls).toBe(0)
  })

  it('prefers the machine with fewer requests in flight', async () => {
    let release: () => void = () => {}
    //  gpuA holds on to its first request until released, as a slow utterance would.
    class Slow extends FakeBackend{
      async transcribe(): Promise<SttResult>{
        this.calls += 1
        if (this.calls === 1){ await new Promise<void>((r) => { release = r }) }

        return {text: `${this.name} text`, lang: 'ja'}
      }
    }
    const a = new Slow('gpuA', ['ok'])
    const b = backend('gpuB', 'ok')
    const selector = pooledOf([[a, 'gpu'], [b, 'gpu']])
    //  Whichever member the first request lands on, find out which is busy and check that the
    //  next two both go to the other one.
    const first = selector.transcribe(Buffer.alloc(0), 'ja')
    await new Promise(r => setTimeout(r, 0))
    if (a.calls === 1){
      await selector.transcribe(Buffer.alloc(0), 'ja')
      await selector.transcribe(Buffer.alloc(0), 'ja')
      expect(b.calls).toBe(2)
      expect(a.calls).toBe(1)
    }else{
      expect(b.calls).toBe(1)
    }
    release()
    await first
  })

  it('retries the sibling when one member fails, before leaving the pool', async () => {
    const a = backend('gpuA', 'fail')
    const b = backend('gpuB', 'ok')
    const cpu = backend('cpu', 'ok')
    const selector = pooledOf([[a, 'gpu'], [b, 'gpu'], [cpu, undefined]])
    for (let n = 0; n < 3; n += 1){
      expect((await selector.transcribe(Buffer.alloc(0), 'ja'))?.backend).toBe('gpuB')
    }
    expect(cpu.calls).toBe(0)
  })

  it('falls to the next rung only when every member is locked or failing', async () => {
    const selector = pooledOf([[backend('gpuA', 'busy'), 'gpu'], [backend('gpuB', 'fail'), 'gpu'],
      [backend('cpu', 'ok'), undefined]])
    expect((await selector.transcribe(Buffer.alloc(0), 'ja'))?.backend).toBe('cpu')
  })
})

describe('warm-up', () => {
  //  One server playing both roles: the GPU switch API and the recognizer behind it.
  function machine(opts: {locked: boolean, modes: string[]}){
    const calls: string[] = []
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x')
        calls.push(`${req.method} ${url.pathname}`)
        let body: any = {}
        if (url.pathname === '/lock/status'){ body = {locked: opts.locked} }
        if (url.pathname === '/status'){ body = {active_modes: opts.modes} }
        if (url.pathname.startsWith('/activate/')){ body = {} }
        if (url.pathname === '/asr'){ body = {text: '', lang: 'ja'} }
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify(body))
      })
    })

    return new Promise<{url: string, calls: string[], close: () => void}>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({url: `http://127.0.0.1:${(server.address() as any).port}`, calls,
          close: () => server.close()})
      })
    })
  }
  const gpuBackend = (url: string) => new HttpSttBackend({kind: 'gpu', endpoint: `${url}/asr`,
    gpuStatus: url, gpuMode: 'gpuwhisper'})

  it('sends one throwaway recognition to a GPU already in its mode, then not again for a while', async () => {
    const m = await machine({locked: false, modes: ['gpuwhisper']})
    try{
      const b = gpuBackend(m.url)
      await b.warmUp()
      await b.warmUp()
      expect(m.calls.filter(c => c === 'POST /asr').length).toBe(1)
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + WARM_INTERVAL_MS + 1000)
      await b.warmUp()
      expect(m.calls.filter(c => c === 'POST /asr').length).toBe(2)
    }finally{ m.close() }
  })

  it('leaves a locked GPU entirely alone', async () => {
    const m = await machine({locked: true, modes: ['hidream']})
    try{
      await gpuBackend(m.url).warmUp()
      expect(m.calls).toEqual(['GET /lock/status'])
    }finally{ m.close() }
  })

  it('asks an idle GPU in another mode to switch, without sending it audio yet', async () => {
    const m = await machine({locked: false, modes: ['hidream']})
    try{
      await gpuBackend(m.url).warmUp()
      expect(m.calls).toContain('POST /activate/gpuwhisper')
      expect(m.calls).not.toContain('POST /asr')
    }finally{ m.close() }
  })

  it('does nothing for a backend without a GPU switch API', async () => {
    const m = await machine({locked: false, modes: []})
    try{
      await new HttpSttBackend({kind: 'cpu', endpoint: `${m.url}/asr`}).warmUp()
      expect(m.calls).toEqual([])
    }finally{ m.close() }
  })

  it('the selector warms every backend that can be warmed and never throws', async () => {
    const warmed: string[] = []
    const make = (name: string, fail: boolean): SttBackend => ({
      name, usable: async () => true, transcribe: async () => ({text: '', lang: 'ja'}),
      warmUp: async () => { warmed.push(name); if (fail){ throw new Error('down') } },
    })
    const backends = [make('a', true), make('b', false), backend('cpu', 'ok')]
    let i = 0
    const selector = new SttBackendSelector(backends.map(b => ({kind: b.name, endpoint: ''})),
      undefined, () => backends[i++])
    await selector.warmUp()
    expect(warmed.sort()).toEqual(['a', 'b'])
  })
})
