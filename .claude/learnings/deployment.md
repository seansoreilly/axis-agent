# Deployment Learnings

## Deploy Workflow

- **Always deploy from local repo**: `DEPLOY_HOST="ubuntu@54.66.167.208" ./deploy.sh`
- **Deploy with secrets**: `./deploy.sh --sync-secrets`
- **Self-deploy (from server)**: `bash /home/ubuntu/agent/scripts/deploy-self.sh`
- Deploy automatically after tests pass — don't ask, just do it

## Systemd

- **ProtectHome=read-only** blocks all home dir writes. Every writable path must be in `ReadWritePaths`
- **Exit code 1** from SDK = filesystem permission issue. Check `ReadWritePaths` includes `~/.claude/`
- **Exit code 226/NAMESPACE** = a directory in `ReadWritePaths` doesn't exist. Create it before starting service
- After adding new env vars to `.env`, must `sudo systemctl restart claude-agent` to pick them up
- The service uses `EnvironmentFile=/home/ubuntu/agent/.env` — env vars are available to the main process and inherited by MCP server subprocesses

## Bitwarden Sync Issues

- The `sync-secrets.sh` script prompts for master password multiple times (once per vault item)
- Non-interactive mode can fail silently — vault items return empty
- **Always verify creds reached the server**: `ssh -i <key> ubuntu@<ip> "grep <VAR> /home/ubuntu/agent/.env"`
- If sync fails, manually append to server `.env` via SSH as a fallback
- After manual changes, update Bitwarden vault to stay in sync

## Infrastructure

- **SSH key**: `~/.ssh/claude-code-agent-key.pem`
- **Public IP**: `54.66.167.208` (use for SSH — MagicDNS doesn't work from dev machine)
- **Tailscale IP**: `100.99.15.13`
- **Username**: `ubuntu` (not `seans`)
- DERP relay issue: Windows Wi-Fi on "Public" profile blocks Tailscale direct tunnel. Fix: change to Private profile
