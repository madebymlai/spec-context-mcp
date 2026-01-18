#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
cd /home/laimk/git/spec-context-mcp
exec node dist/dashboard/cli.js --no-open
