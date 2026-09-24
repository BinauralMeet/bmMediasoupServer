import {describe, it, expect, vi, afterEach} from 'vitest'
import {wavFromPcm16, breakerShouldSkip, breakerOnFailure, breakerOnSuccess, newBreakerState,
  SttBackendSelector, SttBackend, SttResult} from '../SttBackend'

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
