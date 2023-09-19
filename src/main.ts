import websocket from "ws";
import https from "https";
import fs from "fs";
import debugModule from "debug";
import { MSPeerMessage, MSConnectMessage } from "./MediaServer/MediaMessages";
import {
  PingPong,
  Worker,
  Peer,
  mainServer,
  sendMSMessage,
} from "./mainServer";
import { addDataListener } from "./DataServer/dataServer";
import { dataServer } from "./DataServer/Stores";
import { addPositionListener } from "./PositionServer/positionServer";
import { restApp } from "./rest";
import { Console } from "console";
import { GoogleDrive } from "./GDrive";

const err = debugModule("bmMsM:ERROR");
const config = require("../config");

const CONSOLE_DEBUG = false;
const consoleDebug = CONSOLE_DEBUG ? console.debug : (...arg: any[]) => {};
const consoleLog = console.log;
const consoleError = console.log;

// Specify a log file path within your project directory
const logFilePath = "./logs/main_user.log";
const userLogFile = fs.createWriteStream(logFilePath, {
  flags: "a",
  encoding: "utf8",
});
export const userLog = new Console({
  stdout: userLogFile,
  stderr: userLogFile,
});

export function stamp() {
  const date = new Date();
  return (
    `${date.getFullYear()}-${date.getMonth().toString().padStart(2, "0")}-${date
      .getDate()
      .toString()
      .padStart(2, "0")}, ` +
    `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date
      .getMilliseconds()
      .toString()
      .padStart(3, "0")}`
  );
}

//--------------------------------------------------
//  utilities
function makeUniqueId(id: string, map: Map<string, any>) {
  if (!map.has(id)) {
    return id;
  }
  for (var i = 1; ; ++i) {
    const unique = `${id}${i}`;
    if (!map.has(unique)) {
      return unique;
    }
  }
}

//--------------------------------------------------
//  Websocket message handlers
function addCommonListner(pingPong: PingPong) {
  pingPong.ws.on("ping", () => {
    pingPong.ws.pong();
  });
  pingPong.ws.on("pong", (ev) => {
    pingPong.pongWait--;
    consoleDebug(`pong ${pingPong.pongWait}`);
  });
  pingPong.interval = setInterval(() => {
    if (pingPong.pongWait) {
      const id = (pingPong as Worker).id || (pingPong as Peer).peer;
      console.warn(
        `WS for '${id}' timed out. pong wait count = ${pingPong.pongWait}.`
      );
      pingPong.ws.close();
      clearInterval(pingPong.interval);
      return;
    }
    pingPong.ws.ping();
    pingPong.pongWait++;
  }, 20 * 1000);
}
function addPeerListener(peer: Peer) {
  console.log(`addPeerListener ${peer.peer} called.`);
  //console.log("Peer: ", peer)
  addCommonListner(peer);
  peer.ws.addEventListener("close", () => {
    consoleDebug(`WS for peer ${peer.peer} closed.`);
    mainServer.deletePeer(peer);
  });
  peer.ws.addEventListener(
    "message",
    async (messageData: websocket.MessageEvent) => {
      const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage;
      consoleDebug(`Msg ${msg.type} from ${msg.peer}`);
      console.log("gg: ", msg?.room);

      //HERE SERVER RECIEVE CLIENT MESSAGE DATA
      const roomName = msg?.room;
      if (roomName) {
        const gd = new GoogleDrive();
        const gdLogued = await gd.login();
        const filesRoom = await gdLogued.findFileByName(`${roomName}.json`);
        const files = [] as any;

        console.log("fileRoom", filesRoom);
        if (filesRoom) {
          filesRoom.forEach(async (file) => {
            console.log("file name: ", file.name);
            console.log("file id: ", file.id);
            // console.log("file",file.export);
            const downloaded = await gdLogued
              .dowloadJsonFile(file.id as string)
              .then((data) => {
                const handler = mainServer.handlersForPeer.get(msg.type);
                if (handler) {
                  handler(msg, peer);
                } else {
                  console.warn(
                    `Unhandle peer message ${msg.type} received from ${msg.peer}`
                  );
                }
              })
              .catch(console.error);
          });
          console.log("existe bb");
        }
      }
      // login.uploadJsonFile({ file: "gg" });

      // aqui bb va lo de validacion de logueo
      /*const handler = mainServer.handlersForPeer.get(msg.type);
      if (handler) {
        handler(msg, peer);
      } else {
        console.warn(
          `Unhandle peer message ${msg.type} received from ${msg.peer}`
        );
      }*/
    }
  );
}

function addWorkerListener(worker: Worker) {
  addCommonListner(worker);
  worker.ws.addEventListener("close", () => {
    consoleDebug(`WS for worker ${worker.id} closed.`);
    mainServer.deleteWorker(worker);
  });
  worker.ws.addEventListener(
    "message",
    (messageData: websocket.MessageEvent) => {
      const msg = JSON.parse(messageData.data.toString()) as MSPeerMessage;
      const handler = mainServer.handlersForWorker.get(msg.type);
      if (handler) {
        handler(msg, worker);
      } else {
        console.warn(
          `Unhandle workder message ${msg.type} received from ${msg.peer}`
        );
      }
    }
  );
}

//  After connection, this handler judge kind of the websocket and add appropriate handlers.
async function onFirstMessage(messageData: websocket.MessageEvent) {
  const ws = messageData.target;
  const msg = JSON.parse(messageData.data.toString()) as MSConnectMessage;
  consoleDebug(`PeerMsg ${msg.type} from ${msg.peer}`);
  console.log("Message: ", msg)

  /* const gdRes = gd.listFiles()

  gdRes.then((res) => {
    console.log("data res: ", res)
  })

  //Download File test
  const downloadedData = gd.downloadFile('106_J20VdvBXd3-Jd31eS7z_RpP1CxIN0')
  console.log("Downloaded data:", downloadedData)
 */
  //Here makes the connection to the WS
  if (msg.type === "connect") {
    let unique = "";
    let justBefore;

    if (
      msg.peerJustBefore &&
      (justBefore = mainServer.peers.get(msg.peerJustBefore))
    ) {
      mainServer.deletePeer(justBefore);
      consoleLog(
        `New connection removes ${justBefore.peer} from room ${justBefore.room?.id}` +
          `${
            justBefore.room
              ? JSON.stringify(
                  Array.from(justBefore.room.peers.keys()).map((p) => p.peer)
                )
              : "[]"
          }`
      );
      unique = makeUniqueId(justBefore.peer, mainServer.peers);
    } else {
      unique = makeUniqueId(msg.peer, mainServer.peers);
    }
    //console.log("login",unique, ws);
    msg.peer = unique;
    sendMSMessage(msg, ws);

    //  create peer
    const peer: Peer = {
      peer: unique,
      ws,
      producers: [],
      transports: [],
      pongWait: 0,
    };
    mainServer.peers.set(unique, peer);
    ws.removeEventListener("message", onFirstMessage);
    addPeerListener(peer);
    consoleDebug(
      `${unique} connected: ${JSON.stringify(
        Array.from(mainServer.peers.keys())
      )}`
    );
  } else if (msg.type === "dataConnect") {
    ws.removeEventListener("message", onFirstMessage);
    addDataListener(ws);
  } else if (msg.type === "positionConnect") {
    ws.removeEventListener("message", onFirstMessage);
    addPositionListener(ws, msg.peer);
  } else if (msg.type === "workerAdd") {
    const unique = makeUniqueId(msg.peer, mainServer.workers);
    msg.peer = unique;
    sendMSMessage(msg, ws);
    const { type, peer, ...msg_ } = msg;
    const worker: Worker = {
      ...msg_,
      id: msg.peer,
      ws,
      stat: { load: 0 },
      pongWait: 0,
    };
    mainServer.workers.set(msg.peer, worker);
    consoleLog(`addWorker ${msg.peer}`);
    ws.removeEventListener("message", onFirstMessage);
    addWorkerListener(worker);
  } else {
    console.warn(
      `invalid first message ${msg.type} received from ${msg.peer}.`
    );
  }
}

function main() {
  Object.assign(global, { d: { mainServer, dataServer } });
  // start https server
  consoleLog("starting wss server");
  try {
    const tls = {
      cert: fs.readFileSync(config.sslCrt),
      key: fs.readFileSync(config.sslKey),
    };
    const httpsServer = https.createServer(tls);
    httpsServer.on("error", (e) => {
      consoleError("https server error,", e.message);
    });

    const wss = new websocket.Server({ server: httpsServer });
    httpsServer.on("request", (req, res) => {
      //console.log(`request: ${JSON.stringify(req.headers)}`)
      restApp(req, res);
    });
    wss.on("connection", (ws) => {
      consoleDebug(`onConnection() `);
      ws.addEventListener("message", onFirstMessage);
    });

    return new Promise<void>((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        consoleLog(
          `server is running and listening on ` +
            `https://${config.httpIp}:${config.httpPort}`
        );
        resolve();
      });
    });
  } catch (e: any) {
    if (e.code === "ENOENT") {
      consoleError("no certificates found (check config.js)");
      consoleError("  could not start https server ... trying http");
    } else {
      err("could not start https server", e);
    }
  }
}

main();
