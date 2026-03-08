#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"

mkdir -p "${CONFIG_DIR}/plugins" "${CONFIG_DIR}/commands"

cp "${ROOT_DIR}/plugin/index.js" "${CONFIG_DIR}/plugins/opencode-swarm.js"
cp "${ROOT_DIR}/commands/swarm.md" "${CONFIG_DIR}/commands/swarm.md"

if [ ! -f "${CONFIG_DIR}/package.json" ]; then
  cat > "${CONFIG_DIR}/package.json" <<'EOF'
{
  "type": "module",
  "dependencies": {
    "@opencode-ai/plugin": "^0.9.0"
  }
}
EOF
fi

echo "Installed opencode swarm plugin into ${CONFIG_DIR}"
echo "Restart opencode to load the plugin."
