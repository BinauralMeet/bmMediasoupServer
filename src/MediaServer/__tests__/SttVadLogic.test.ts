import {describe, it, expect} from 'vitest'
import {VadLogic, VadConfig, frameRms, defaultVadConfig} from '../SttVadLogic'

//  Most tests are about segmentation, not calibration, so they skip the warm-up window.
//  The one test that is about calibration sets warmupMs explicitly.
function makeVad(cfg: Partial<VadConfig> = {}){
  return new VadLogic({warmupMs: 0, ...cfg})
}

//  Feeds `count` frames of the same level and returns every event produced.
function push(vad: VadLogic, rms: number, count: number){
  const events = []
  for (let i = 0; i < count; i += 1){ events.push(...vad.push(rms)) }

  return events
}

const LOUD = 5000
const QUIET = 10

describe('frameRms', () => {
  it('is 0 for an empty frame', () => {
    expect(frameRms(new Int16Array(0))).toBe(0)
  })
  it('is the amplitude for a constant frame', () => {
    expect(frameRms(new Int16Array([100, -100, 100, -100]))).toBeCloseTo(100)
  })
})

describe('VadLogic', () => {
  it('opens a segment on the first loud frame', () => {
    const vad = makeVad()
    expect(vad.push(QUIET)).toEqual([])
    expect(vad.push(LOUD)).toEqual([{type: 'start'}])
    expect(vad.speaking).toBe(true)
  })

  it('closes the segment after hangoverMs of silence, not before', () => {
    const vad = makeVad({hangoverMs: 100, frameMs: 20, interimMs: 0})
    push(vad, LOUD, 10)                       //  200ms of speech
    expect(push(vad, QUIET, 4)).toEqual([])   //  80ms silence -- still open
    const events = push(vad, QUIET, 1)        //  100ms -- closes
    expect(events).toEqual([{type: 'end', durationMs: 300, speechMs: 200, reason: 'silence'}])
    expect(vad.speaking).toBe(false)
  })

  it('force-cuts a segment at maxSegmentMs so a monologue still yields text', () => {
    const vad = makeVad({maxSegmentMs: 200, frameMs: 20, interimMs: 0})
    const events = push(vad, LOUD, 20)
    const end = events.find(e => e.type === 'end')
    expect(end).toEqual({type: 'end', durationMs: 200, speechMs: 200, reason: 'maxLength'})
  })

  it('emits interim ticks while the segment stays open', () => {
    const vad = makeVad({interimMs: 100, frameMs: 20, hangoverMs: 1000})
    const events = push(vad, LOUD, 11)   //  220ms
    expect(events.filter(e => e.type === 'interim').map(e => (e as any).durationMs))
      .toEqual([100, 200])
  })

  it('does not emit interim ticks when interimMs is 0', () => {
    const vad = makeVad({interimMs: 0, frameMs: 20, hangoverMs: 1000})
    expect(push(vad, LOUD, 50).filter(e => e.type === 'interim')).toEqual([])
  })

  it('flush() closes an open segment so the tail is not lost', () => {
    const vad = makeVad({interimMs: 0})
    push(vad, LOUD, 5)
    expect(vad.flush()).toEqual([{type: 'end', durationMs: 100, speechMs: 100, reason: 'silence'}])
    expect(vad.flush()).toEqual([])   //  nothing open any more
  })

  it('marks blips shorter than minSpeechMs as non-utterances', () => {
    const vad = makeVad({minSpeechMs: 200, hangoverMs: 100, frameMs: 20, interimMs: 0})
    push(vad, LOUD, 4)                                  //  80ms of speech only
    const end = push(vad, QUIET, 5).find(e => e.type === 'end') as any
    expect(vad.isUtterance(end)).toBe(false)
    expect(vad.isUtterance({speechMs: 200})).toBe(true)
  })

  it('calibrates to a noisy line during warm-up instead of opening one endless segment', () => {
    const noisy = new VadLogic({warmupMs: 500, frameMs: 20})
    //  A steady 1000-RMS hiss is above absMinRms, so without calibration frame 1 would be
    //  "speech" and the floor (frozen during speech) would never catch up.
    push(noisy, 1000, 200)
    expect(noisy.speaking).toBe(false)
    //  ...but something clearly above that floor still opens a segment.
    expect(noisy.push(1000 * defaultVadConfig.thresholdRatio + 100)).toEqual([{type: 'start'}])
  })

  it('does not adapt the floor during speech, so long utterances are not cut short', () => {
    const vad = makeVad({hangoverMs: 200, frameMs: 20, interimMs: 0})
    vad.push(LOUD)
    const events = push(vad, LOUD, 500)   //  10 seconds of steady speech
    expect(events.filter(e => e.type === 'end')).toEqual([])
  })
})
