export interface LoginRoom{
  roomName: string
  emailSuffixes: string[],
  admins: string[]
}
export interface LoginInfo{
  rooms: LoginRoom[]
}
