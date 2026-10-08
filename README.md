# pi-file-review

Per-file **accept/reject** review of agent file changes for the [Pi coding agent](https://pi.dev) — the missing piece between pi's all-or-nothing checkpoint extensions (pi-rewind, cyclotomy) and VS Code agent harness-style change review.

Every `write`/`edit` the agent makes is tracked with a snapshot of the file's pre-change content. You review changes individually:

- **Accept** — keep the change, mark it reviewed
- **Reject** — restore the exact content the file had before the agent touched it (files the agent created are deleted)

Mix and match per file, in any order. A diff preview is shown before every reject.

File changes made through **bash** (e.g. `sed -i`, formatters, generated files) are tracked too, via a git fallback — each such file shows a `(bash)` marker in the lists.

## Install

```bash
# from this directory
pi install ./pi-file-review

# or from git
pi install git:github.com/<you>/pi-file-review

# or try it for one invocation
pi -e ./extensions/file-review.ts
```

## Usage

| Command | Effect |
|---|---|
| `/changes` | Interactive review: pick a file → diff overlay → `a` accept / `r` reject / `esc` back. Also `✓ Accept all`, `✗ Reject all` |
| `/changes list` | Summary of every tracked change (pending, accepted, rejected) with +/- stats |
| `/changes accept-all` | Keep all pending changes |
| `/changes reject-all` | Restore all pending files (with confirmation) |

A footer status line shows the pending count while there is anything to review:

```
⚑ 2 file changes · /changes
```

File markers in lists: `A` agent-created, `M` modified, `D` deleted-after-change, `✓` accepted, `↩` rejected.

## How it works

### write/edit tracking (works anywhere)

- `tool_call` (write/edit): reads the file's current content *before* the tool executes and holds it per tool call.
- `tool_result` (success): writes a snapshot to `~/.pi/agent/file-review/<sessionId>/` and records a hidden `file-review-change` session entry (`pi.appendEntry`, excluded from LLM context).
- Reject restores from the snapshot; for created files it deletes the file. The diff preview warns when the file no longer exists (reject would recreate it).

### bash tracking (git fallback)

- Before the **first bash call of each turn**, the worktree is snapshotted: `git stash create` (a commit object pinned under `refs/pi-file-review/<sessionId>-<ts>` so gc can't collect it; plain `HEAD` when the tracked tree is clean) plus the list of untracked non-ignored files, whose *contents* are also snapshot (capped: 20 MB/file, 100 MB total, 5000 files) so they stay restorable even though git never saw them.
- At `turn_end`, the baseline is diffed against the worktree: tracked `M`/`D`/staged-`A` via `git diff --name-status`, untracked additions/deletions via the file lists, and untracked in-place modifications via the content snapshots. Renames/copies are skipped (left to git).
- Rejecting a bash change to a tracked file runs `git restore --source=<baseline> --staged --worktree` (recreated staged additions are unstaged and deleted); untracked files use `rm` (created) or the captured content (modified/deleted).
- If a pending write/edit window exists for the same file, the bash attribution for it is skipped — the tool tracking is more precise.
- Silently disabled outside a git work tree.

### Shared semantics

- Accept/reject decisions are recorded as `file-review-resolve` entries, so state follows the session tree: it survives resume, `/tree` navigation, forks, and compaction. Replaying the branch rebuilds exactly which files are pending.
- If the agent changes a file again after you resolved it (via any tool), a new pending window opens — snapshot/baseline = state at that later change.

## Limitations

- Bash tracking requires a git work tree; outside one, only write/edit changes are tracked.
- Files larger than 20 MB are listed but not restorable (no snapshot taken); untracked content snapshots are capped at 100 MB per turn.
- Renames/copies done via bash are left to git (not restorable from here).
- Bash changes are attributed per *turn*: several bash calls in one turn appear as one change set (still reviewable per file).
- Rejecting overwrites whatever the file currently contains (including your manual edits since the agent's change) — the diff preview shows exactly what will be replaced.

## Development

```bash
npm install                      # typescript, @types/node, pi host packages (dev)
npx tsc -p tsconfig.json         # typecheck
node --experimental-transform-types test/diff.test.ts     # diff engine unit tests
node --experimental-transform-types test/gittrack.test.ts # git fallback unit tests (real temp repos)
node --experimental-transform-types test/mock.test.ts     # mock-harness integration test
```

The mock test drives the real extension factory with a stubbed `ExtensionAPI`/UI and simulates tool execution between `tool_call`/`tool_result` (including real git operations in a temp repo), covering: write/edit tracking, snapshots, the `/changes` flow, per-file reject/accept, re-edit windows, resume reconstruction, the bash/git fallback (baseline, attribution, all five restore paths), and write/edit precedence over bash attribution.
