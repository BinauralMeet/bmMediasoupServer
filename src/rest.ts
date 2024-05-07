import express from 'express';
import {dataServer} from './DataServer/Stores'
import {mainServer} from './MainServer/mainServer'
import {messageLoad} from './main';
import {performance} from 'perf_hooks'

export const restApp = express();
const cors = require('cors');
restApp.use(express.json()); // for parsing restApplication/json
restApp.use(cors()); // enable CORS

// Let's create the regular HTTP request and response
restApp.get('/room', function(req, res) {
  console.log(`get /room  req:${req.path}`)
  let ids = Array.from(mainServer.rooms.keys())
  ids.push(... Array.from(dataServer.rooms.rooms.keys()))
  ids = ids.filter((id, index, self) => self.indexOf(id) === index) //  Make ids unique
  const rv = ids.map(id => {
    const data = dataServer.rooms.rooms.get(id)
    const main = mainServer.rooms.get(id)
    let nVideoTracks = 0
    let nAudioTracks = 0
    if (main){
      const peers = Array.from(main?.peers.values())
      for(const peer of peers){
        for(const producer of peer.producers){
          if (producer.kind === 'video') nVideoTracks ++
          if (producer.kind === 'audio') nAudioTracks ++
        }
      }
    }
    return {
      nPeers: main?.peers.size,
      nParticipants: data?.participants.length,
      nVideoTracks,
      nAudioTracks
    }
  })
  res.json(rv)
})

restApp.get(/\/room\/.+/g , function(req, res) {
  const roomId = req.path.substring(6)
  console.log(`get /\/room\/.+/g req: ${req.path} room:${roomId}`)

  const droom = dataServer.rooms.rooms.get(roomId)
  const rroom = mainServer.rooms.get(roomId)
  const peerKeys = rroom?.peers.keys()
  const peerIds = peerKeys ? Array.from(peerKeys).map(p=>p.peer) : []
  const contentKeys = droom?.contents.keys()
  const contentIds = contentKeys ? Array.from(contentKeys) : []
  res.json({
    peers: peerIds,
    participants:droom?.participants.map(p => p.id),
    contents:contentIds
  })
})

restApp.get('/load', function(req, res) {
  console.log(`get /load  req:${req.path}`)
  const utilization = performance.eventLoopUtilization()
  //console.log(`Process load: ${messageLoad.toPrecision(2)} utilization: ${JSON.stringify(utilization)}`)
  const rv = {...utilization, messageLoad}
  res.json(rv)
})
