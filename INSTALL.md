# Installation
## Common requirements
- Node.js 22 or newer.
- Codex CLI 0.147.0 when Codex sandbox execution is used.
- Run the server itself as a normal user. Do not run `server-main.mjs` as Administrator/root.
## Windows
The native elevated Codex sandbox needs a one-time Administrator-approved provisioning step. The server does not perform this silently.

Run the normal-user smoke check first:

```powershell
node scripts/codex-sandbox-check.mjs
```

If the Windows sandbox setup marker is missing, unreadable, or incompatible with the pinned setup format, the script asks in English whether to run the official setup command. It does not invoke `codex sandbox` first, so first-time provisioning cannot trigger UAC before your answer. It proceeds only when you type `y`; the Windows UAC/elevation prompt is then owned by Codex.

To provision it manually instead, run this from your normal PowerShell and explicitly approve the Windows UAC prompt when Codex requests Administrator privileges:

```powershell
codex sandbox setup --elevated --current-user
```

Then run the smoke check again. Do not run the server or ordinary development shell elevated.
## Linux / Codespaces
Linux does not use the Windows provisioning command. Verify the host sandbox directly:

```bash
node scripts/codex-sandbox-check.mjs
```

The underlying command is `codex sandbox /usr/bin/true` (or `/bin/true`). In the Codespaces devcontainer this check is non-interactive and therefore never requests Administrator/root setup.
## Additional sandbox paths
`codex sandbox` uses the current host OS sandbox implementation on Windows, Linux, and macOS. Extra read-only roots can be passed repeatedly with:

```text
--sandbox-state-readable-root <PATH>
```

Extra workspace-write roots belong in Codex configuration rather than an elevated setup script:

```toml
[sandbox_workspace_write]
writable_roots = ["/path/to/workspace"]
```

On Windows use normal Windows paths in `writable_roots`. Grant only the directories needed by the task; provisioning the Windows sandbox and granting project write roots are separate concerns.
