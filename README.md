# repo-dash

Multi-repo git dashboard for the terminal: status across every repository,
expandable worktrees, and tmux-backed dev-server control.

Status: feature-complete. All six planned phases are in.

## Install

Requires Node 22 or newer and git. Dev-server control also needs tmux, and port
detection reads `ss` and `/proc`, so it runs on Linux and WSL2.

```bash
git clone https://github.com/chrisgen19/repo-dash-v1.git
cd repo-dash-v1
pnpm install      # installs dependencies and builds, through the prepare script
pnpm add -g .     # puts `repo-dash` on your PATH
```

Then run `repo-dash` from any directory, and `repo-dash --version` to confirm.

`pnpm add -g .` registers a link to this checkout rather than a copy, so the
global command always runs whatever was last built here. It replaces
`pnpm link --global`, which pnpm 11 removed.

### Updating

```bash
git pull
pnpm install      # picks up dependency changes
pnpm build        # pnpm install skips the build when dependencies are unchanged
```

Nothing needs reinstalling, since the global command is a link to this checkout.

### Uninstalling

```bash
repo-dash dev stop-all                           # dev servers live in tmux and outlast the tool
pnpm remove -g repo-dash
rm -rf ~/.config/repo-dash ~/.cache/repo-dash    # optional: config and cache
```

Stop dev servers first: once the command is gone, `tmux kill-server` or
`tmux kill-session -t <name>` is the only way to reach the `rd_` sessions.

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
| `roots[]` | `{path, maxDepth?, enabled?, label?}` | Trees to scan. `~`, `$VAR` and `${VAR}` are expanded. A bare string is shorthand for `{ "path": ... }`. Omitting the key re-seeds the defaults; an explicit `[]` means scan nothing. A `label` groups that root's repositories under a heading. |
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

Options may come before the command, so `repo-dash --refresh` opens the
dashboard on a fresh scan.

```bash
repo-dash                  # interactive dashboard (falls back to a table when piped)
repo-dash --refresh        # dashboard, bypassing the discovery cache
repo-dash --version        # print the installed version
repo-dash status           # branch, ahead/behind, dirty counts, worktree count
repo-dash fetch [<repo>]   # fetch every repository, or one; exits 1 if any fail
repo-dash status --expand  # with linked worktrees nested under each repo
repo-dash status --json    # machine-readable
repo-dash list             # discovered repos, cached
repo-dash list --refresh   # bypass the cache
repo-dash list --json      # machine-readable
repo-dash cache clear
```

Repositories are labelled by kind: a plain checkout is unmarked, while linked
worktrees show `(worktree)`, submodules show `(submodule)`, a bare repository
that owns a scanned worktree shows `(bare)`, and a `.git` pointer file with an
unrecognized target shows `(linked)`.

### Reading the status table

```
REPO             BRANCH     AHEAD/BEHIND  DIRTY  WT  LAST COMMIT
app              main       ↑2 ↓5         3      1   2 hours ago
  └ app-feature  feature/x  -             1          10 minutes ago
```

| Column | Meaning |
|---|---|
| `AHEAD/BEHIND` | `↑n` unpushed, `↓n` unpulled, `·` level, `-` no upstream, `?` unreadable |
| `FETCHED` | Time since the last fetch: `just now`, `3h ago`, `2d ago` (yellow from a day old), `never` if not fetched since cloning, `-` without an upstream |
| `DIRTY` | Changed entries including untracked; a trailing `!` means merge conflicts |
| `WT` | Linked worktrees, listed beneath the repo under `--expand` |

**Ahead and behind are measured against the last fetch**, so they are only as
fresh as the last time the remote was contacted. Nothing touches the network
until you ask: `f` fetches the selected repository in the dashboard, `F` or
`repo-dash fetch` fetches every one, and the `FETCHED` column shows how long
ago each last did.

Fetches never prompt. They run with no terminal attached and with
`GIT_TERMINAL_PROMPT=0`, so a remote that wants a password or an SSH
passphrase fails with git's message instead of taking over the dashboard.
Credential helpers, such as `gh auth git-credential`, still work.

A repository whose main worktree lies outside every configured root
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

## Dashboard

Running `repo-dash` with no arguments in a terminal opens the interactive
dashboard. Piping or redirecting it prints the static `status` table instead,
so `repo-dash | less` and `repo-dash > out.txt` still behave.

| Key | Action |
|---|---|
| `j` / `k`, arrows | Move the selection |
| `PgUp` / `PgDn`, `g` / `G` | Jump by ten, or to the ends |
| `Enter`, `Space` | Expand or collapse a repository's worktrees |
| `E` / `C` | Expand all, collapse all |
| `/` | Search by name, branch or path, including inside collapsed repositories. `Enter` keeps it, `Esc` clears it |
| `D` | Show only repositories with changes, worktrees included |
| `d` | Start a dev server for the selected repository or worktree |
| `s` / `x` | Stop it, or restart it |
| `l` | Toggle a log pane showing the selected server's recent output |
| `f` / `F` | Fetch the selected repository, or all of them; progress and any failure show in the footer |
| `a` | Attach to its tmux session; detach with `Ctrl-b d` |
| `o` | Open the selected row in `editor` |
| `r` / `R` | Reload, or reload bypassing the discovery cache |
| `q` | Quit |

Columns shrink to the terminal width, taking from `BRANCH` first, then `REPO`,
then `LAST COMMIT`. Below roughly 56 columns the minimum widths cannot all fit,
so columns are dropped instead of overflowing: `LAST COMMIT` goes first, then
`FETCHED`, `WT`, `AHEAD/BEHIND`, `DIRTY`, `DEV` and `BRANCH`. `REPO` is never dropped. The
selection is tracked by path rather than position, so it stays put across a
reload.

Searching looks inside collapsed repositories and matches a worktree on its own
name, branch and path, revealing matches without expanding first.

Giving a root a `label` groups its repositories under a heading, which is useful
for separating, say, personal work from client work:

```json
"roots": [
  { "path": "~/projects", "label": "personal" },
  { "path": "~/ag-projects", "label": "work" }
]
```

Headings are labels rather than entries, so the cursor skips them and the
position counter reports only real repositories.

The dashboard needs both stdin and stdout to be terminals. Redirecting either
one prints the static table instead, so `repo-dash < /dev/null` and
`repo-dash | less` both behave. Widths are measured in terminal cells, so CJK
names, emoji and combining accents line up and are never cut mid-glyph.

`o` hands the terminal to a terminal editor such as Vim, Nano or Helix and
takes it back when the editor exits. A windowed editor such as VS Code is
detached instead, so quitting the dashboard does not close it.

## Dev servers

Each dev server runs in its own detached tmux session, named `rd_<repo>_<hash>`.
That means they outlive the dashboard: quitting with `q` leaves them running,
and `repo-dash dev stop-all` is the escape hatch.

```bash
repo-dash dev                # what is running, with ports
repo-dash dev start <repo>   # by name, or by full path
repo-dash dev stop <repo>
repo-dash dev restart <repo>
repo-dash dev logs <repo> [--lines N]
repo-dash dev stop-all
```

Each session records the directory it was started for, so `repo-dash dev` lists
everything this tool is running even if that repository has since left the
configured roots. `start`, `stop` and `restart` accept any working directory the
dashboard can show, including a main checkout that sits outside the roots but
owns a worktree inside them, and any running session.

The command to run is worked out per repository: a `devCommand` override wins,
otherwise the first of `dev`, `start` or `serve` in `package.json`, run through
the package manager named in `packageManager` or implied by the lockfile.
A repository with nothing to run shows `-` in the `DEV` column and says why.

Ports are discovered rather than configured. `ss -ltnp` is read once, and each
listening socket's process is walked up `/proc` to see whether it descends from
a session's pane, so a server started as tmux → pnpm → node is still matched.

| `DEV` | Meaning |
|---|---|
| `● :3000` | running, listening on that port |
| `●` | running, no port detected yet |
| `○` | not running, but startable |
| `-` | nothing to run here |

### Logs

`l` opens a pane under the table showing the selected server's recent output,
re-read once a second and following the selection as it moves. The pane takes
at most half the space left after the table and always leaves the table at
least one row; in a terminal too short for that, it stays hidden and the footer
says so. The same output is available as `repo-dash dev logs <repo>`.

Output comes from `tmux capture-pane`, which strips escape sequences already.
Carriage returns are collapsed to the last segment of each line, so progress
bars show their final state rather than every step, and remaining control
bytes are removed.

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
  ui/app.tsx        interactive dashboard
  ui/rows.ts        shared row model and column fitting
  ui/format.ts      status formatting and label escaping
  ui/table.ts       plain-text table renderer
  proc/dev.ts       dev-server state, start, stop, restart, attach
  proc/pkg.ts       package manager and dev script detection
  proc/tmux.ts      tmux sessions
  proc/ports.ts     listening ports, matched through the process tree
  util/args.ts      argument parsing
  util/run.ts       bounded command runner
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
