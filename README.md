# bmMediasoupServer
Mediasoup server for binaural meet

## Get started
node.js is needed and Mediasoup must be successfully installed.
Mediasoup requires python, visual C++, and msys2. msys2 should inherit windows' PATH. The python must be the windows's python. Git bash can not build Mediasoup.
shell for npm must be git bash. Need seeting:  npm config set script-shell "C:\\Program Files\\git\\bin\\bash.exe"

## Run
`yarn main`  run main server  (gateway for mediasoups)
`yarn media` run media server (use mediasoup)

## Debug
Using chrome inspector is a good method.
 - '--inspect' option is already added to 'yarn main'
 - Open chrome://inspect/ by Chrome
 - global.d.mainServer is the mainserver object.
