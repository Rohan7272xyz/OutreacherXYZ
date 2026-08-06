#!/bin/bash
# Double-click me to start OutreacherXYZ (macOS)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  OutreacherXYZ needs Node.js, which isn't installed yet."
  echo "  Opening the download page — install the LTS version, then run me again."
  echo ""
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close this window…"
  exit 1
fi
exec node app/server.js
