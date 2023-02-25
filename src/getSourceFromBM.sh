#!/bin/bash
sed -e "s_'@models/utils/coordinates'_'./coordinates'_g" ../../../binaural-meet/src/models/MapObject.ts > ./DataServer/MapObject.ts
sed -e "s_'@models/utils/coordinates'_'./coordinates'_g" ../../../binaural-meet/src/models/ISharedContent.ts > ./DataServer/ISharedContent.ts
sed -e "s_'mediasoup-client'_'mediasoup'_g" ../../../binaural-meet/src/models/conference/MediaMessages.ts > ./MediaMessages.ts

cp ../../../binaural-meet/src/models/conference/DataMessage.ts ./DataServer/
cp ../../../binaural-meet/src/models/conference/DataMessageType.ts ./DataServer/
cp ../../../binaural-meet/src/models/utils/coordinates.ts ./DataServer/
