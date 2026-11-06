# Security policy

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[aantenore/reinloop](https://github.com/aantenore/reinloop/security/advisories/new). Please do not open a public
issue. Include the version (`reinloop --version`), the command or configuration, and what an attacker gains. Reports are
acknowledged as soon as possible; a confirmed issue is fixed in a patch release and listed under "Security" in the
[CHANGELOG](CHANGELOG.md).

## Supported versions

| Version | Security fixes |
|---|---|
| 0.3.x | yes |
| < 0.3 | no: upgrade to the latest 0.3.x |

A security fix may change behaviour in a patch release; every such change is listed in the CHANGELOG, marked
"Breaking" when it can stop a working setup.

## Threat model in brief

reinloop runs model output as tool calls on your machine. The model, tool results, web pages and MCP servers are
untrusted input; policy, budgets and the exposure guards below are the boundary.

- **The `shell` tool is not a sandbox.** It runs in the workspace root with your user's rights and a timeout. File
  tools refuse paths and symlinks that leave the workspace, but a shell command can do anything you can. Writes and
  commands ask for approval by default (`policy`); `-y` approves them all. Run untrusted tasks in a container or VM.
- **`serve` exposure.** It binds to `127.0.0.1` by default. A non-loopback `--host` refuses to start without a token
  (`--token` / `REINLOOP_API_TOKEN`) or a required identity verifier, unless `--insecure`. The `Host` header must be
  in an allow-list (DNS rebinding), a browser `Origin` must be the server's own or listed, `POST` bodies must be JSON,
  and body size and request time are limited. Without a token or verifier the API is open to whoever reaches it. See
  [docs/configuration.md](docs/configuration.md#serve).
- **Run ownership.** With an identity verifier, a caller reads and continues only the runs it started (same subject
  and identity kind); others get `404`, runs without a recorded subject and the run list are operator-only, and one
  request per run id runs at a time (`409`).
- **MCP isolation.** Stdio MCP servers get a minimal environment (`PATH`, `HOME`, locale, temp dirs) plus their `env`;
  pass more with `inheritEnv`. HTTP MCP servers with `auth` keep one session per run identity, opened with that
  identity's token.
- **Secrets.** Keys come from environment variables or `${env:...}` references and are masked in echoed error text.
  Nothing leaves your machine except model and tool requests unless you add a sink.

Out of scope: what a model chooses to do inside the permissions you granted, and MCP servers or plugins you install
(they run with your rights).
