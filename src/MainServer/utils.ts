import fs from 'fs'
import {Console} from 'console'

export const CONSOLE_DEBUG = false
export const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
export const consoleLog = console.log
export const consoleError = console.log
export const userLogFile = fs.createWriteStream('/var/log/pm2/main_user.log', {flags:'a', encoding:'utf8'});
export const userLog = new Console(userLogFile)
export function stamp(){
  const date = new Date()
  return `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}, `
    + `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}:${date.getSeconds().toString().padStart(2,'0')}.${date.getMilliseconds().toString().padStart(3,'0')}`
}
