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
# edit bmMediasoupServer/config.js to disable debug setting and enable deply setting.
# comment out
# mainServer: "wss://localhost:3100",
# and enable
# //mainServer: "wss://main.titech.binaural.me", //  url to the main server

npm install --global yarn
yarn
yarn build
emacs ./dist/config.js  # edit config file to enable sections for Deploy instead of Debug.
yarn global add pm2
cd dist
#pm2 start ./src/main.js --log-date-format 'MM-DD HH:mm:ss.SSS' --name bm --node-args '--inspect'
#To inspect by local Chrome
# ssh -L 9339:localhost:9229 main.titech.binaural.me
# Then, open chrome://inspect and type 'global.d.mainServer' to see the mainServer object.

pm2 start ./src/media.js --log-date-format 'MM-DD HH:mm:ss.SSS' --name bmm --node-args '--inspect'
# ssh -L 9339:localhost:9229 media1.titech.binaural.me
# Then, open chrome://inspect and make port forwarding active.
# Then type 'global.d.mainServer' to see the mainServer object.

pm2 save
pm2 startup
ln -s /root/.pm2/logs /var/log/pm2

#install certbot and let's encrypt
ufw allow 80/tcp
ufw allow 443
ufw allow 3478
ufw allow 40000:49999/udp

apt-get install certbot
# get cert
certbot certonly -d $HOSTNAME

# add script to certbot's env
# --------------------------------------------------------------------
# for media server
echo \#\!/bin/bash > /etc/letsencrypt/renewal-hooks/pre/stopturn.sh
echo /etc/init.d/coturn stop >> /etc/letsencrypt/renewal-hooks/pre/stopturn.sh
echo \#/etc/init.d/nginx start >> /etc/letsencrypt/renewal-hooks/pre/stopturn.sh
chmod 777 /etc/letsencrypt/renewal-hooks/pre/stopturn.sh
echo \#\!/bin/bash > /etc/letsencrypt/renewal-hooks/post/startturn.sh
echo cp /etc/letsencrypt/live/$HOSTNAME/\*.pem /etc/coturn/certs/ >> /etc/letsencrypt/renewal-hooks/post/startturn.sh
echo chown turnserver /etc/coturn/certs/* >> /etc/letsencrypt/renewal-hooks/post/startturn.sh
echo chgrp turnserver /etc/coturn/certs/* >> /etc/letsencrypt/renewal-hooks/post/startturn.sh
echo /etc/init.d/nginx stop >> /etc/letsencrypt/renewal-hooks/post/startturn.sh
echo /etc/init.d/coturn start >> /etc/letsencrypt/renewal-hooks/post/startturn.sh
chmod 777 /etc/letsencrypt/renewal-hooks/post/startturn.sh
# --------------------------------------------------------------------
# for main server
# echo \#\!/bin/bash > /etc/letsencrypt/renewal-hooks/pre/stopbm.sh
# echo `which pm2` stop bm >> /etc/letsencrypt/renewal-hooks/pre/stopbm.sh
# echo /etc/init.d/nginx start >> /etc/letsencrypt/renewal-hooks/pre/stopbm.sh
# chmod 777 /etc/letsencrypt/renewal-hooks/pre/stopbm.sh
# echo \#\!/bin/bash > /etc/letsencrypt/renewal-hooks/post/startbm.sh
# echo /etc/init.d/nginx stop >> /etc/letsencrypt/renewal-hooks/post/startbm.sh
# echo `which pm2` start bm >> /etc/letsencrypt/renewal-hooks/post/startbm.sh
# chmod 777 /etc/letsencrypt/renewal-hooks/post/startbm.sh
# --------------------------------------------------------------------


#install coturn
apt-get install coturn
cd /etc
rm turnserver.conf
curl https://binaural.me/public_packages/media/turnserver.conf>turnserver.conf
chown turnserver turnserver.conf
chgrp turnserver turnserver.conf
setcap CAP_NET_BIND_SERVICE+ep /usr/bin/turnserver
mkdir /var/log/coturn
chmod 777 /var/log/coturn

cd /root
curl https://binaural.me/public_packages/media/updateCert.sh>updateCert.sh
chmod 777 updateCert.sh
./updateCert.sh

# https://blog.seaoak.jp/how-to-listen-privileged-ports/
setcap CAP_NET_BIND_SERVICE+ep /usr/bin/turnserver

/etc/init.d/coturn restart

# edit /etc/security/limits.conf  to increase max number of files to open
# *  hard  nofile  65535
# *  soft  nofile  65535
ulimit -n 65535

# https://qiita.com/okyk/items/2d7db6b148a43bc3b405
# https://lealog.hateblo.jp/entry/2020/03/28/124709
# https://groups.google.com/g/mediasoup/c/CwsxtmCcrh4/m/puOJlEDLBwAJ
# https://mediasoup.discourse.group/t/stun-turn-server/1775/10
# https://ja.tech.jar.jp/webrtc/turn.html
# TURNS  TURN over TLS

# hostname
# must be a FQDN (full name with domain).

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
