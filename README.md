# repo-dash

Multi-repo git dashboard for the terminal: status across every repository, expandable
worktrees, and dev-server start/stop backed by tmux.

Status: phase 2 of 6 (config, discovery, cache, git status and worktrees).
The TUI lands in phase 3.

## Install

```bash
pnpm install
pnpm build
pnpm link --global    # provides the `repo-dash` command
```

## Configuration

Config lives at `$XDG_CONFIG_HOME/repo-dash/config.json` when `XDG_CONFIG_HOME`
is set, and `~/.config/repo-dash/config.json` otherwise. Run `repo-dash config path`
to print the resolved location.

It is created on first run, seeded with whichever of `~/projects`, `~/ag-projects`,
`~/code`, `~/dev`, `~/work`, `~/src` exist. **If none of them exist, the seed is
your home directory at `maxDepth: 3`**, so review the roots after a first run on a
new machine.

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
| `roots[]` | `{path, maxDepth?, enabled?, label?}` | Trees to scan. `~`, `$VAR` and `${VAR}` are expanded. A bare string is shorthand for `{ "path": ... }`. Omitting the key re-seeds the defaults; an explicit `[]` means scan nothing. |
| `ignore` | `string[]` | Skip patterns matched on the absolute path. `*` within a segment, `**` across segments. A bare word like `"docs"` matches any segment of that name. |
| `pruneDirs` | `string[]` | Directory names never descended into, at any depth. |
| `maxDepth` | `number` | Default descent depth, overridable per root. |
| `includeHidden` | `boolean` | Scan dot-directories. Off by default, since those are mostly tool state. |
| `scanInsideRepos` | `boolean` | Keep scanning below a repo root so nested repos are found. |
| `followSymlinks` | `boolean` | Off by default: on WSL2 symlinks often lead into `/mnt/c`, which is slow. |
| `concurrency` | `number` | Ceiling on parallel directory reads, and a shared ceiling on git subprocesses across every phase of a read. |
| `editor` | `string` | Command used by the open-in-editor key. Defaults to `$VISUAL`, then `$EDITOR`, then `code`. |
| `cacheTtlSeconds` | `number` | How long discovery results stay cached. |
| `repos` | `Record<path, override>` | Per-repo `devCommand`, `devScript`, `packageManager`, `hidden`. Paths are matched in both configured and canonical form, so a symlinked root still resolves. |

Example of a per-repo override:

```json
"repos": {
  "/home/you/projects/api": { "devCommand": "pnpm dev --port 4000" },
  "/home/you/projects/legacy": { "hidden": true }
}
```

## Commands

```bash
repo-dash status           # branch, ahead/behind, dirty counts, worktree count
repo-dash status --expand  # with linked worktrees nested under each repo
repo-dash status --json    # machine-readable
repo-dash list             # discovered repos, cached
repo-dash list --refresh   # bypass the cache
repo-dash list --json      # machine-readable
repo-dash cache clear
```

Repositories are labelled by kind: a plain checkout is unmarked, while linked
worktrees show `(worktree)`, submodules show `(submodule)`, and a `.git` pointer
file with an unrecognized target shows `(linked)`.

### Reading the status table

```
REPO             BRANCH     AHEAD/BEHIND  DIRTY  WT  LAST COMMIT
app              main       ↑2 ↓5         3      1   2 hours ago
  └ app-feature  feature/x  -             1          10 minutes ago
```

| Column | Meaning |
|---|---|
| `AHEAD/BEHIND` | `↑n` unpushed, `↓n` unpulled, `·` level, `-` no upstream, `?` unreadable |
| `DIRTY` | Changed entries including untracked; a trailing `!` means merge conflicts |
| `WT` | Linked worktrees, listed beneath the repo under `--expand` |

**Ahead and behind are measured against the last fetch**, so they are only as
fresh as the last time the remote was contacted. Nothing here touches the
network. A repository whose main worktree lies outside every configured root
but which owns a worktree inside one is shown as `name (external)`.

Linked worktrees are folded into their parent repository, so a worktree that
happens to sit inside a scanned root is listed once rather than as a repo of
its own. Submodules keep their own git directory and so remain separate
repositories.

Marking a path `hidden` removes it from the table. Hiding a main checkout
hides that repository whole, its worktrees included; hiding a single linked
worktree removes only that row. The dirty count in the summary line covers
every working tree shown, main checkouts and linked worktrees alike.

The discovery cache is keyed by the settings that affect results, including
expanded root paths and per-repo `hidden` overrides, so an edit takes effect on
the next run rather than after the TTL. A cache that cannot be written produces
a warning; the listing still succeeds.

## Layout

```
src/
  cli.ts            entry point and subcommands
  config.ts         load, save, root management, path expansion
  cache.ts          TTL cache keyed by discovery inputs
  git/discover.ts   breadth-first scan for .git
  git/exec.ts       git invocation with timeouts, never throws
  git/status.ts     porcelain=v2 --branch -z parser
  git/worktree.ts   worktree list --porcelain -z parser
  git/log.ts        last-commit reader
  git/snapshot.ts   groups worktrees with their parent repository
  ui/table.ts       plain-text table renderer
  util/args.ts      argument parsing
  util/fs.ts        canonical path resolution
  util/semaphore.ts shared concurrency ceiling
  util/pool.ts      bounded-concurrency runner
  util/glob.ts      ignore-pattern matcher
```

## Tests

```bash
pnpm check    # typecheck, build, test
pnpm test     # node:test runner, no test framework dependency
```
