#!/bin/sh
# Start/stop helper for the bridge on the TV
DIR=/media/developer/govee-bridge
case "$1" in
  stop) pkill -f "$DIR/bridge.js"; echo stopped ;;
  *) pkill -f "$DIR/bridge.js" 2>/dev/null
     cd $DIR && NODE_PATH=/usr/palm/nodejs:/usr/lib/node_modules nohup node $DIR/bridge.js $DIR/config.json >/dev/null 2>&1 &
     echo started ;;
esac
