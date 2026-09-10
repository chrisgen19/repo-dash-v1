# repo-dash

Multi-repo git dashboard for the terminal: status across every repository, expandable
worktrees, and dev-server start/stop backed by tmux.

Status: phase 1 of 6 (config, discovery, cache). The TUI lands in phase 3.

## Install

```bash
pnpm install
pnpm build
pnpm link --global    # provides the `repo-dash` command
```

## Configuration

Config lives at `~/.config/repo-dash/config.json` and is created on first run,
seeded with whichever of `~/projects`, `~/ag-projects`, `~/code`, `~/dev`,
`~/work`, `~/src` exist.

```bash
repo-dash roots                          # show scan roots
repo-dash roots add ~/clients            # add a root
repo-dash roots add ~/archive --depth 2  # cap depth for one root
repo-dash roots rm ~/clients             # remove a root
repo-dash config edit                    # open the config in $EDITOR
repo-dash config path                    # print the config location
```

### Keys

| Key | Type | Purpose |
|---|---|---|
| `roots[]` | `{path, maxDepth?, enabled?, label?}` | Trees to scan. `~`, `$VAR` and `${VAR}` are expanded. |
| `ignore` | `string[]` | Skip patterns matched on the absolute path. `*` within a segment, `**` across segments. A bare word like `"docs"` matches any segment of that name. |
| `pruneDirs` | `string[]` | Directory names never descended into, at any depth. |
| `maxDepth` | `number` | Default descent depth, overridable per root. |
| `includeHidden` | `boolean` | Scan dot-directories. Off by default, since those are mostly tool state. |
| `scanInsideRepos` | `boolean` | Keep scanning below a repo root so nested repos are found. |
| `followSymlinks` | `boolean` | Off by default: on WSL2 symlinks often lead into `/mnt/c`, which is slow. |
| `concurrency` | `number` | Parallel directory reads and git invocations. |
| `editor` | `string` | Command used by the open-in-editor key. |
| `cacheTtlSeconds` | `number` | How long discovery results stay cached. |
| `repos` | `Record<path, override>` | Per-repo `devCommand`, `devScript`, `packageManager`, `hidden`. |

Example of a per-repo override:

```json
"repos": {
  "/home/you/projects/api": { "devCommand": "pnpm dev --port 4000" },
  "/home/you/projects/legacy": { "hidden": true }
}
```

## Commands

```bash
repo-dash list             # discovered repos, cached
repo-dash list --refresh   # bypass the cache
repo-dash list --json      # machine-readable
repo-dash cache clear
```

## Layout

```
src/
  cli.ts            entry point and subcommands
  config.ts         load, save, root management, path expansion
  cache.ts          TTL cache keyed by discovery inputs
  git/discover.ts   breadth-first scan for .git
  util/pool.ts      bounded-concurrency runner
  util/glob.ts      ignore-pattern matcher
```
