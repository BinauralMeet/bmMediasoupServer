// Port used for the ffmpeg/gstreamer process to receive RTP from mediasoup
const MIN_PORT = 20000
const MAX_PORT = 30000

const takenPortSet = new Set()

export function getPort(){
  let port = getRandomPort()

  while(takenPortSet.has(port)) {
    port = getRandomPort();
  }

  takenPortSet.add(port)

  return port
}

export function releasePort(port: number){
  takenPortSet.delete(port)
}

function getRandomPort(){
  return Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1) + MIN_PORT)
}
