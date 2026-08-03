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

## Running on Linux (dev/sandbox setups behind a reverse proxy)

The steps above are for a native Windows/Mediasoup build. This server also
runs fine on Linux (e.g. inside a container, with node.js and yarn already
available — Mediasoup's native deps build normally there, none of the
Windows-specific tooling above is needed):

- Set `useHttp: true` in `config.js` if a TLS-terminating reverse proxy sits
  in front of this server (its own `httpIp`/`httpPort` then just needs to
  listen on plain HTTP). Never set this for a direct-facing deployment.
- `mediasoup.worker.rtcMinPort`/`rtcMaxPort` must match whatever UDP port
  range is actually reachable from the outside for this deployment. If that
  range is provided by a port-forwarding broker with a lease/TTL rather than
  a static firewall rule, `portfwd-renew.sh` keeps the lease alive
  (`portfwd-lease-id.txt` holds the current lease id) — run it detached
  alongside `yarn media`, and if it ever has to request a *new* lease (its
  log will say so), update `rtcMinPort`/`rtcMaxPort` to match and restart
  `yarn media`. Letting a lease expire silently breaks WebRTC connectivity
  while the server keeps running and announcing the now-unreachable ports as
  ICE candidates.

## `ROOM_PROP` message handling

`ROOM_PROP` is the one `MessageType` that multiplexes several
differently-named room properties as `[name, value]` tuples (every other
message type represents one specific piece of state, where "latest queued
wins" is correct). `ParticipantStore.pushOrUpdateMessage()`
(`src/DataServer/Stores.ts`) accepts a `mergeKeyExtra` so two different
properties queued back-to-back don't collide on the same `(type, peer)` slot
in the outgoing queue and clobber each other before either is sent — the
`ROOM_PROP` handler in `src/DataServer/dataServer.ts` is the only caller that
passes it. This mirrors the equivalent fix in binaural-meet's
`DataConnection.ts` `sendMessage()` on the client side; the two were verified
to still agree on the wire format (no message format change on either side).
