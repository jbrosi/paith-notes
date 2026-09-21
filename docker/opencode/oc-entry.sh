#!/bin/sh
# Ensure opencode's state dirs exist under $HOME before exec'ing the command.
set -e
mkdir -p "$HOME/.local/share/opencode" "$HOME/.cache" "$HOME/.config"
exec "$@"
