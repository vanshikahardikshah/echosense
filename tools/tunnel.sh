#!/bin/sh
# Keeps a public https link to the hub alive (needed only for the Webex card
# buttons and the Twilio key press). It reconnects by itself when the wifi
# blips or the laptop wakes up, and tells the hub the new link through
# tunnel-url.txt, so nothing needs restarting.
#   sh tools/tunnel.sh            (uses localhost.run, no account needed)
cd "$(dirname "$0")/.." || exit 1
PORT="${PORT:-8080}"
echo "Keeping a public link open to http://localhost:$PORT (Ctrl+C to stop)"
while true; do
  ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
      -o StrictHostKeyChecking=accept-new -R 80:localhost:"$PORT" nokey@localhost.run 2>&1 |
  while IFS= read -r line; do
    url=$(printf '%s\n' "$line" | grep -oE 'https://[a-z0-9]+\.lhr\.life' | head -n 1)
    if [ -n "$url" ]; then
      printf '%s\n' "$url" > tunnel-url.txt
      echo ""
      echo "  Public link: $url   (the hub picks it up by itself)"
      echo ""
    fi
  done
  echo "Link dropped. Reconnecting in 3 s..."
  sleep 3
done
