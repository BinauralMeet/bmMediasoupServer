import configGDrive from "./credentials.json";
import { google } from "googleapis";

export class GoogleDriveAuth {
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
    async dowloadJsonFile(fileId: string) {
      try {
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

    async authorizeRoom(room: string, email: string, roomData: any): Promise<boolean>{
      const promise = new Promise<boolean>((resolve, reject) => {
        console.log('authorizeRoom');
        const keys = Object.keys(roomData);
        const roomKey = room.split('_')[0] + '_'
        const domain = email.split('@')[1]
        console.log(keys)
        console.log("roomKey:["+roomKey+"]")
        console.log("domain:["+domain+"]")
        if (!keys.includes(roomKey)) {
          console.log("auth no need")
          resolve(true)
        } else {
          if(roomData[roomKey].includes(domain)){
            console.log("auth success")
            resolve(true)
          } else {
            console.log("auth failed")
            resolve(false)
          }
        }
      });
      return promise
    }
}