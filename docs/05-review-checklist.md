# Review Checklist

## Critical security review

- [ ] Search codebase for `child_process.exec`; it must not be used for model commands.
- [ ] Search codebase for `shell: true`; it must not be used for model commands.
- [ ] Search codebase for `sh -c` or host `bash -lc`; no model command should use host shell.
- [ ] Confirm `exec_container` calls `spawn("docker", args, { shell: false })`.
- [ ] Confirm model input cannot alter Docker args.
- [ ] Confirm model input cannot choose container name/id.
- [ ] Confirm model input cannot choose mount paths.
- [ ] Confirm the final container mount source is a managed temporary snapshot,
  not the configured host workspace.
- [ ] Confirm snapshot filtering applies the same secret-path policy as file reads.
- [ ] Confirm model input cannot enable network.
- [ ] Confirm no host write/edit tools are registered.
- [ ] Confirm forbidden tools are not hidden-only but actually absent.

## Path review

- [ ] Workspace root must be absolute.
- [ ] All paths must normalize and resolve under workspace root.
- [ ] Realpath checks must catch symlink escape.
- [ ] Secret-like path denylist must apply before reading.
- [ ] Directory listing must not dump huge trees by default.

## Docker review

- [ ] No Docker socket mount.
- [ ] No host HOME mount.
- [ ] No SSH/cloud/browser credential mount.
- [ ] network is none by default.
- [ ] root filesystem is read-only by default.
- [ ] tmpfs is provided for `/tmp`.
- [ ] non-root user is configured when possible.
- [ ] resource limits exist.
- [ ] sandbox writes cannot modify the host workspace and the snapshot is cleaned up.

## Audit review

- [ ] Audit records all tool calls.
- [ ] Audit records allow/deny decisions.
- [ ] Audit records exit code, duration, stdout/stderr byte counts.
- [ ] Audit does not log secret contents.
- [ ] Audit log file is not exposed by read_file unless explicitly allowed.

## Failure modes to test manually

```bash
../ traversal
absolute path escape
symlink to outside workspace
curl/wget/nc/ssh attempts
docker ps inside sandbox
cat ~/.ssh/id_rsa inside sandbox
sleep timeout
yes output flood
rm -rf /
rm -rf /workspace
```
