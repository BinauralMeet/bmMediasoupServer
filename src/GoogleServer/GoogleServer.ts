//import configGDrive from "../credentials.json";
import { google } from "googleapis"
import fs  from 'fs';
import {Readable} from 'stream'
import e from "express";

const config = require('../../config')
config ?? console.error('GoogleServer.ts failed to load config from "../../config"')
const configGDrive = require(`../../${config.googleOAuth2Config}`)
configGDrive ?? console.error('GoogleServer.ts failed to load configGDrive from "../../${config.googleOAuth2Config}"')

export class GoogleServer {
    private _clientId: string;
    private _privateKey: string;
    private _scopes: string[];
    private _auth: any;
    constructor(
      clientId: string = configGDrive.client_id,
      privateKey: string = configGDrive.private_key,
      scopes: string[] = [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.appdata',
        'https://www.googleapis.com/auth/drive.metadata',
        'https://www.googleapis.com/auth/drive.photos.readonly'
      ]

    ) {
      this._clientId = clientId;
      this._privateKey = privateKey;
      this._scopes = scopes;
    }
    get clientId(): string {
      return this._clientId;
    }
    get scopes(): string[] {
      return this._scopes;
    }
    async login() {
      try {
        const jwtClient = new google.auth.JWT(
          this._clientId,
          undefined,
          this._privateKey,
          this._scopes
        );
        const auth = await jwtClient.authorize();
        this._auth = jwtClient;
      } catch (error) {
        console.log(error);
      }
      return this;
    }
    async dowloadJsonFile() {
      try {
        const fileId = configGDrive.loginFileID
        const fileStream = await this.downloadFile(fileId);
        if (fileStream) {
          let fileContent = "";
          const promise = new Promise((resolve, reject) => {
            fileStream.on("data", (chunk: any) => {
              fileContent += chunk.toString();
            });
            fileStream.on("end", () => {
              resolve(fileContent);
            });
            fileStream.on("error", (error: any) => {
              reject(error);
            });
          });
          return promise;
        } else {
          console.log("File not found or error occurred.");
          throw new Error("File not found or error occurred.");
        }
      } catch (error) {
        console.error("Error:", error);
        throw new Error("Error to get jsonFile");
      }
    }


    async downloadFile(fileId: string) {
      try {
        const drive = google.drive({ version: "v3", auth: this._auth });
        const res = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "stream" }
        );
        return res.data;
      } catch (error) {
        console.error("Error:", error);
        return null;
      }
    }

    private bufferToStream(buffer:any) {
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null); // Signifies the end of the stream
      return stream;
    }

    async uploadFile(base64String: string, fileName_: string){
      const base64Data = base64String.replace(/^data:([A-Za-z-+/]+);base64,/, '');
      const fileName = fileName_;
      const dataBuffer = Buffer.from(base64Data, 'base64');

      const fileMetadata = {
        name: fileName,
        // replace the parent with the folder id you want to upload the file to

        // feiyang folder(test)
        //parents: ['1PqlaLr8TvJEOAurXmSHxKNWERdAWWmHt'],
        //Hase folder
        parents: ['1nNj7kGJQfDIVDfhgckNwVDhTwsBz7rza'],
      };
      const media = {
        mimeType: 'image/jpeg/png/jpg',
        body: this.bufferToStream(dataBuffer),
      };
      const drive = google.drive({ version: "v3", auth: this._auth });
      const params = {
        resource: fileMetadata,
        media: media,
        fields: 'id',
        supportsAllDrives:true
      };
      return new Promise((resolve, reject) => {
        let fileId = ''
        drive.files.create(params)
        .then(res => {
          if(res.data.id){
          fileId = res.data.id
          resolve(fileId)
          }
        })
        .catch(error => {
          console.error(error)
          resolve("upload error")
        });
      });

    }

    async authorizeRoom(roomName: string, email: string, roomData: any): Promise<string>{
      const promise = new Promise<string>((resolve, reject) => {
      const room = roomData.rooms.find((r:any) => r.roomName === roomName);

      if (!room) {
        resolve("guest")
      }
      else{
        const isAllowed = room.emailSuffixes.some((suffix:any) => email.endsWith(suffix));
        const isAdmin = room.admins.includes(email);
        if(isAllowed){
          if(isAdmin){
            resolve("admin")
          }else{
            resolve("guest")
          }
        }
        else{
          resolve("reject")
        }
      }
        // console.log('authorizeRoom');
        // const keys = Object.keys(roomData);
        // const roomKey = room.split('_')[0] + '_'
        // const domain = email.split('@')[1]
        // console.log(keys)
        // console.log("roomKey:["+roomKey+"]")
        // console.log("domain:["+domain+"]")
        // if (!keys.includes(roomKey)) {
        //   console.log("auth no need")
        //   resolve("true")
        // } else {
        //   if(roomData[roomKey].includes(domain)){
        //     console.log("auth success")
        //     resolve("true")
        //   } else {
        //     console.log("auth failed, you don't have the right to enter the room")
        //     resolve("false")
        //   }
        // }
      });
      return promise
    }
}