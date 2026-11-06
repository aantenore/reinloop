# Contributing

Issues and pull requests are welcome. Keep changes small and focused, with a test for each behaviour change and the
docs page that describes the behaviour updated in the same change.

## Develop

```bash
npm install
npm run check        # typecheck + tests (node:test, no network); run it before every pull request
npm run build        # dist/ + schema/
npm run bench        # kernel overhead
```

reinloop has zero runtime dependencies; a change that adds one needs a strong reason. Every limit is configurable
(`docs/configuration.md#limits`), not a constant in the code.

Live checks talk to real services and are not part of CI:

```bash
npm run live:models -- qwen3:4b       # needs a running Ollama with the model pulled (uvx for the RAG scenario)
npm run live:integrations             # downloads the upstream MCP servers through npx/uvx
```

## CHANGELOG

Every user-visible change adds one line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the section that
fits: `Security`, `Changed`, `Added`, `Fixed`. Behaviour changes, also in a patch release, go under `Changed` or are
marked `Breaking:`.

## Release

1. Run the [CI workflow](.github/workflows/ci.yml) on `main` (Actions → ci → Run workflow) and check it passes on
   every Node version in its matrix.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## x.y.z - YYYY-MM-DD` and open a new empty `## Unreleased` above it;
   set `"version"` in `package.json` (and `package-lock.json`) to `x.y.z`.
3. Commit with the message `release: x.y.z`.
4. Tag that commit: `git tag -a vx.y.z -m "reinloop x.y.z"`, then push the commit and the tag.
5. Publish from the tagged commit: `npm publish` (`prepublishOnly` runs `npm run check` and the build).
6. Create the GitHub release from the tag with the CHANGELOG section as notes:
   `gh release create vx.y.z --title "reinloop x.y.z" --notes-file <the x.y.z section>`.
