//  Manual check (not part of `vitest run`): drives SttBackendSelector with a two-member pool
//  against two real recognizers, to see the load actually being shared and a locked or missing
//  member being left out (`stt-translation#pool`).
//
//      npx ts-node src/MediaServer/__tests__/sttPoolLive.ts <wav> <asr-url-A> <status-A> <asr-url-B> <status-B> [<n>] [<concurrency>]
//
//  <wav> must be 16kHz mono 16-bit (its 44-byte header is skipped). No `gpuMode` is set, so
//  nothing is ever switched -- both machines must already be running the recognizer. A status
//  URL of '-' means "no switch API", i.e. never locked.
import fs from 'fs'
import {SttBackendSelector} from '../SttBackend'

const [wavPath, asrA, statusA, asrB, statusB] = process.argv.slice(2)
const n = Number(process.argv[7] || 8)
const concurrency = Number(process.argv[8] || 2)
const apiKeyEnv = process.env.LM_HASELAB_API_KEY ? 'LM_HASELAB_API_KEY' : undefined
const member = (name: string, endpoint: string, status: string) => ({kind: 'gpuWhisper', name,
  pool: 'gpu', endpoint, gpuStatus: status === '-' ? undefined : status, apiKeyEnv, timeoutMs: 20000})

async function main(){
  const pcm = fs.readFileSync(wavPath).subarray(44)
  const selector = new SttBackendSelector([member('A', asrA, statusA), member('B', asrB, statusB)])
  const counts: {[name: string]: number} = {}
  let next = 0
  async function worker(){
    while (next < n){
      const k = next++
      const t0 = Date.now()
      const res = await selector.transcribe(pcm, 'en')
      const who = res?.backend || 'none'
      counts[who] = (counts[who] || 0) + 1
      console.log(`#${k} ${who} ${Date.now() - t0}ms ${JSON.stringify(res?.text?.slice(0, 40))}`)
    }
  }
  await Promise.all(Array.from({length: concurrency}, worker))
  console.log('answered by:', counts)
}
main()
