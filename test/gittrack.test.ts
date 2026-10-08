/**
 * Unit tests for the git tracking fallback, using a real temp git repo.
 * Run: node --experimental-transform-types test/gittrack.test.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as gittrack from "../extensions/gittrack.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name} ${extra}`);
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gittrack-test-"));
const store = fs.mkdtempSync(path.join(os.tmpdir(), "gittrack-store-"));
git(repo, "init", "-q");
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "user.name", "Test");
fs.writeFileSync(path.join(repo, "tracked.txt"), "t1\n");
fs.writeFileSync(path.join(repo, "tracked2.txt"), "t2\n");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");
fs.writeFileSync(path.join(repo, "u.txt"), "u-original\n"); // untracked at baseline
fs.writeFileSync(path.join(repo, "u3.txt"), "u3-original\n"); // untracked, deleted after baseline

check("isGitWorkTree true", (await gittrack.isGitWorkTree(repo)) === true);
check("isGitWorkTree false outside repo", (await gittrack.isGitWorkTree(os.tmpdir())) === false);

console.log("clean baseline -> HEAD, no untracked changes expected");
{
	const b = await gittrack.createBaseline(repo, "clean-test");
	check("clean baseline sha = HEAD", b !== undefined && b.sha === git(repo, "rev-parse", "HEAD"), JSON.stringify(b?.sha));
	check("clean baseline untracked lists u.txt + u3.txt", b !== undefined && b.untracked.length === 2, JSON.stringify(b?.untracked));
	check("clean baseline has no ref", b?.ref === undefined);
	const changes = await gittrack.changedSince(repo, b!);
	check("no changes on clean turn", changes.length === 0, JSON.stringify(changes));
}

console.log("dirty baseline -> stash create, full change set detected");
// A tracked worktree change at baseline time (e.g. the user's uncommitted
// edit) makes `git stash create` produce a real snapshot commit.
fs.writeFileSync(path.join(repo, "tracked.txt"), "t1-user-edit\n");
const b = await gittrack.createBaseline(repo, "dirty-test-1700000000000");
check("dirty baseline sha != HEAD", b !== undefined && b.sha !== git(repo, "rev-parse", "HEAD"), JSON.stringify(b?.sha));
check("dirty baseline pinned ref", b !== undefined && b.ref !== undefined, JSON.stringify(b?.ref));
await gittrack.snapshotUntracked(b!, store);

// simulate bash effects
fs.writeFileSync(path.join(repo, "tracked.txt"), "t1-bash\n"); // M tracked
fs.rmSync(path.join(repo, "tracked2.txt")); // D tracked
fs.writeFileSync(path.join(repo, "u.txt"), "u-modified\n"); // M untracked
fs.writeFileSync(path.join(repo, "u2.txt"), "u2-new\n"); // A untracked
fs.rmSync(path.join(repo, "u3.txt")); // D untracked
fs.writeFileSync(path.join(repo, "staged.txt"), "staged-new\n");
git(repo, "add", "staged.txt"); // A staged (tracked diff)

const changes = await gittrack.changedSince(repo, b!, store);
const byRel = new Map(changes.map((c) => [c.relPath, c]));
check("6 files changed", changes.length === 6, JSON.stringify(changes.map((c) => c.relPath)));
check(
	"tracked.txt M, not created, not untracked",
	byRel.get("tracked.txt")?.kind === "M" && byRel.get("tracked.txt")?.created === false && byRel.get("tracked.txt")?.untracked === false,
);
check(
	"tracked2.txt D tracked",
	byRel.get("tracked2.txt")?.kind === "D" && byRel.get("tracked2.txt")?.untracked === false,
);
check(
	"u.txt M untracked",
	byRel.get("u.txt")?.kind === "M" && byRel.get("u.txt")?.untracked === true && byRel.get("u.txt")?.created === false,
);
check(
	"u2.txt A untracked created",
	byRel.get("u2.txt")?.kind === "A" && byRel.get("u2.txt")?.created === true,
);
check(
	"u3.txt D untracked",
	byRel.get("u3.txt")?.kind === "D" && byRel.get("u3.txt")?.untracked === true,
);
check(
	"staged.txt A created (staged)",
	byRel.get("staged.txt")?.kind === "A" && byRel.get("staged.txt")?.created === true,
);

console.log("untracked content snapshots");
const utU = path.join(store, gittrack.utFileName(path.join(repo, "u.txt")));
const utU3 = path.join(store, gittrack.utFileName(path.join(repo, "u3.txt")));
check("u.txt snapshot captured", fs.existsSync(utU) && fs.readFileSync(utU, "utf8") === "u-original\n");
check("u3.txt snapshot captured", fs.existsSync(utU3) && fs.readFileSync(utU3, "utf8") === "u3-original\n");

console.log("gitShowFile reads baseline content");
check(
	"gitShowFile tracked.txt = baseline (user edit, not HEAD)",
	(await gittrack.gitShowFile(repo, b!.sha, path.join(repo, "tracked.txt"))) === "t1-user-edit\n",
);
check("gitShowFile missing file -> null", (await gittrack.gitShowFile(repo, b!.sha, path.join(repo, "u2.txt"))) === null);

console.log("gitRestoreFile");
{
	const r = await gittrack.gitRestoreFile(repo, b!.sha, path.join(repo, "tracked.txt"));
	check(
		"restore tracked.txt to baseline (user edit kept, bash change undone)",
		r.ok && fs.readFileSync(path.join(repo, "tracked.txt"), "utf8") === "t1-user-edit\n",
		JSON.stringify(r),
	);
}
{
	const r = await gittrack.gitRestoreFile(repo, b!.sha, path.join(repo, "tracked2.txt"));
	check("restore deleted tracked2.txt", r.ok && fs.readFileSync(path.join(repo, "tracked2.txt"), "utf8") === "t2\n", JSON.stringify(r));
}
{
	const r = await gittrack.gitRestoreFile(repo, b!.sha, path.join(repo, "staged.txt"));
	check("restore staged creation (unstage + delete)", r.ok && !fs.existsSync(path.join(repo, "staged.txt")), JSON.stringify(r));
	check("staged.txt no longer in index", !git(repo, "ls-files").includes("staged.txt"), git(repo, "ls-files"));
}

// untracked restores go through the extension's snapshot promotion; here verify
// the raw materials: u.txt restore = ut content, u3.txt restore = ut content.
fs.writeFileSync(path.join(repo, "u.txt"), fs.readFileSync(utU, "utf8"));
fs.writeFileSync(path.join(repo, "u3.txt"), fs.readFileSync(utU3, "utf8"));
// u2.txt (created by bash) is rejected via plain rm in the extension
fs.rmSync(path.join(repo, "u2.txt"));

console.log("after full restore, changedSince is empty");
{
	const changes2 = await gittrack.changedSince(repo, b!, store);
	check("clean after restore", changes2.length === 0, JSON.stringify(changes2.map((c) => c.relPath)));
}

console.log("deleteSessionRefs");
{
	const refsBefore = git(repo, "for-each-ref", gittrack.REF_PREFIX).split("\n").filter(Boolean);
	check("ref exists before prune", refsBefore.some((r) => r.includes("dirty-test-")), JSON.stringify(refsBefore));
	await gittrack.deleteSessionRefs(repo, "dirty-test");
	const refsAfter = git(repo, "for-each-ref", gittrack.REF_PREFIX).split("\n").filter(Boolean);
	check("ref gone after prune", !refsAfter.some((r) => r.includes("dirty-test-")), JSON.stringify(refsAfter));
}

// cleanup
fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(store, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll gittrack tests passed." : `\n${failures} gittrack test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
