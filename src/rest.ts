import express from 'express';
import {dataServer} from './DataServer/Stores'
import {mainServer} from './mainServer'
import {messageLoad} from './main';

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
  console.log(`get /\/room\/.+/g req: ${req.path}`)
//  console.log(req)
})

restApp.get('/messageLoad', function(req, res) {
  console.log(`get /messageLoad  req:${req.path}`)
  const rv = {messageLoad}
  res.json(rv)
})
