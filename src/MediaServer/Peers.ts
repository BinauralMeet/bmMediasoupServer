//  Tracks which WebRTC transport ids belong to which peer, on the media-server (worker) side.
//  Extracted from media.ts as a dependency-free class so it's unit-testable without starting a
//  real mediasoup worker (media.ts starts one at module load time).
export interface PeerInfo {
  transports: string[]
}

export class Peers extends Map<string, PeerInfo> {
  addTransport(peerId: string, transId: string) {
    const peer = this.get(peerId)
    if (peer) {
      peer.transports.push(transId)
    } else {
      this.set(peerId, {transports: [transId]})
    }
  }
  //  Removes transId from peerId's list; once a peer has zero transports left, the peer entry
  //  itself is removed too (an empty entry left behind would otherwise never get cleaned up).
  removeTransport(peerId: string, transId: string) {
    const peer = this.get(peerId)
    if (!peer) { return false }
    peer.transports = peer.transports.filter((tid) => tid != transId)
    if (peer.transports.length === 0) {
      this.delete(peerId)
    }
  }
}
