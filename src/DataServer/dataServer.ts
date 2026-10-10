import {BMMessage, BMMessage as Message} from './DataMessage'
import {extractSharedContentInfo, ISharedContent, isEqualSharedContentInfo} from './ISharedContent'
import {MessageType, InstantMessageType, StoredMessageType, InstantMessageKeys, StoredMessageKeys,
  ParticipantMessageType, ParticipantMessageKeys} from './DataMessageType'
import {getRect, isOverlapped, isOverlappedToCircle, isInRect, isInCircle, str2Mouse, str2Pose} from './coordinates'
import {Content, messageHandlers, rooms, RoomStore, ParticipantStore, createContentSent, updateContentSent} from './Stores'
import websocket from 'ws'
import { MSConnectMessage } from '../MediaServer/MediaMessages'
import { googleServer } from '../GoogleServer/GoogleServer'
import { findRoomLoginInfo, loginInfo } from '../MainServer/mainLogin'
import { consoleDebug, stamp, userLog } from '../MainServer/utils'

const config = require('../../config')

export interface DataSocket{
  ws: websocket.WebSocket
  interval?: NodeJS.Timeout
  lastReceived: number
}

function instantMessageHandler(msg: Message, from:ParticipantStore, room: RoomStore){
  //  send message to destination or all remotes
  //  console.log(`instantMessageHandler ${msg.t}`, msg)
  msg.p = from.id
  if (msg.d){
    const to = room.participantsMap.get(msg.d)
    if (to){
      to.pushOrUpdateMessage(msg)
    }
  }else{
    const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== msg.p)
    remotes.forEach(remote => remote.pushOrUpdateMessage(msg))
  }
}
function storedMessageHandler(msg: Message, from: ParticipantStore, room: RoomStore){
  //  console.log(`storedMessageHandler ${msg.t}`, msg)
  msg.p = from.id
  from.storedMessages.set(msg.t, msg)
  instantMessageHandler(msg, from, room)
}
function participantMessageHandler(msg: Message, from: ParticipantStore, room: RoomStore){
  from.participantStates.set(msg.t, {type:msg.t, updateTime: room.tick, value:msg.v})
}
for(const key in StoredMessageType){
  messageHandlers.set(StoredMessageType[key as StoredMessageKeys], storedMessageHandler)
}
for(const key in InstantMessageType){
  messageHandlers.set(InstantMessageType[key as InstantMessageKeys], instantMessageHandler)
}
for(const key in ParticipantMessageType){
  messageHandlers.set(ParticipantMessageType[key as ParticipantMessageKeys], participantMessageHandler)
}
//  Another participant making someone's browser reload (an admin action) or kicking them: both
//  end that person's session in a way their own logs show only as "unload", so the request itself
//  goes to main_user.log -- next to the joins/leaves and clientLog lines it explains.
for(const type of [MessageType.RELOAD_BROWSER, MessageType.KICK]){
  messageHandlers.set(type, (msg, from, room) => {
    userLog.log(`${stamp()}: ${type} from ${from.id} to ${msg.d || 'everyone'} in room '${room.id}'` +
      (type === MessageType.KICK && msg.v ? ` reason:${`${msg.v}`.slice(0, 200)}` : ''))
    instantMessageHandler(msg, from, room)
  })
}

messageHandlers.set(MessageType.PARTICIPANT_POSE, (msg, from, room) => {
  //  console.log(`str2Pose(${msg.v}) = ${JSON.stringify(str2Pose(JSON.parse(msg.v)))}`)
  //  set pose
  from.pose = str2Pose(JSON.parse(msg.v))
  //  also set the message as one of the state of the participant.
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:room.tick})
})
messageHandlers.set(MessageType.PARTICIPANT_ON_STAGE, (msg, from, room) => {
  from.onStage = JSON.parse(msg.v)
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:room.tick})
})
messageHandlers.set(MessageType.PARTICIPANT_MOUSE, (msg, from, room) => {
  from.mousePos = str2Mouse(JSON.parse(msg.v)).position
  from.mouseMessageValue = msg.v
  from.mouseUpdateTime = room.tick
})

messageHandlers.set(MessageType.ROOM_PROP, (msg, _from, room) => {
  const [key, val] = JSON.parse(msg.v) as [string, string|undefined]
  if (val === undefined){
    room.properties.delete(key)
  }else{
    room.properties.set(key, val)
  }
  const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== msg.p)
  remotes.forEach(remote => remote.pushOrUpdateMessage(msg, key))
})

messageHandlers.set(MessageType.REQUEST_ALL, (_msg, from, room) => {
  room.participants.forEach(remote => {
    remote.storedMessages.forEach(msg => from.pushOrUpdateMessage(msg))
  })
  room.properties.forEach((val, key) => {
    from.messagesTo.push({t:MessageType.ROOM_PROP, v:JSON.stringify([key, val])})
  })
  from.messagesTo.push({t:MessageType.REQUEST_ALL,v:JSON.stringify({})})
  //console.log('Reply REQUEST_ALL')
  from.sendMessages()
})

messageHandlers.set(MessageType.PONG, (_msg) => {})


function pushParticipantsInRangeOrMovedOut(from:ParticipantStore, room:RoomStore, visible:number[], audible:number[]){
  //  Push participants updated and in the range.
  const overlaps = room.participants.filter(p => p.id !== from.id && (p.onStage
    || (p.pose && (isInRect(p.pose.position, visible) || isInCircle(p.pose.position, audible)))
    )
  )
  for (const p of overlaps) { from.pushStatesToSend(p) }

  //  Push participants, who was in the range but moved out later.
  const overlapPSs = new Set(overlaps)
  const pidsOut:string[] =[]
  from.participantsSent.forEach(sent => {
    if (!overlapPSs.has(sent.participant)) {
      if (isInRect(sent.position, visible) || isInCircle(sent.position, audible)){
        //  console.log(`Out call pushPositionToSend(${sent.participant.id})`)
        from.participantsSent.delete(sent.participant)
        pidsOut.push(sent.participant.id)
      }
    }
  })
  if (pidsOut.length) from.pushOrUpdateMessage({t:MessageType.PARTICIPANT_OUT, v:JSON.stringify(pidsOut)})
}

function pushMousesInRangeOrMovedOut(from:ParticipantStore, room:RoomStore, visible:number[], audible:number[]){
  //  Push participants updated and in the range.
  const overlaps = room.participants.filter(p => p.id !== from.id &&
    p.mousePos && (isInRect(p.mousePos, visible) || isInCircle(p.mousePos, audible)))
  for (const p of overlaps) { from.pushMouseToSend(p) }

  //  Push mouses, who was in the range but moved out later.
  const overlapPSs = new Set(overlaps)
  const pidsOut:string[] = []
  from.mousesSent.forEach(sent => {
    if (!overlapPSs.has(sent.participant)) {
      if (isInRect(sent.position, visible) || isInCircle(sent.position, audible)){
        from.mousesSent.delete(sent.participant)
        pidsOut.push(sent.participant.id)
      }
    }
  })
  if (pidsOut.length) from.pushOrUpdateMessage({t:MessageType.MOUSE_OUT, v:JSON.stringify(pidsOut)})
}


function pushContentsInRangeOrMovedOut(contents:Content[], from:ParticipantStore, visible:number[], audible:number[]){
  //  Find contents updated and in the range.
  const overlaps = contents.filter(c => {
    const rect = getRect(c.content.pose, c.content.size)
    return isOverlapped(rect, visible) || isOverlappedToCircle(rect, audible)
  })
  const contentsToSend = overlaps.filter(c => {
    const sent = from.contentsSent.get(c)
    if (sent){ return updateContentSent(sent) }
    from.contentsSent.set(c, createContentSent(c))
    return true
  }).map(c => c.content)

  //  Push contents, who was in the range but moved out later, to contentsToSend.
  const overlapIds = new Set(overlaps.map(c => c.content.id))
  const contentsRangeout:string[] = []
  from.contentsSent.forEach(sent => {
    if (!overlapIds.has(sent.content.content.id)) {
      const rect = getRect(sent.pose, sent.size)
      if (isOverlapped(rect, visible) || isOverlappedToCircle(rect, audible)){
        //  range out and remove from sent
        from.contentsSent.delete(sent.content)
        contentsRangeout.push(sent.content.content.id)
      }
    }
  })

  if (contentsToSend.length){
    const msgToSend = {t:MessageType.CONTENT_UPDATE_REQUEST, v:JSON.stringify(contentsToSend)}
    from.pushOrUpdateMessage(msgToSend)
    //console.log(`CONTENT_UPDATE_REQUEST for ${contentsToSend.map(c=>c.id)} received from ${from.id}.`)
  }
  if (contentsRangeout.length){
    const msgToSend = {t:MessageType.CONTENT_OUT, v:JSON.stringify(contentsRangeout)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)
  }
}

function pushContentsInfo(contents: Content[], from: ParticipantStore){
  //  Find contentsInfo updated.
  const contentsInfoToSend = contents.filter(c => {
    const sent = from.contentsInfoSent.get(c)
    if (sent){
      if (sent.timeSent < c.timeUpdateInfo){
        sent.timeSent = c.timeUpdateInfo
        return true
      }else{
        return false
      }
    }
    from.contentsInfoSent.set(c, {content:c.content, timeSent: c.timeUpdateInfo})
    return true
  }).map(c => extractSharedContentInfo(c.content))
  if (contentsInfoToSend.length){
    const msgToSend = {t:MessageType.CONTENT_INFO_UPDATE, v:JSON.stringify(contentsInfoToSend)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents info ${contentsInfoToSend.map(c=>c.id)} sent.`)
  }
}

messageHandlers.set(MessageType.REQUEST_RANGE, (msg, from, room) => {
  room.tick ++;
  const ranges = JSON.parse(msg.v) as number[][]
  const visible = ranges[0]
  const audible = ranges[1]

  pushParticipantsInRangeOrMovedOut(from, room, visible, audible)
  pushMousesInRangeOrMovedOut(from, room, visible, audible)

  const contents = Array.from(room.contents.values())
  pushContentsInRangeOrMovedOut(contents, from, visible, audible)
  pushContentsInfo(contents, from)

  from.sendMessages()
})

messageHandlers.set(MessageType.REQUEST_PARTICIPANT_STATES, (msg, from, room)=> {
  room.tick ++;
  const pids = JSON.parse(msg.v) as string[]
  for (const pid of pids) {
    const p = room.participantsMap.get(pid)
    if (p){ from.pushStatesToSend(p) }
  }
  from.sendMessages()
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST_BY_ID, (msg, from, room)=> {
  room.tick ++;
  const cids = JSON.parse(msg.v) as string[]
  const cs:ISharedContent[] = []
  for (const cid of cids) {
    const c = room.contents.get(cid)
    if (c) {
      cs.push(c.content)
      const sent = from.contentsSent.get(c)
      if (sent){
        updateContentSent(sent)
      }else{
        from.contentsSent.set(c, createContentSent(c))
      }
    }
  }
  msg.v = JSON.stringify(cs)
  msg.t = MessageType.CONTENT_UPDATE_REQUEST
  from.pushOrUpdateMessage(msg)
})

messageHandlers.set(MessageType.REQUEST_TO, (msg, from, room) => {
  room.tick ++;
  const pids = JSON.parse(msg.v) as string[]
  //console.log(`REQUEST_TO ${pids}`)
  msg.v = ''
  delete msg.p
  for(const pid of pids){
    const to = room.participantsMap.get(pid)
    if (to){
      if (to.storedMessages.has(MessageType.PARTICIPANT_INFO)){
        to.storedMessages.forEach(stored => from.pushOrUpdateMessage(stored))
        from.pushStatesToSend(to)
        //console.log(`Info for ${to.id} found and sent to ${from.id}.`)
      }else{
        const len = to.messagesTo.length
        to.pushOrUpdateMessage(msg)
        if (len != to.messagesTo.length){
          //console.log(`Info for ${to.id} not found and a request has sent.`)
        }
      }
    }
  }
})

function onParticipantLeft(msg: BMMessage, from: ParticipantStore, room: RoomStore){
  //console.log(`${JSON.stringify(msg)}`)
  let pids = JSON.parse(msg.v) as string[]
  if (!msg.v || pids.length === 0){ pids = [from.id] }
  for(const pid of pids){
    const participant = room.participantsMap.get(pid)
    if (participant){
      if (participant.socket.readyState !== websocket.WebSocket.CLOSED){
        participant.socket.close(1000, 'closed by PARTICIPANT_LEFT message.')
      }
      room.onParticipantLeft(participant)

      //console.log(`states: ${JSON.stringify(Array.from(participant.participantStates.values()))}`)
      const infoMsg = participant.storedMessages.get(MessageType.PARTICIPANT_INFO)
      const name = infoMsg ? JSON.parse(infoMsg.v).name : ''
      console.log(`Participant ${pid}:"${name}" left. ${room.participants.length} remain in "${room.id}".`)
    }else{
      console.warn(`Received a PARTICIPANT_LEFT message for ${pid} but not found.`)
    }
  }
  for(const participant of room.participants){
    const msgToSend = {t:MessageType.PARTICIPANT_LEFT, v:JSON.stringify(pids)}
    participant.pushOrUpdateMessage(msgToSend)
  }
}
messageHandlers.set(MessageType.PARTICIPANT_LEFT, onParticipantLeft)
messageHandlers.set(MessageType.PARTICIPANT_LEFT_BY_ERROR, (msg, from, room) => {
  if (from && room){
    //  Identity, not id: a participant who reconnected has a new store under the same id, and the
    //  old socket's close must not remove it (see the replacement in processData()).
    if (room.participantsMap.get(from.id) === from){
      const cause = JSON.parse(msg.v)
      console.warn(`Participant ${from.id} left by error.`
        + ` ${cause.errorType} code:${cause.code} reason:${cause.reason}`)
      msg.v=JSON.stringify([from.id])
      onParticipantLeft(msg, from, room)
    }
  }
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST, (msg, from, room) => {
  //console.log(JSON.stringify(msg))
  const cs = JSON.parse(msg.v) as ISharedContent[]
  const time = room.tick
  for(const newContent of cs){
    //  upate room's content
    let c = room.contents.get(newContent.id)
    if (c){
      c.timeUpdate = time
      if (!isEqualSharedContentInfo(c.content, newContent)) { c.timeUpdateInfo = time }
      c.content = newContent
    }else{
      c = {content:newContent, timeUpdate: time, timeUpdateInfo: time}
      room.contents.set(c.content.id, c)
    }
    //  The sender should not receive the update.
    from.contentsSent.set(c, createContentSent(c))
    from.contentsInfoSent.set(c, {content:c.content, timeSent: c.timeUpdateInfo})
  }
  //  console.log(`Contents update ${cs.map(c=>c.id)} at ${time}`)
})

messageHandlers.set(MessageType.CONTENT_REMOVE_REQUEST, (msg, from, room) => {
  const cids = JSON.parse(msg.v) as string[]
  room.removeContents(cids, from)
})

//--------------------------------------------------
//  Message queue and message handling
interface DataAndWs{
  msg: Message,
  ws: websocket.WebSocket
}
const dataQueue = new Array<DataAndWs>
export function processData():boolean{
  const top = dataQueue.shift()
  if (top){ //  peer
    if (!top.msg.t){
      console.error(`Invalid message: ${top.msg}`)
      return true
    }

    //  prepare participant and room
    let participant:ParticipantStore|undefined
    let room:RoomStore|undefined
    if (top.msg.r && top.msg.p){
      //  create room and participant
      room = rooms.getOrCreate(top.msg.r)
      participant = room.getParticipant(top.msg.p, top.ws)
      if (participant.socket !== top.ws){
        console.log(`Remove old participant with the same id '${participant.id}'.`)
        const oldSocket = participant.socket
        room.onParticipantLeft(participant)
        participant = room.getParticipant(top.msg.p, top.ws)
        //  Forget and drop the old socket now, so its close -- seconds later, or never, if the
        //  client is gone -- finds nobody to remove.
        rooms.sockMap.delete(oldSocket)
        oldSocket.terminate()
      }
      rooms.sockMap.set(top.ws, {room, participant})
      consoleDebug(`Participant ${participant.id} joined. ${room.participants.length} people in "${room.id}".`)
    }else{
      const rp = rooms.sockMap.get(top.ws)
      room = rp?.room
      participant = rp?.participant
    }

    //  call handler
    if (participant && room){
      const handler = messageHandlers.get(top.msg.t)
      if (handler){
        try{
          handler(top.msg, participant, room)
        }catch(error){
          console.error(`Handler for ${top.msg.t} threw an error: ${error}`, top.msg)
        }
      }else{
        console.error(`No message handler for ${top.msg.t} - ${top.msg}`)
      }
      //  The socket is closed; without this sockMap kept every socket ever opened.
      if (top.msg.t === MessageType.PARTICIPANT_LEFT_BY_ERROR){ rooms.sockMap.delete(top.ws) }
    }else{
      console.warn(`Could not call handler with room:"${room}" participant:"${participant}"`)
    }
    return true
  }
  return false
}


export function checkDataLogin(msg: MSConnectMessage){
  const promise = new Promise<void>((resolve, reject)=>{
    const roomLoginInfo = findRoomLoginInfo(msg.room)
    if (roomLoginInfo?.emailSuffixes.length){
      if (msg.token && msg.email){
        googleServer.authorizeRoom(msg.room, msg.token, msg.email, loginInfo).
          then(()=>{
            resolve()
          }).catch((e)=>{
            consoleDebug(`checkDataLogin rejected ${JSON.stringify(e)}`)
            reject()
          })
      }else{
        reject()
      }
    }else{
      resolve()
    }
  })
  return promise
}

//--------------------------------------------------
//  Functions to add listners to websocket
//
export function addDataListener(ds:DataSocket){
  ds.ws.addEventListener('message', (ev: websocket.MessageEvent) => {
    ds.lastReceived = Date.now()
    const msgs = JSON.parse(ev.data.toString()) as Message[]
    if (msgs.length){
      dataQueue.push(...msgs.map(msg => ({msg, ws:ds.ws})))
    }
  })

  if (ds.interval) console.error(`DataSocket ${ds.ws.url} already has a interval timer.`)
  const TIMEOUT = config.websocketTimeout
  //  Browser-answered pings keep a background tab alive (see addPeerListener in mainServer.ts).
  ds.ws.on('pong', () => { ds.lastReceived = Date.now() })
  ds.interval = setInterval(()=>{
    if (ds.lastReceived + TIMEOUT < Date.now()){
      const pAndR = rooms.sockMap.get(ds.ws)
      console.warn(`Data websocket for ${pAndR?.participant.id} timed out.`)
      //  terminate(), not close(): close() waits up to 30s for a handshake from a client that is
      //  already unresponsive, leaving a ghost participant visible to everyone meanwhile.
      ds.ws.terminate()
    }else if (ds.ws.readyState === ds.ws.OPEN){
      ds.ws.ping()
    }
  }, TIMEOUT/4)

  ds.ws.addEventListener('close', (ev)=>{
    if (ds.interval){
      clearInterval(ds.interval)
      ds.interval = undefined
    }
    const msg:Message = {
      t:MessageType.PARTICIPANT_LEFT_BY_ERROR,
      v:JSON.stringify({
        errorType: 'websocket closed',
        code:ev.code,
        reason: ev.reason
      }),
    }
    const dAndWs: DataAndWs = {
      msg,
      ws:ds.ws
    }
    dataQueue.push(dAndWs)
  })
}
