import {GoogleServer} from '../GoogleServer/GoogleServer';
import {LoginInfo} from '../GoogleServer/LoginInfo'
import {RoomLoginInfo} from '../MediaServer/MediaMessages';
export let loginInfo: LoginInfo
// check if room name is matched with the login file info.
export function findRoomLoginInfo(input: string): RoomLoginInfo|undefined {
  if (loginInfo?.rooms){
    for (const room of loginInfo.rooms) {
      if (room.roomName.endsWith('*')) {
        const baseRoomName = room.roomName.slice(0, -1);
        if (input.startsWith(baseRoomName)) {
          return room;
        }
      } else {
        if (room.roomName === input) {
          return room;
        }
      }
    }
  }
  return undefined;
}

function updateRoomInfo(gd: GoogleServer){
  gd.downloadLoginFile().then((roomData) => {
    loginInfo = JSON.parse(roomData as string) as LoginInfo
    //  console.log('roomsInfo:', JSON.stringify(roomsInfo))
  }).catch((err) => {
    console.log('Error in dowloadJsonFile', err)
  })
}
function observeLoginFile(gd: GoogleServer){
  updateRoomInfo(gd)
  setInterval(()=>{
    //  console.log('observeLoginFile: interval called')
    updateRoomInfo(gd)
  }, 60*1000)
}
export function startObserveConfigOnGoogleDrive(){
  console.log('startObserveConfigOnGoogleDrive()')
  const gd = new GoogleServer();
  gd.login().then((logined) => {
    observeLoginFile(gd)
  })
}
