import { google } from "googleapis";
import { googleServer } from "../GoogleServer/GoogleServer";
import { MSCheckAdminMessage, MSCloseProducerMessage, MSCloseTransportMessage,
   MSCreateTransportReply, MSMessage, MSMessageType, MSPeerMessage, MSProduceTransportReply,
    MSRemoteUpdateMessage, MSRoomMessage, MSAddAdminMessage, MSUploadFileMessage,
    MSWorkerUpdateMessage } from "../MediaServer/MediaMessages";
import { findRoomLoginInfo, loginInfo } from "./mainLogin";
import { deletePeer, getPeer, getPeerAndWorker, handlersForPeer, handlersForWorker, mainServer, remoteUpdated, sendMSMessage } from "./mainServer";
import { Peer, toMSRemotePeer } from "./types";
import { consoleDebug, consoleError, stamp, userLog } from "./utils";

export function initHandlers(){
  //  handlers for peer
  handlersForPeer.set('join',(base, peer)=>{
    const join = base as MSRoomMessage;
    let room = mainServer.rooms.get(join.room);
    if (room?.peers) {
      room.peers.add(peer)
    }else{
      room = {
        id: join.room,
        roomName: join.room,
        peers: new Set<Peer>([peer]), // <--- The list of users in the Room
      }

      mainServer.rooms.set(room.id, room);
      userLog.log(`${stamp()}: room ${join.room} created: ${JSON.stringify(Array.from(mainServer.rooms.keys()))}`);
    }

    peer.room = room;
    userLog.log(`${stamp()}: ${peer.peer} joined to room '${join.room}' ${room.peers.size}`);
    //  Notify (reply) the room's remotes
    const remoteUpdateMsg:MSRemoteUpdateMessage = {
      type:'remoteUpdate',
      remotes: Array.from(peer.room.peers).map(peer => toMSRemotePeer(peer))
    };
    peer.lastSent = Date.now()
    sendMSMessage(remoteUpdateMsg, peer.ws);
  })
  handlersForPeer.set('leave', (_base, peer)=>{
    userLog.log(`${stamp()}: ${peer.peer} left from room '${peer.room?.id}' ${peer.room?.peers.size?peer.room?.peers.size-1:'not exist'}`)
    //console.log(`${stamp()}: ${peer.peer} left from room '${peer.room?.id}' ${peer.room?.peers.size?peer.room?.peers.size-1:'not exist'}`)
    if (peer.interval){
      clearInterval(peer.interval)
      peer.interval = undefined
    }
    deletePeer(peer)
  })
  handlersForPeer.set('leave_error', (base, peer)=>{
    if (mainServer.peers.has(peer.peer)){
      const msg = base as any
      console.warn(`Peer ${peer.peer} left by error. RTC websocket closed. code:${msg.code} reason:${msg.reason}`)
      deletePeer(peer)
    }
  })
  handlersForPeer.set('pong', (_base)=>{})

  // handle user upload image to google drive, return the file id
  handlersForPeer.set('uploadFile', (base, peer)=>{
    const msg = base as MSUploadFileMessage
    googleServer.login().then((logined) => {
      googleServer.uploadFile(msg.file, msg.fileName).then((result) => {
        if (result == 'upload error'){
          msg.error = 'upload error'
          msg.fileID = ''
          sendMSMessage(msg ,peer.ws)
        }
        else{
          msg.fileID = result as string
          sendMSMessage(msg ,peer.ws)
        }
      })
    })
  })

  // check if the user is admin
  handlersForPeer.set('checkAdmin', (base, peer)=>{
    consoleDebug(`checkAdmin called ${JSON.stringify(base)}`)
    const msg = base as MSCheckAdminMessage
    let room = mainServer.rooms.get(msg.room);
    if (!room || !room.peers.has(peer)){
      console.warn(`Room '${msg.room}' or peer '${peer.peer}' not found in 'checkAdmin' handler`)
      return
    }
    //  Check login info
    const roomLoginInfo = findRoomLoginInfo(room.roomName)
    if (roomLoginInfo && roomLoginInfo.admins.length){
      //  Room has admins and need auth needed.
      const admin = roomLoginInfo.admins.find((admin)=>admin === msg.email)
      if (admin){
        if (msg.token && msg.email){
          googleServer.authorizeRoom(room.roomName, msg.token, msg.email, loginInfo).then(()=>{
            peer.isAdmin = true
            msg.result = 'approve'
            msg.loginInfo = roomLoginInfo
            consoleDebug(`checkAdmin approve ${JSON.stringify(roomLoginInfo)}`)
          }).catch(()=>{
            msg.result = 'reject'
            consoleDebug(`checkAdmin rejected ${JSON.stringify(roomLoginInfo)}`)
          }).finally(()=>{
            sendMSMessage(msg ,peer.ws)
          })
          return
        }
      }
    }else{
      //  Room has no admins and everybody can be admin
      if (room.peers.has(peer)){
        peer.isAdmin = true
        msg.result = 'approve'
        msg.loginInfo = roomLoginInfo
        sendMSMessage(msg ,peer.ws)
        return
      }
    }
    msg.result = 'reject'
    sendMSMessage(msg ,peer.ws)
    return
  })

  function saveLoginFile(){
    googleServer.login().then(()=>{
      googleServer.saveLoginFile(JSON.stringify(loginInfo))
    }).catch((e)=>{
      console.warn(`googleServer.login() failed ${JSON.stringify(e)}`)
    })
  }
  const MINIMUM_NEW_ROOM_NAME_LENGTH = 7
  // addAdmin and save loginFile to google drive.
  handlersForPeer.set('addAdmin', (base, peer)=>{
    const msg = base as MSAddAdminMessage
    //  console.log("addAdmin called")
    if (peer.isAdmin && peer.room){
      let modifed = false
      let roomLoginInfo = findRoomLoginInfo(peer.room.roomName)
      if (!roomLoginInfo && peer.room.roomName.length >= MINIMUM_NEW_ROOM_NAME_LENGTH){
        modifed = true
        roomLoginInfo = {
          roomName:peer.room.roomName,
          emailSuffixes:[],
          admins:[]
        }
        loginInfo.rooms.push(roomLoginInfo)
      }
      if (roomLoginInfo){
        const admin = roomLoginInfo.admins.find(admin=>admin===msg.email)
        if (!admin){
          modifed = true
          roomLoginInfo.admins.push(msg.email)
        }
      }
      if (modifed) saveLoginFile()
      if (roomLoginInfo){
        msg.result = 'approve'
        msg.loginInfo = roomLoginInfo
        sendMSMessage(msg, peer.ws)
        return
      }
    }
    msg.result = 'reject'
    sendMSMessage(msg, peer.ws)
  })
  handlersForPeer.set('removeAdmin', (base, peer)=>{
    const msg = base as MSAddAdminMessage
    //  console.log("removeAdmin called")
    if (peer.isAdmin && peer.room){
      let roomLoginInfo = findRoomLoginInfo(peer.room.roomName)
      if (roomLoginInfo){
        const index = roomLoginInfo.admins.findIndex(admin=>admin===msg.email)
        if (index >= 0){
          roomLoginInfo.admins.splice(index, 1)
          saveLoginFile()
          msg.result = 'approve'
          msg.loginInfo = roomLoginInfo
          sendMSMessage(msg, peer.ws)
        }
      }
    }
    msg.result = 'reject'
    sendMSMessage(msg, peer.ws)
  })
  handlersForPeer.set('addLogin', (base, peer)=>{
    const msg = base as MSAddAdminMessage
    //  console.log("addLogin called")
    if (peer.isAdmin && peer.room){
      let modifed = false
      let roomLoginInfo = findRoomLoginInfo(peer.room.roomName)
      if (!roomLoginInfo && peer.room.roomName.length >= MINIMUM_NEW_ROOM_NAME_LENGTH){
        modifed = true
        roomLoginInfo = {
          roomName:peer.room.roomName,
          emailSuffixes:[],
          admins:[]
        }
        loginInfo.rooms.push(roomLoginInfo)
      }
      if (roomLoginInfo){
        const suffix = roomLoginInfo.emailSuffixes.find(suffix=>suffix===msg.email)
        if (!suffix){
          modifed = true
          roomLoginInfo.emailSuffixes.push(msg.email)
        }
        if (modifed) saveLoginFile()
        msg.result = 'approve'
        msg.loginInfo = roomLoginInfo
        sendMSMessage(msg, peer.ws)
        return
      }
    }
    msg.result = 'reject'
    sendMSMessage(msg, peer.ws)
  })
  handlersForPeer.set('removeLogin', (base, peer)=>{
    const msg = base as MSAddAdminMessage
    //  console.log("removeLogin called")
    if (peer.isAdmin && peer.room){
      let roomLoginInfo = findRoomLoginInfo(peer.room.roomName)
      if (roomLoginInfo){
        const index = roomLoginInfo.emailSuffixes.findIndex(suffix=>suffix===msg.email)
        if (index >= 0){
          roomLoginInfo.emailSuffixes.splice(index, 1)
          saveLoginFile()
          msg.result = 'approve'
          msg.loginInfo = roomLoginInfo
          sendMSMessage(msg, peer.ws)
        }
      }
    }
    msg.result = 'reject'
    sendMSMessage(msg, peer.ws)
  })

  //-------------------------------------------------------
  //  handlers for worker
  handlersForWorker.set('workerDelete',(base, ws)=>{
    const msg = base as MSPeerMessage
    mainServer.workers.delete(msg.peer)
  })
  handlersForWorker.set('workerUpdate',(base, ws)=>{
    const msg = base as MSWorkerUpdateMessage
    const worker = mainServer.workers.get(msg.peer)
    if (worker){
      worker.stat.load = msg.load
    }
  })


  //-------------------------------------------------------
  //  bridging(peer->worker / worker->peer) handlers
  function relayPeerToWorker(base: MSMessage){
    const msg = base as MSPeerMessage
    const remoteOrPeer = getPeerAndWorker(msg.remote? msg.remote : msg.peer)
    if (remoteOrPeer?.worker){
      consoleDebug(`P=>W ${msg.type} from ${msg.peer} relayed to ${remoteOrPeer.worker.id}`)
      const {remote, ...msg_} = msg
      sendMSMessage(msg_, remoteOrPeer.worker.ws)
    }
  }
  function relayWorkerToPeer(base: MSMessage){
    const msg = base as MSPeerMessage
    const peer = mainServer.peers.get(msg.peer)
    if (peer){
      consoleDebug(`W=>P ${msg.type} from ${peer.worker?.id} relayed to ${peer.peer}`)
      peer.lastSent = Date.now()
      sendMSMessage(msg, peer.ws)
    }
  }
  function setRelayHandlers(mt: MSMessageType){
    handlersForPeer.set(mt, relayPeerToWorker)
    handlersForWorker.set(mt, relayWorkerToPeer)
  }

  //-------------------------------------------------------
  //  handlers for both
  setRelayHandlers('rtpCapabilities')
  handlersForPeer.set('createTransport', relayPeerToWorker)
  handlersForWorker.set('createTransport', (base, worker)=>{
    const msg = base as MSCreateTransportReply
    const peer = getPeer(msg.peer)
    if (!peer){
      consoleError(`peer '${msg.peer}' not found.`)
      const cmsg: MSCloseTransportMessage= {
        type: 'closeTransport',
        transport: msg.transport,
      }
      if (worker?.ws){
        sendMSMessage(cmsg, worker.ws)
      }
      return
    }
    if (msg.transport){ peer.transports.push(msg.transport) }
    peer.lastSent = Date.now()
    sendMSMessage(base, peer.ws)
  })

  setRelayHandlers('connectTransport')

  handlersForPeer.set('produceTransport', relayPeerToWorker)
  handlersForWorker.set('produceTransport', (base, worker)=>{
    const msg = base as MSProduceTransportReply
    const peer = getPeer(msg.peer)
    if (!peer){
      consoleError(`peer '${msg.peer}' not found.`)
      if (msg.producer){
        const cmsg: MSCloseProducerMessage= {
          type: 'closeProducer',
          peer: msg.peer,
          producer: msg.producer,
        }
        if (worker?.ws){
          sendMSMessage(cmsg, worker.ws)
        }
      }
      return
    }
    if (msg.producer){
      if (peer.producers.find(p => p.role === msg.role && p.kind === msg.kind)){
        consoleError(`A producer for the same role "${msg.role}" and kind "${msg.kind}" already exists for peer "${peer.peer}".`)
      }else{
        consoleDebug(`new producer, role "${msg.role}" and kind "${msg.kind}" created for peer "${peer.peer}".`)
      }
      peer.producers.push({id:msg.producer, kind: msg.kind, role: msg.role})
    }
    peer.lastSent = Date.now()
    sendMSMessage(base, peer.ws)
    remoteUpdated([peer], peer.room!)
  })
  handlersForPeer.set('closeProducer', (base)=>{
    const msg = base as MSCloseProducerMessage
    const peer = mainServer.peers.get(msg.peer)
    if (peer){
      peer.producers = peer.producers.filter(pr => pr.id !== msg.producer)
      consoleDebug(`Close producer ${msg.producer}` +
        `remains:[${peer.producers.map(rp => rp.id).reduce((prev, cur)=>`${prev} ${cur}`, '')}]`)
      remoteUpdated([peer], peer.room!)
    }
    relayPeerToWorker(base)
  })
  handlersForWorker.set('closeProducer', relayWorkerToPeer)

  setRelayHandlers('consumeTransport')
  setRelayHandlers('resumeConsumer')
  setRelayHandlers('streamingStart')
  setRelayHandlers('streamingStop')
}
