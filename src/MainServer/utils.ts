import fs from 'fs'
import {Console} from 'console'

export const CONSOLE_DEBUG = false
export const consoleDebug = CONSOLE_DEBUG ? console.debug : (... arg:any[]) => {}
export const consoleLog = console.log
export const consoleError = console.error
export const userLogFile = fs.createWriteStream('/var/log/pm2/main_user.log', {flags:'a', encoding:'utf8'});
//  Without this, a missing/unwritable log directory (e.g. in a sandbox or test environment
//  without /var/log/pm2/) throws an unhandled 'error' event and crashes the whole process, just
//  because a log file couldn't be opened -- logging failures should never be fatal.
userLogFile.on('error', (e) => { console.error('userLogFile write error:', e.message) })
export const userLog = new Console(userLogFile)
export function stamp(){
  const date = new Date()
  return `${date.getFullYear()}-${(date.getMonth()+1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}, `
    + `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}:${date.getSeconds().toString().padStart(2,'0')}.${date.getMilliseconds().toString().padStart(3,'0')}`
}
