#!/usr/bin/env bash
# Quick-start tmux session with Claude Code + dev server
# Usage: bash .devcontainer/start-tmux.sh

SESSION="work"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Attaching to existing tmux session '$SESSION'..."
  tmux attach -t "$SESSION"
else
  echo "Creating new tmux session '$SESSION'..."
  # Window 0: Claude Code
  tmux new-session -d -s "$SESSION" -n claude
  tmux send-keys -t "$SESSION:claude" "claude" Enter

  # Window 1: Dev server
  tmux new-window -t "$SESSION" -n dev
  tmux send-keys -t "$SESSION:dev" "npm run dev" Enter

  # Window 2: General terminal
  tmux new-window -t "$SESSION" -n shell

  # Focus on Claude window
  tmux select-window -t "$SESSION:claude"

  echo "tmux session '$SESSION' created with windows: claude, dev, shell"
  echo "Attaching..."
  tmux attach -t "$SESSION"
fi
