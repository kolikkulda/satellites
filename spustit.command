#!/bin/zsh
# Spustí aplikaci „Satelity nad námi“ na http://localhost:8777 a otevře ji v prohlížeči.
cd "$(dirname "$0")"
PORT=8777
(sleep 1; open "http://localhost:$PORT/") &
echo "Aplikace běží na http://localhost:$PORT – zavřením okna ji ukončíš."
exec python3 -m http.server $PORT --bind 127.0.0.1
