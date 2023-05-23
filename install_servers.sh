#!/bin/sh
#install bmMediasoupServer
cd /root

rm /etc/apt/sources.list.d/*
apt update
apt remove jitsi-videobridge2
apt upgrade
apt-get -y install git
apt-get -y install nodejs
apt-get -y install npm
apt-get -y install python3-pip
git clone https://github.com/BinauralMeet/bmMediasoupServer.git
cd bmMediasoupServer
npm install --global yarn
yarn
yarn build
yarn global add pm2
#pm2 start dist/main.js --log-date-format 'MM-DD HH:mm:ss.SSS'
pm2 start dist/media.js --log-date-format 'MM-DD HH:mm:ss.SSS'
pm2 save
ln -s /root/.pm2/logs /var/log/pm2

#install coturn
apt-get install coturn
cd /etc
rm turnserver.conf
curl https://binaural.me/public_packages/media/turnserver.conf>turnserver.conf
chown turnserver turnserver.conf
chgrp turnserver turnserver.conf

cd /root
curl https://binaural.me/public_packages/media/updateCert.sh>updateCert.sh
chmod 777 updateCert.sh
./updateCert.sh

setcap CAP_NET_BIND_SERVICE+ep /usr/bin/turnserver
/etc/init.d/coturn restart

# https://qiita.com/okyk/items/2d7db6b148a43bc3b405
# https://lealog.hateblo.jp/entry/2020/03/28/124709
# https://groups.google.com/g/mediasoup/c/CwsxtmCcrh4/m/puOJlEDLBwAJ
# https://mediasoup.discourse.group/t/stun-turn-server/1775/10
# https://ja.tech.jar.jp/webrtc/turn.html
# TURNS  TURN over TLS

#ufw status numbered   should be like this
#[ 1] 22/tcp                     ALLOW IN    Anywhere
#[ 2] 80/tcp                     ALLOW IN    Anywhere
#[ 3] 443                        ALLOW IN    Anywhere
#[ 4] 3478                       ALLOW IN    Anywhere
#[ 5] 40000:49999/udp            ALLOW IN    Anywhere
#[ 6] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
#[ 7] 80/tcp (v6)                ALLOW IN    Anywhere (v6)
#[ 8] 443 (v6)                   ALLOW IN    Anywhere (v6)
#[ 9] 3478 (v6)                  ALLOW IN    Anywhere (v6)
#[10] 40000:49999/udp (v6)       ALLOW IN    Anywhere (v6)
