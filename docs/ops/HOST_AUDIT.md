# Host audit

This script is the canonical host-level audit path for OpenClaw.

## Script
`scripts/openclaw-host-audit.sh`

## Purpose
Use this script for host verification only. It is the source of truth for:

- gateway health
- agent registry
- sandbox mode
- tools.deny policy
- Docker availability

## Required host capabilities
This script must run from a host-capable runtime with:

- `openclaw` CLI available
- access to host config under `~/.openclaw`
- Docker CLI available
- write access to the repo when changes are needed

## Not for sandbox runtimes
Sandbox agents must not claim host verification.

If a runtime is sandboxed and cannot access host tools, it must say:

> Host-level OpenClaw state not verifiable from sandbox runtime.

## Standard report format
All host audit summaries should separate:

1. Host verification
2. App/runtime verification
3. Unverified due to sandbox boundary
