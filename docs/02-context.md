# Context and Research Plan

MCP RepoBridge is an independent implementation. The repositories below were
reviewed only to understand workflow shape, MCP integration patterns, and
security tradeoffs.

## Repositories reviewed

```text
https://github.com/Zhenyu98/codex-chatgpt-bridge
https://github.com/Waishnav/devspace
```

## Inspection goals

### ChatGPT/Codex bridge-style workflows

Find:

- install entrypoint
- local bridge start/stop script
- generated MCP runtime config
- tunnel setup
- expected MCP URL shape
- allowedRoots handling
- whether the workflow assumes specific tool names
- places where an adapter can start MCP RepoBridge instead

### Broad local AI runtimes

Find:

- MCP server entrypoint
- tool registry
- read/list/grep/find implementations
- write/edit implementations
- shell execution implementation
- allowedRoots enforcement scope
- auth / OAuth / token code
- HTTP transport implementation
- whether shell can be disabled cleanly

## Decision criteria

Fork an existing broad runtime only if:

1. shell can be removed cleanly at tool registry level
2. no host shell fallback remains
3. write/edit can be removed cleanly
4. Docker exec can be substituted without deep runtime rewrite
5. tests can prove forbidden tools are gone

Otherwise, implement this package as a separate minimal runtime.

## Current architectural judgement

Treat broad local runtimes as useful references, not as the long-term security base. They tend to optimize for full AI IDE/runtime capability, while this project has a narrow repository-context and sandbox-execution goal.
