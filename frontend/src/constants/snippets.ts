export interface Snippet {
  label: string
  code: string
}

export const SNIPPETS: Snippet[] = [
  {
    label: 'shebang + strict',
    code: '#!/bin/bash\n\nset -euo pipefail\nIFS=$\'\\n\\t\'\n',
  },
  {
    label: 'if-else',
    code: 'if [[ "${1}" == "" ]]; then\n    echo "Usage: $0 <arg>"\n    exit 1\nfi\n',
  },
  {
    label: 'for loop',
    code: 'for item in "${array[@]}"; do\n    echo "$item"\ndone\n',
  },
  {
    label: 'while read',
    code: 'while IFS= read -r line; do\n    echo "$line"\ndone < "${input_file}"\n',
  },
  {
    label: 'function',
    code: 'my_func() {\n    local arg1="${1}"\n    echo "Running: ${arg1}"\n}\n',
  },
  {
    label: 'trap cleanup',
    code: 'cleanup() {\n    echo "Cleaning up..."\n    rm -f /tmp/tmpfile\n}\ntrap cleanup EXIT INT TERM\n',
  },
  {
    label: 'check root',
    code: 'if [[ $EUID -ne 0 ]]; then\n    echo "This script must be run as root" >&2\n    exit 1\nfi\n',
  },
  {
    label: 'log function',
    code: 'log() { echo "[$(date +"%Y-%m-%d %H:%M:%S")] $*" | tee -a "${LOGFILE:-/tmp/script.log}"; }\n',
  },
  {
    label: 'check command',
    code: 'command -v docker &>/dev/null || { echo "docker not found"; exit 1; }\n',
  },
  {
    label: 'read input',
    code: 'read -rp "Enter your name: " name\necho "Hello, $name!"\n',
  },
  {
    label: 'case statement',
    code: 'case "${ENV}" in\n    prod)   ENDPOINT="https://prod.example.com" ;;\n    stage)  ENDPOINT="https://stage.example.com" ;;\n    *)      echo "Unknown env: ${ENV}"; exit 1 ;;\nesac\n',
  },
  {
    label: 'docker run',
    code: 'docker run -d \\\n    --name myapp \\\n    --restart unless-stopped \\\n    -p 8080:80 \\\n    -e ENV_VAR=value \\\n    -v /data:/app/data \\\n    myimage:latest\n',
  },
  {
    label: 'kubectl apply',
    code: 'kubectl apply -f deployment.yaml\nkubectl rollout status deployment/myapp\nkubectl get pods -l app=myapp\n',
  },
  {
    label: 'ssh remote exec',
    code: "ssh -i ~/.ssh/key.pem -o StrictHostKeyChecking=no user@host \\\n    \"bash -s\" << 'EOF'\necho \"Running on remote host\"\nEOF\n",
  },
  {
    label: 'parse args',
    code: 'while [[ "$#" -gt 0 ]]; do\n    case $1 in\n        -e|--env)      ENV="$2"; shift ;;\n        -v|--verbose)  VERBOSE=1 ;;\n        -h|--help)     usage; exit 0 ;;\n        *)             echo "Unknown: $1"; exit 1 ;;\n    esac\n    shift\ndone\n',
  },
  {
    label: 'color output',
    code: 'RED="\\033[0;31m"; GREEN="\\033[0;32m"; YELLOW="\\033[1;33m"; NC="\\033[0m"\necho -e "${GREEN}Success${NC}"\necho -e "${RED}Error${NC}"\necho -e "${YELLOW}Warning${NC}"\n',
  },
  {
    label: 'retry loop',
    code: 'MAX_RETRY=5; RETRY=0\nuntil some_command; do\n    RETRY=$((RETRY+1))\n    [[ $RETRY -eq $MAX_RETRY ]] && { echo "Max retries reached"; exit 1; }\n    echo "Retry $RETRY/$MAX_RETRY in 5s..."\n    sleep 5\ndone\n',
  },
  {
    label: 'heredoc',
    code: "cat <<'EOF' > /tmp/config.conf\n[section]\nkey=value\nEOF\n",
  },
  {
    label: 'array ops',
    code: 'arr=("a" "b" "c")\necho "${arr[@]}"\necho "${#arr[@]}"\nfor i in "${!arr[@]}"; do echo "$i: ${arr[$i]}"; done\n',
  },
]

export const DEFAULT_CONTENT = `#!/bin/bash

set -euo pipefail
IFS=$'\\n\\t'

# Your script here
echo "Hello from BashForge!"
`
