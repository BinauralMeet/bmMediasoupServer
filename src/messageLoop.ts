//  Messages from peers, media workers and data sockets are queued by their ws 'message' handlers
//  and handled here, one at a time. Handling starts as soon as something is queued instead of on
//  a fixed tick (which made every signalling message and data request wait up to the tick); a run
//  that has used BUDGET_MS yields with setImmediate so sockets and timers still get their turn.

const BUDGET_MS = 50

let processOne: () => boolean = () => false
let scheduled = false
let busyMs = 0
let loadSince = Date.now()

//  `process` handles one queued message and returns false when every queue is empty.
export function setMessageProcessor(process: () => boolean){
  processOne = process
}

//  Called by whoever queues a message.
export function kickMessageLoop(){
  if (scheduled){ return }
  scheduled = true
  setImmediate(run)
}

function run(){
  scheduled = false
  const start = Date.now()
  let more = true
  try{
    while (Date.now() - start < BUDGET_MS){
      more = processOne()
      if (!more){ break }
    }
  }finally{
    busyMs += Date.now() - start
    //  Over budget with messages left (or a handler threw): continue on the next turn.
    if (more){ kickMessageLoop() }
  }
}

//  Share of wall time spent handling messages since the previous call (reported by /load).
export function takeMessageLoad(){
  const now = Date.now()
  const load = now > loadSince ? busyMs / (now - loadSince) : 0
  busyMs = 0
  loadSince = now

  return load
}
