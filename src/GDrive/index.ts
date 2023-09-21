import configGDrive from "./config/user-credentials.json";
import { drive_v3, google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import path from "path";
import process from "process";
import stream from "stream";

export class GoogleDrive {
  private _clientId: string;
  private _privateKey: string;
  private _scopes: string[];
  private _auth: any;

  constructor(
    clientId: string = configGDrive.client_id,
    privateKey: string = configGDrive.private_key,
    scopes: string[] = configGDrive.scopes
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

  async findFileByName(
    name: string,
    folderId: string = "1uQuJx-o26X1LxFQDLKi2kvKqD1-RhZao"
  ) {
    try {
      const drive = google.drive({ version: "v3", auth: this._auth });
      const res = await drive.files.list({
        q: `name = '${name}' and '${folderId}' in parents`,
        pageSize: 1,
        fields: "nextPageToken, files(id, name)",
      });
      return res.data.files;
    } catch (error) {
      return null;
    }
  }

  async listFiles() {
    try {
      const drive = google.drive({ version: "v3", auth: this._auth });
      const res = await drive.files.list({
        pageSize: 10,
        fields: "nextPageToken, files(id, name)",
      });
      return res.data.files;
    } catch (error) {
      return null;
    }
  }

  private _createJonFile(jsonData: any) {
    const blobStream = new stream.PassThrough();
    blobStream.end(JSON.stringify(jsonData));
    return blobStream;
  }

  async uploadJsonFile(jsonData: any, name?: string) {
    const blobStream = this._createJonFile(jsonData);
    if (!name) {
      this.uploadFile(blobStream);
      return;
    }
    this.uploadFile(blobStream, name);
  }

  async uploadFile(file: any, name = "RoomInfo.json") {
    try {
      const drive = google.drive({ version: "v3", auth: this._auth });
      /*const requestBody = {
        name,
        fields: '187smrhSsmXyotAApYb3N1XMLVthbAQuW',
      };*/
      const res = await drive.files.create({
        media: {
          body: file,
        },
        fields: "id",
        requestBody: {
          name,
          parents: ["1uQuJx-o26X1LxFQDLKi2kvKqD1-RhZao"], //
        },
      });
      console.log("data", res.data);

      // Set public permissions for the file
      /*await drive.permissions.create({
          fileId: res.data.id as string,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        });*/

      return res.data;
    } catch (error) {
      console.log("Error: ", error);
      return null;
    }
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
      return null;
    }
  }
}
