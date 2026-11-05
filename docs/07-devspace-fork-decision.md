# Fork Decision

## Question

Should we fork an existing broad local AI runtime, or write a smaller runtime?

## Recommendation

Write a smaller runtime.

Use existing broad runtimes as references for MCP transport, user experience, tool naming, and workflow ideas. Do not use one as the long-term security base unless inspection proves shell/write/edit can be cleanly removed and tested.

## Reasoning

Broad local AI development runtimes are useful, but our goal is narrower: create a minimal capability surface where host shell does not exist and execution only occurs in Docker.

A fork would likely spend most effort deleting or bypassing capabilities:

- host shell
- write/edit
- broad runtime assumptions
- tool prompts encouraging full local development control

Security products benefit from small code and small capability surfaces. A tiny bridge is easier to audit and explain.

## Fork only if all conditions pass

- shell tool is centralized and removable
- write/edit tools are centralized and removable
- tool registry can be cleanly controlled
- no hidden host shell fallback remains
- tests can prove forbidden tools are absent
- Docker exec substitution does not require invasive rewrite

## Default implementation path

```text
New repo: mcp-repobridge
  -> minimal MCP server
  -> safe read-only file tools
  -> Docker-only exec
  -> explicit threat model
```

## Compatibility with bridge-style workflows

After MVP, provide an adapter that can start this runtime for ChatGPT/Codex-style workflows. The bridge should provide:

- workspace root
- MCP URL
- token
- start/stop/status commands

It should not be responsible for security enforcement. Security enforcement belongs in MCP RepoBridge.
