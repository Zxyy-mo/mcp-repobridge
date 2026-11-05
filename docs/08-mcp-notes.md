# MCP Implementation Notes

## Preferred SDK

Use the official TypeScript MCP SDK if practical:

```text
@modelcontextprotocol/sdk
```

Codex should verify the latest import paths before final implementation.

## Transport phases

### Phase 1: stdio

Use stdio first to validate tools quickly in local agent environments.

### Phase 2: Streamable HTTP

Add HTTP transport for tunnel-based ChatGPT integrations.

Requirements:

- bind 127.0.0.1 by default
- bearer token authentication
- Origin validation
- no unauthenticated local HTTP endpoint
- tunnel setup remains external

## Tool registration rule

The tool registry should be explicit:

```ts
const tools = [
  readFileTool,
  listDirectoryTool,
  grepFilesTool,
  findFilesTool,
  execContainerTool,
  sandboxStatusTool,
];
```

No dynamic auto-registration of all modules.

## Forbidden names

Add a test to fail if any registered tool name includes:

```text
shell
host_exec
write
edit
```

Exception: documentation may mention forbidden names, but MCP tool registry must not contain them.
