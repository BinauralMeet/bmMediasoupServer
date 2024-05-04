interface Room{
  roomName: string
  emailSuffixes: string[],
  admins: string[]
}
export interface RoomsInfo{
  rooms: Room[]
}
