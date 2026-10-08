/**
 * Git-based tracking of file changes made outside the write/edit tools
 * (i.e. via bash). Pure git + fs helpers, no pi imports (unit-testable).
 *
 * Model:
 *  - createBaseline() takes a point-in-time snapshot of the working tree
 *    (git stash create -> commit object, or HEAD when clean) plus the list
 *    of untracked (non-ignored) files, and optionally content-snapshots the
 *    untracked files so they remain restorable even though git never saw them.
 *  - changedSince() compares the baseline to the current worktree and
 *    reports per-file changes: tracked M/A/D (restorable via git) and
 *    untracked A/D (restorable via rm / content snapshot).
 *  - gitRestoreFile() puts one file back to its baseline state.
 *
 * Everything is fail-soft: any git failure returns undefined/empty so the
 * caller can simply skip tracking for that turn.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const REF_PREFIX = "refs/pi-file-review/";

export interface GitBaseline {
	/** Baseline commit SHA (stash-create commit or HEAD). */
	sha: string;
	/** Ref pinned for stash-created SHAs (undefined for HEAD). */
	ref: string | undefined;
	/** Absolute repo top-level directory. */
	toplevel: string;
	/** Untracked (non-ignored) files at baseline time, relative to toplevel. */
	untracked: string[];
}

export interface BashChange {
	absPath: string;
	relPath: string;
	kind: "M" | "D" | "A";
	/** True when the file did not exist at baseline time (reject = delete). */
	created: boolean;
	/** True when the file was untracked (non-ignored) at baseline time. */
	untracked: boolean;
}

export interface UntrackedCaps {
	maxFileBytes: number;
	maxTotalBytes: number;
	maxFiles: number;
}

export const DEFAULT_UT_CAPS: UntrackedCaps = {
	maxFileBytes: 20 * 1024 * 1024,
	maxTotalBytes: 100 * 1024 * 1024,
	maxFiles: 5000,
};

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
				resolve({ code: err ? 1 : 0, stdout: out, stderr: stderr ?? "" });
			},
		);
	});
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
	const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
	return r.code === 0 && r.stdout.toString().trim() === "true";
}

/**
 * Snapshot the worktree. `tag` names the ref that keeps the stash-created
 * commit reachable (recommend `<sessionId>-<epochMs>`).
 */
export async function createBaseline(cwd: string, tag: string): Promise<GitBaseline | undefined> {
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], 5000);
	if (top.code !== 0) return undefined;
	const toplevel = top.stdout.toString().trim();
	if (!toplevel) return undefined;

	const stash = await runGit(cwd, ["stash", "create"], 20000);
	let sha: string;
	let ref: string | undefined;
	const stashOut = stash.stdout.toString().trim();
	if (stash.code === 0 && stashOut) {
		sha = stashOut;
		ref = `${REF_PREFIX}${tag}`;
		const up = await runGit(cwd, ["update-ref", ref, sha], 5000);
		if (up.code !== 0) ref = undefined; // bare SHA still works until gc prunes it
	} else {
		const head = await runGit(cwd, ["rev-parse", "HEAD"], 5000);
		if (head.code !== 0) return undefined;
		sha = head.stdout.toString().trim();
		if (!sha) return undefined;
	}

	const ut = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], 10000);
	if (ut.code !== 0) return undefined;
	const untracked = ut.stdout.toString("utf8").split("\0").filter(Boolean);
	return { sha, ref, toplevel, untracked };
}

/** Content-snapshot the baseline's untracked files into `storeDir` (best effort). */
export async function snapshotUntracked(b: GitBaseline, storeDir: string, caps: UntrackedCaps = DEFAULT_UT_CAPS): Promise<void> {
	let total = 0;
	let count = 0;
	try {
		await fs.promises.mkdir(storeDir, { recursive: true });
	} catch {
		return;
	}
	for (const rel of b.untracked) {
		if (count >= caps.maxFiles) break;
		const abs = path.join(b.toplevel, rel);
		try {
			const stat = await fs.promises.stat(abs);
			if (!stat.isFile() || stat.size > caps.maxFileBytes) continue;
			if (total + stat.size > caps.maxTotalBytes) break;
			const data = await fs.promises.readFile(abs);
			await fs.promises.writeFile(path.join(storeDir, utFileName(abs)), data);
			total += data.length;
			count++;
		} catch {
			/* skip unreadable files */
		}
	}
}

export function utFileName(absPath: string): string {
	return `${createHash("sha256").update(absPath).digest("hex")}.ut`;
}

/**
 * Files that differ from the baseline: tracked M/A/D (vs baseline commit)
 * plus untracked additions/deletions/modifications. Renames/copies are
 * skipped (left to git).
 *
 * `utStore` (the store dir passed to snapshotUntracked) enables detecting
 * untracked files whose *content* changed in place, by comparing against
 * the captured baseline content.
 */
export async function changedSince(cwd: string, b: GitBaseline, utStore?: string): Promise<BashChange[]> {
	const out: BashChange[] = [];
	const seen = new Set<string>();
	const push = (absPath: string, relPath: string, kind: "M" | "D" | "A", created: boolean, untracked: boolean): void => {
		if (seen.has(absPath)) return;
		seen.add(absPath);
		out.push({ absPath, relPath, kind, created, untracked });
	};

	const diff = await runGit(cwd, ["diff", "--name-status", "-z", b.sha], 20000);
	if (diff.code === 0) {
		// -z framing: NUL-separated tokens: STATUS, path (renames/copies:
		// STATUS, oldpath, newpath — skipped, left to git)
		const tokens = diff.stdout.toString("utf8").split("\0");
		let i = 0;
		while (i < tokens.length) {
			const status = tokens[i]!;
			if (!status) {
				i++;
				continue;
			}
			const kind = status[0] as "M" | "D" | "A" | "R" | "C";
			if (kind === "R" || kind === "C") {
				i += 3; // STATUS, old, new
				continue;
			}
			if (kind !== "M" && kind !== "D" && kind !== "A") {
				i += 2;
				continue;
			}
			const rel = tokens[i + 1]!;
			i += 2;
			if (!rel) continue;
			push(path.join(b.toplevel, rel), rel, kind, kind === "A", false);
		}
	}

	const ut = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], 10000);
	if (ut.code === 0) {
		const now = new Set(ut.stdout.toString("utf8").split("\0").filter(Boolean));
		const baselineUntracked = new Set(b.untracked);
		for (const rel of now) {
			if (!baselineUntracked.has(rel)) push(path.join(b.toplevel, rel), rel, "A", true, true);
		}
		for (const rel of b.untracked) {
			if (!now.has(rel)) push(path.join(b.toplevel, rel), rel, "D", false, true);
		}
		// Untracked files present at both times: content changed in place?
		if (utStore) {
			for (const rel of now) {
				if (!baselineUntracked.has(rel)) continue;
				if (seen.has(path.join(b.toplevel, rel))) continue;
				const abs = path.join(b.toplevel, rel);
				const utFile = path.join(utStore, utFileName(abs));
				try {
					const utStat = await fs.promises.stat(utFile);
					const curStat = await fs.promises.stat(abs);
					if (!curStat.isFile()) continue;
					if (utStat.size !== curStat.size) {
						push(abs, rel, "M", false, true);
						continue;
					}
					const a = await fs.promises.readFile(utFile);
					const c = await fs.promises.readFile(abs);
					if (!a.equals(c)) push(abs, rel, "M", false, true);
				} catch {
					/* not snapshot / unreadable: undetectable, skip */
				}
			}
		}
	}
	return out;
}

/** Read a file's content as of the baseline commit. */
export async function gitShowFile(cwd: string, baselineSha: string, absPath: string): Promise<string | null> {
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], 5000);
	if (top.code !== 0) return null;
	const rel = path.relative(top.stdout.toString().trim(), absPath);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	const r = await runGit(cwd, ["show", `${baselineSha}:${rel}`], 10000);
	return r.code === 0 ? r.stdout.toString("utf8") : null;
}

/**
 * Restore one file to its baseline state:
 *  - existed at baseline: git restore --staged --worktree from the baseline
 *  - staged creation only: unstage and delete from the worktree
 */
export async function gitRestoreFile(cwd: string, baselineSha: string, absPath: string): Promise<{ ok: boolean; error?: string }> {
	const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], 5000);
	if (top.code !== 0) return { ok: false, error: "not a git work tree" };
	const rel = path.relative(top.stdout.toString().trim(), absPath);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, error: "file is outside the repository" };

	const exists = await runGit(cwd, ["cat-file", "-e", `${baselineSha}:${rel}`], 5000);
	if (exists.code === 0) {
		const r = await runGit(
			cwd,
			["restore", `--source=${baselineSha}`, "--staged", "--worktree", "--", rel],
			10000,
		);
		return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || "git restore failed" };
	}
	const unstage = await runGit(cwd, ["rm", "--cached", "-q", "--ignore-unmatch", "--", rel], 5000);
	if (unstage.code !== 0) return { ok: false, error: unstage.stderr.trim() || "git rm --cached failed" };
	try {
		await fs.promises.rm(absPath, { force: true });
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true };
}

/** Delete the refs pinned for a session (called when its store dir is pruned). */
export async function deleteSessionRefs(cwd: string, sessionId: string): Promise<void> {
	const r = await runGit(cwd, ["for-each-ref", "--format=%(refname)", `${REF_PREFIX}${sessionId}-*`], 5000);
	if (r.code !== 0) return;
	for (const ref of r.stdout.toString().split("\n").filter(Boolean)) {
		await runGit(cwd, ["update-ref", "-d", ref], 5000);
	}
}
