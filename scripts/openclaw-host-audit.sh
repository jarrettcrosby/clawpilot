#!/usr/bin/env bash
set -euo pipefail

echo "# OpenClaw host audit"
echo
echo "Checked at: $(date)"
echo

echo "## Gateway probe"
openclaw gateway probe || true
echo

echo "## OpenClaw status"
openclaw status || true
echo

echo "## Agents list"
openclaw agents list || true
echo

echo "## Sandbox mode"
openclaw config get agents.defaults.sandbox --json || true
echo

echo "## tools.deny"
openclaw config get tools.deny --json || true
echo

echo "## Agents config"
openclaw config get agents --json || true
echo

echo "## Docker"
which docker || true
docker --version || true
docker ps || true
echo
