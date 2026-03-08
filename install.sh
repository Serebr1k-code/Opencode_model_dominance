#!/usr/bin/env bash
set -euo pipefail

REPO_RAW_BASE="https://raw.githubusercontent.com/Serebr1k-code/Opencode_model_dominance/main"
CONFIG_DIR="${HOME}/.config/opencode"

mkdir -p "${CONFIG_DIR}/plugins" "${CONFIG_DIR}/commands"

curl -fsSL "${REPO_RAW_BASE}/plugin/index.js" -o "${CONFIG_DIR}/plugins/opencode-swarm.js"
curl -fsSL "${REPO_RAW_BASE}/commands/swarm.md" -o "${CONFIG_DIR}/commands/swarm.md"

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
