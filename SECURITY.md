# Security Policy

## Core boundary

This project does not expose host shell execution. All model-requested command execution must go through `exec_container`, which runs commands inside a fixed Docker sandbox.

## What this protects

- host shell
- host filesystem outside workspace
- common secret locations
- Docker daemon socket
- default network access from executed commands

## What this does not fully protect

- files inside workspace when mounted read-write
- malicious commands run inside sandbox
- Docker runtime vulnerabilities
- secrets deliberately placed inside workspace and explicitly allowed
- network exfiltration if network is enabled by configuration

## Reporting security issues

Until this project has a published disclosure process, report privately to the maintainer.
