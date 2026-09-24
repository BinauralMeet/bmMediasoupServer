//  Manual check (not part of `vitest run`): drives the real HTTP client against a running
//  recognition sidecar, to verify the wire contract end to end -- WAV framing, the `lang`
//  parameter and the response shape. Point it at whichever sidecar you want to test:
//
//      npx ts-node src/MediaServer/__tests__/sttBackendLive.ts http://127.0.0.1:8190/asr
//
//  It sends one second of a 440Hz tone, so a real recognizer will answer with empty or nonsense
//  text -- what is being checked here is the exchange, not the transcription.
import {SttBackendSelector, SAMPLE_RATE} from '../SttBackend'

const endpoint = process.argv[2] || 'http://127.0.0.1:18190/asr'
const gpuStatus = process.argv[3]

function tone(seconds: number){
  const pcm = Buffer.alloc(SAMPLE_RATE * seconds * 2)
  for (let i = 0; i < SAMPLE_RATE * seconds; i += 1){
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 8000), i * 2)
  }

  return pcm
}

async function main(){
  const selector = new SttBackendSelector([
    {kind: 'live', endpoint, gpuStatus, timeoutMs: 30000, apiKeyEnv: 'LM_HASELAB_API_KEY'},
  ])
  for (const lang of ['auto', 'ja']){
    const started = process.hrtime.bigint()
    const result = await selector.transcribe(tone(1), lang)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    console.log(`lang=${lang} -> ${JSON.stringify(result)} (${ms.toFixed(0)}ms)`)
    if (!result){ console.log('  (undefined = every backend skipped or failing)') }
  }
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1) })
