//  Shared by the STT selector (media worker) and the translator (main server): several GPU
//  machines serving the same thing, used as one rung of a fallback chain. Design: the bm
//  workspace doc `stt-translation#pool`.
//
//  A config entry joins a pool by naming it (`pool: 'gpu'`). Entries with the same pool form
//  one rung, placed where the first of them appears; an entry without `pool` is a rung of its
//  own, exactly as before pools existed. Within a rung only members that are free (not locked
//  by someone else, not tripped by the breaker) are candidates, and the one with the fewest
//  requests in flight goes first -- so one free machine takes everything and two free ones
//  share the load.
import axios from 'axios'

//  ---------------------------------------------------------------- pure helpers (unit-tested)

//  Indices of `pools` grouped into rungs, in the order the rungs first appear.
//  ['gpu', undefined, 'gpu', undefined] -> [[0, 2], [1], [3]]
export function groupIntoRungs(pools: (string|undefined)[]): number[][]{
  const rungs: number[][] = []
  const byPool = new Map<string, number[]>()
  pools.forEach((pool, i) => {
    if (!pool){
      rungs.push([i])

      return
    }
    const rung = byPool.get(pool)
    if (rung){
      rung.push(i)
    }else{
      const created = [i]
      byPool.set(pool, created)
      rungs.push(created)
    }
  })

  return rungs
}

//  Orders a rung's candidates: fewest in flight first; among equals, round-robin starting from
//  `rotation` so that an idle pool alternates instead of always sending to its first member.
//  `members` are the rung's indices, `inFlight[i]` the count for index i.
export function orderPool(members: number[], inFlight: number[], rotation: number): number[]{
  const n = members.length
  const start = n ? ((rotation % n) + n) % n : 0
  const rank = new Map(members.map((m, pos) => [m, (pos - start + n) % n]))

  return [...members].sort((a, b) => (inFlight[a] - inFlight[b]) || (rank.get(a)! - rank.get(b)!))
}

//  ---------------------------------------------------------------- GPU lock reader

export const LOCK_STATUS_CACHE_MS = 10 * 1000
//  These calls cross a reverse proxy to another machine; 2s was tight enough to time out and
//  make the GPU look unreadable when it was merely far away.
export const GPU_API_TIMEOUT_MS = 6000

//  Reads `GET <gpuStatus>/lock/status` -> {"locked": bool}; never acquires the lock. If the
//  status endpoint itself is unreachable the GPU counts as free and the real request is the
//  test -- a monitoring endpoint being down is not a reason to refuse a GPU that may be idle.
export class GpuLockReader{
  private statusUrl: string
  private headers: () => {[key: string]: string}
  private checkedAt = 0
  private lockedCached = false
  //  The read in progress, if any. Callers arriving while it runs wait for it rather than take
  //  the cached value, which before the first answer is only the initial "unlocked" -- found
  //  live: two utterances at once sent one of them to a machine that was locked.
  private pending?: Promise<boolean>

  constructor(statusUrl: string, headers: () => {[key: string]: string}){
    this.statusUrl = statusUrl
    this.headers = headers
  }

  async locked(now = Date.now()){
    if (this.pending){ return this.pending }
    if (now - this.checkedAt < LOCK_STATUS_CACHE_MS){ return this.lockedCached }
    this.checkedAt = now
    this.pending = this.read()
    try{
      return await this.pending
    }finally{
      this.pending = undefined
    }
  }

  private async read(){
    try{
      const res = await axios.get(`${this.statusUrl}/lock/status`,
        {timeout: GPU_API_TIMEOUT_MS, headers: this.headers()})
      this.lockedCached = !!res.data?.locked
    }catch(e){
      this.lockedCached = false
    }

    return this.lockedCached
  }
}
