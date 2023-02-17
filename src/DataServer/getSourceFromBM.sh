#!/bin/bash
sed -e "s_'@models/utils/coordinates'_'./coordinates'_g" ../../../../binaural-meet/src/models/MapObject.ts > MapObject.ts
sed -e "s_'@models/utils/coordinates'_'./coordinates'_g" ../../../../binaural-meet/src/models/ISharedContent.ts > ISharedContent.ts
cp ../../../../binaural-meet/src/models/conference/DataMessage.ts .
cp ../../../../binaural-meet/src/models/conference/DataMessageType.ts .
cp ../../../../binaural-meet/src/models/utils/coordinates.ts .
