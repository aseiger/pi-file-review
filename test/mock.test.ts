/**
 * Mock-harness integration test for the file-review extension.
 * Drives the real extension factory with stubbed ExtensionAPI/UI and
 * simulates tool execution between tool_call and tool_result events.
 *
 * Run: node --experimental-transform-types test/mock.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import extensionFactory from "../extensions/file-review.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name} ${extra}`);
	}
}

// ---------------------------------------------------------------------------
// stubs

type AnyHandler = (event: unknown, ctx: unknown) => unknown;
interface CommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface Notif {
	msg: string;
	type?: string;
}

type SelectStep = string | ((options: string[]) => string | undefined);

type SelectScript = SelectStep[];

class UiStub {
	notifications: Notif[] = [];
	statuses: Record<string, string | undefined> = {};
	selectScript: SelectScript = [];
	confirmScript: boolean[] = [];
	customDriver: ((comp: unknown, resolve: (r: unknown) => void) => void) | undefined;
	lastComponent: unknown;

	notify(msg: string, type?: string) {
		this.notifications.push({ msg, type });
	}
	setStatus(key: string, text: string | undefined) {
		this.statuses[key] = text;
	}
	async select(_title: string, options: string[]) {
		const step = this.selectScript.shift();
		if (step === undefined) return options[options.length - 1];
		if (typeof step === "function") return step(options) ?? options[options.length - 1];
		return step;
	}
	async confirm(_title: string, _msg: string) {
		return this.confirmScript.shift() ?? true;
	}
	async custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown): Promise<T> {
		return new Promise<T>((resolve) => {
			const done = (r: T) => resolve(r);
			const comp = factory(
				{ requestRender: () => {} },
				{ fg: (_c: string, t: string) => t },
				{},
				done,
			);
			this.lastComponent = comp;
			if (this.customDriver) this.customDriver(comp, (r) => resolve(r as T));
			else (comp as { handleInput: (d: string) => void }).handleInput("\x1b");
		});
	}
}

function makeSessionManager(sessionId: string, cwd: string, branch: unknown[] = []) {
	return {
		getSessionId: () => sessionId,
		getCwd: () => cwd,
		getBranch: () => branch,
	};
}

interface MockPi {
	pi: {
		on: (event: string, handler: AnyHandler) => void;
		registerCommand: (name: string, spec: CommandSpec) => void;
		appendEntry: (customType: string, data?: unknown) => void;
	};
	handlers: Map<string, AnyHandler>;
	commands: Map<string, CommandSpec>;
	entries: Array<{ customType: string; data: unknown }>;
}

function makePi(): MockPi {
	const handlers = new Map<string, AnyHandler>();
	const commands = new Map<string, CommandSpec>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on: (event: string, handler: AnyHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, spec: CommandSpec) => {
			commands.set(name, spec);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
	};
	return { pi, handlers, commands, entries };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// scenario

const sessionId = "mock-session-1";
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "file-review-test-"));
fs.writeFileSync(path.join(workdir, "existing.txt"), "v1\n");
fs.writeFileSync(path.join(workdir, "keep.txt"), "untouched\n");
const storeDir = path.join(os.homedir(), ".pi", "agent", "file-review", sessionId);
fs.rmSync(storeDir, { recursive: true, force: true }); // no stale state between runs

const { pi, handlers, commands, entries } = makePi();
extensionFactory(pi as never);

const ui = new UiStub();
const baseCtx = {
	cwd: workdir,
	mode: "tui",
	hasUI: true,
	ui,
	sessionManager: makeSessionManager(sessionId, workdir),
	signal: undefined,
	isIdle: () => true,
};

const fire = async (event: string, payload: unknown) => {
	const h = handlers.get(event);
	if (!h) throw new Error(`no handler for ${event}`);
	await h(payload, baseCtx);
};

// Simulate pi executing the tool between tool_call and tool_result.
async function simulateWrite(rel: string, content: string) {
	await fire("tool_call", { type: "tool_call", toolCallId: `tc-${rel}`, toolName: "write", input: { path: rel, content } });
	fs.writeFileSync(path.join(workdir, rel), content); // "the tool ran"
	await fire("tool_result", {
		type: "tool_result",
		toolCallId: `tc-${rel}`,
		toolName: "write",
		input: { path: rel, content },
		content: [],
		isError: false,
	});
}

async function simulateEdit(rel: string, edits: Array<{ oldText: string; newText: string }>) {
	await fire("tool_call", { type: "tool_call", toolCallId: `tc-${rel}`, toolName: "edit", input: { path: rel, edits } });
	const abs = path.join(workdir, rel);
	let text = fs.readFileSync(abs, "utf8");
	for (const e of edits) text = text.replace(e.oldText, e.newText);
	fs.writeFileSync(abs, text); // "the tool ran"
	await fire("tool_result", {
		type: "tool_result",
		toolCallId: `tc-${rel}`,
		toolName: "edit",
		input: { path: rel, edits },
		content: [],
		isError: false,
	});
}

console.log("session_start");
await fire("session_start", { type: "session_start" });
check("extension registered /changes command", commands.has("changes"));
check("no status initially", ui.statuses["file-review"] === undefined);

console.log("failed tool_result is not tracked");
await fire("tool_call", { type: "tool_call", toolCallId: "tc-fail", toolName: "write", input: { path: "fail.txt", content: "x" } });
await fire("tool_result", {
	type: "tool_result",
	toolCallId: "tc-fail",
	toolName: "write",
	input: { path: "fail.txt", content: "x" },
	content: [],
	isError: true,
});
await sleep(10);
check("failed write not listed", !JSON.stringify(entries).includes("fail.txt"));

console.log("agent writes (new + edit)");
await simulateWrite("new.txt", "fresh file\n");
await simulateEdit("existing.txt", [{ oldText: "v1", newText: "v2" }]);
await sleep(10);

const changeEntries = entries.filter((e) => e.customType === "file-review-change");
check("2 change entries recorded", changeEntries.length === 2, JSON.stringify(entries));
check(
	"created flag for new.txt",
	changeEntries[0].data !== undefined && (changeEntries[0].data as { created: boolean }).created === true,
);
check(
	"change entry stores absolute path",
	(changeEntries[0].data as { path: string }).path === path.join(workdir, "new.txt"),
);
check("status shows 2 pending", ui.statuses["file-review"] === "⚑ 2 file changes · /changes", JSON.stringify(ui.statuses));

// snapshot on disk for existing.txt
const snapFiles = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
check("snapshot dir created", snapFiles.length === 1, JSON.stringify(snapFiles));

const changes = commands.get("changes")!;

console.log("/changes: reject existing.txt via diff viewer");
ui.selectScript = ["M existing.txt  +1 −1", "Cancel"];
ui.customDriver = (comp, resolve) => {
	const c = comp as { render: (w: number) => string[]; handleInput: (d: string) => void };
	const lines = c.render(100);
	check("viewer renders title", lines.some((l) => l.includes("M existing.txt")), JSON.stringify(lines.slice(0, 4)));
	check("viewer renders diff", lines.some((l) => l.includes("+v2")) && lines.some((l) => l.includes("-v1")), JSON.stringify(lines));
	check("viewer renders hunk header", lines.some((l) => l.includes("@@")));
	c.handleInput("\x1b[50;50u"); // unknown input must be ignored, not crash
	c.handleInput("j"); // not a handled key
	c.handleInput("r"); // reject -> done({action:"reject"})
	resolve({ action: "reject" });
};
await changes.handler("", baseCtx);
check(
	"existing.txt restored to v1",
	fs.readFileSync(path.join(workdir, "existing.txt"), "utf8") === "v1\n",
);
const resolveEntries = entries.filter((e) => e.customType === "file-review-resolve");
check(
	"reject recorded as session entry",
	resolveEntries.length === 1 && (resolveEntries[0].data as { resolution: string }).resolution === "rejected",
	JSON.stringify(resolveEntries),
);
check("notify restored", ui.notifications.some((n) => n.msg.includes("Rejected existing.txt")), JSON.stringify(ui.notifications));
check("status now 1 pending", ui.statuses["file-review"] === "⚑ 1 file change · /changes", JSON.stringify(ui.statuses));

console.log("/changes accept-all: accepts new.txt");
ui.customDriver = undefined;
await changes.handler("accept-all", baseCtx);
check("accept-all resolved 1", entries.filter((e) => e.customType === "file-review-resolve").length === 2, JSON.stringify(entries));
check(
	"accept-all notify", ui.notifications.some((n) => n.msg.includes("Accepted 1 file change")),
	JSON.stringify(ui.notifications),
);
check("status cleared after accept-all", ui.statuses["file-review"] === undefined, JSON.stringify(ui.statuses));
check("new.txt still on disk (accepted)", fs.existsSync(path.join(workdir, "new.txt")));

console.log("re-edit after reject opens a new pending window");
await simulateEdit("existing.txt", [{ oldText: "v1", newText: "v3" }]);
await sleep(10);
check("status shows 1 pending again", ui.statuses["file-review"] === "⚑ 1 file change · /changes");

console.log("/changes: reject re-edit (restores v1)");
ui.selectScript = ["M existing.txt  +1 −1", "Cancel"];
ui.customDriver = (_c, resolve) => resolve({ action: "reject" });
await changes.handler("", baseCtx);
check(
	"existing.txt restored to v1 again",
	fs.readFileSync(path.join(workdir, "existing.txt"), "utf8") === "v1\n",
);
check("3 change entries total", entries.filter((e) => e.customType === "file-review-change").length === 3, JSON.stringify(entries));

console.log("keep.txt untouched throughout");
check("keep.txt intact", fs.readFileSync(path.join(workdir, "keep.txt"), "utf8") === "untouched\n");

// ---------------------------------------------------------------------------
// resume: rebuild state from session entries

console.log("resume rebuilds state from session branch");
const { pi: pi2, handlers: handlers2, commands: commands2 } = makePi();
extensionFactory(pi2 as never);
const ui2 = new UiStub();
const baseCtx2 = {
	...baseCtx,
	ui: ui2,
	sessionManager: makeSessionManager(sessionId, workdir, entries.map((e) => ({ type: "custom", ...e }))),
};
await handlers2.get("session_start")!({ type: "session_start" }, baseCtx2);
check("no pending after resume (all resolved)", ui2.statuses["file-review"] === undefined, JSON.stringify(ui2.statuses));

// /changes list shows history
const changes2 = commands2.get("changes")!;
ui2.customDriver = (_comp, resolve) => resolve(undefined);
await changes2.handler("list", baseCtx2);
const listComp = ui2.lastComponent as { render: (w: number) => string[] };
const listLines = listComp ? listComp.render(100).join("\n") : "";
check(
	"list shows resolved history",
	listLines.includes("existing.txt") && listLines.includes("accepted") && listLines.includes("rejected"),
	listLines,
);

// reject-all CLI path: seed a fresh pending file first, then reject-all via confirm
const fire3 = async (event: string, payload: unknown) => {
	const h = handlers2.get(event);
	if (!h) throw new Error(`no handler for ${event}`);
	await h(payload, baseCtx2);
};
await fire3("tool_call", { type: "tool_call", toolCallId: "tc-x", toolName: "write", input: { path: "x.txt", content: "x\n" } });
fs.writeFileSync(path.join(workdir, "x.txt"), "x\n");
await fire3("tool_result", {
	type: "tool_result",
	toolCallId: "tc-x",
	toolName: "write",
	input: { path: "x.txt", content: "x\n" },
	content: [],
	isError: false,
});
ui2.confirmScript = [true];
await changes2.handler("reject-all", baseCtx2);
check("reject-all deleted created file", !fs.existsSync(path.join(workdir, "x.txt")));
check("reject-all status cleared", ui2.statuses["file-review"] === undefined, JSON.stringify(ui2.statuses));

// a fresh edit on resume is pending and restorable (file is at v1 after the earlier rejects)
await fire3("tool_call", { type: "tool_call", toolCallId: "tc-r", toolName: "edit", input: { path: "existing.txt", edits: [{ oldText: "v1", newText: "v5" }] } });
const absR = path.join(workdir, "existing.txt");
fs.writeFileSync(absR, fs.readFileSync(absR, "utf8").replace("v1", "v5"));
await fire3("tool_result", {
	type: "tool_result",
	toolCallId: "tc-r",
	toolName: "edit",
	input: { path: "existing.txt", edits: [{ oldText: "v1", newText: "v5" }] },
	content: [],
	isError: false,
});
await sleep(10);
check("post-resume edit tracked as pending", ui2.statuses["file-review"] === "⚑ 1 file change · /changes", JSON.stringify(ui2.statuses));

ui2.selectScript = ["M existing.txt  +1 −1", "Cancel"];
ui2.customDriver = (_c, resolve) => resolve({ action: "reject" });
await changes2.handler("", baseCtx2);
check(
	"post-resume reject restores v1 (window before was v1)",
	fs.readFileSync(path.join(workdir, "existing.txt"), "utf8") === "v1\n",
	fs.readFileSync(path.join(workdir, "existing.txt"), "utf8"),
);

// ---------------------------------------------------------------------------
// bash (git) tracking fallback

const gitSid = "mock-git-session";
const gitdir = fs.mkdtempSync(path.join(os.tmpdir(), "file-review-git-"));
const gitStoreDir = path.join(os.homedir(), ".pi", "agent", "file-review", gitSid);
fs.rmSync(gitStoreDir, { recursive: true, force: true });
const g = (...args: string[]): string => execFileSync("git", args, { cwd: gitdir, encoding: "utf8" }).trim();
g("init", "-q");
g("config", "user.email", "test@example.com");
g("config", "user.name", "Test");
fs.writeFileSync(path.join(gitdir, "tracked.txt"), "tv1\n");
fs.writeFileSync(path.join(gitdir, "tracked2.txt"), "t2\n");
g("add", "-A");
g("commit", "-qm", "init");
fs.writeFileSync(path.join(gitdir, "ut.txt"), "ut-orig\n"); // untracked at baseline
fs.writeFileSync(path.join(gitdir, "ut3.txt"), "ut3-orig\n"); // untracked, deleted by "bash"

const { pi: pi3, handlers: handlers3, commands: commands3, entries: entries3 } = makePi();
extensionFactory(pi3 as never);
const ui3 = new UiStub();
const baseCtx3 = {
	...baseCtx,
	cwd: gitdir,
	ui: ui3,
	sessionManager: makeSessionManager(gitSid, gitdir),
};
const fire3b = async (event: string, payload: unknown) => {
	const h = handlers3.get(event);
	if (!h) throw new Error(`no handler for ${event}`);
	await h(payload, baseCtx3);
};
const changes3 = commands3.get("changes")!;

console.log("non-git session: bash tracking is a silent no-op");
const changeCountBeforeBash = entries.filter((e) => e.customType === "file-review-change").length;
await fire("tool_call", { type: "tool_call", toolCallId: "ng1", toolName: "bash", input: { command: "ls" } });
await fire("turn_end", { type: "turn_end", turnIndex: 1 });
await sleep(10);
check(
	"no bash entries outside git",
	entries.filter((e) => e.customType === "file-review-change").length === changeCountBeforeBash,
);

console.log("git session: baseline on first bash, attribution at turn_end");
await fire3b("session_start", { type: "session_start" });
// user's uncommitted edit at baseline time -> stash-create snapshot
fs.writeFileSync(path.join(gitdir, "tracked2.txt"), "t2-user\n");
await fire3b("tool_call", { type: "tool_call", toolCallId: "g-bash1", toolName: "bash", input: { command: "true" } });
// simulate bash effects
fs.writeFileSync(path.join(gitdir, "tracked.txt"), "tv-bash\n"); // M tracked
fs.rmSync(path.join(gitdir, "tracked2.txt")); // D tracked
fs.writeFileSync(path.join(gitdir, "u2.txt"), "u2-new\n"); // A untracked
fs.rmSync(path.join(gitdir, "ut3.txt")); // D untracked
fs.writeFileSync(path.join(gitdir, "ut.txt"), "ut-mod\n"); // M untracked (in place)
await fire3b("turn_end", { type: "turn_end", turnIndex: 1 });
await sleep(20);

const gitChanges = entries3.filter((e) => e.customType === "file-review-change");
check("5 bash change entries", gitChanges.length === 5, JSON.stringify(gitChanges));
check(
	"tracked.txt entry has git ref",
	typeof (gitChanges.find((e) => (e.data as { path?: string }).path === path.join(gitdir, "tracked.txt"))?.data as { ref?: string } | undefined)?.ref ===
		"string",
	JSON.stringify(gitChanges),
);
check(
	"created entries have no ref",
	gitChanges.filter((e) => (e.data as { created: boolean }).created).every((e) => (e.data as { ref?: string }).ref === undefined),
);
check(
	"status shows 5 pending",
	ui3.statuses["file-review"] === "⚑ 5 file changes · /changes",
	JSON.stringify(ui3.statuses),
);

console.log("/changes: reject all five bash changes");
const ACTIONS = ["✓ Accept all", "✗ Reject all", "Cancel"];
const pickFile = (options: string[]) => options.find((o) => !ACTIONS.includes(o));
// one pick step per pending file (5), whatever their label/order; then cancel
ui3.selectScript = [pickFile, pickFile, pickFile, pickFile, pickFile, "Cancel"];
ui3.customDriver = (_c, resolve) => resolve({ action: "reject" });
await changes3.handler("", baseCtx3);
await sleep(20);
check("tracked.txt restored to tv1", fs.readFileSync(path.join(gitdir, "tracked.txt"), "utf8") === "tv1\n");
check(
	"tracked2.txt restored to baseline (keeps user edit)",
	fs.readFileSync(path.join(gitdir, "tracked2.txt"), "utf8") === "t2-user\n",
	fs.readFileSync(path.join(gitdir, "tracked2.txt"), "utf8"),
);
check("u2.txt deleted", !fs.existsSync(path.join(gitdir, "u2.txt")));
check("ut3.txt restored from content snapshot", fs.readFileSync(path.join(gitdir, "ut3.txt"), "utf8") === "ut3-orig\n");
check("ut.txt restored from content snapshot", fs.readFileSync(path.join(gitdir, "ut.txt"), "utf8") === "ut-orig\n");
check("status cleared", ui3.statuses["file-review"] === undefined, JSON.stringify(ui3.statuses));

console.log("write/edit pending suppresses bash attribution for the same file");
// same turn: tool edit first, then bash touches the same file + creates another
await fire3b("tool_call", { type: "tool_call", toolCallId: "g-edit1", toolName: "edit", input: { path: "tracked.txt", edits: [{ oldText: "tv1", newText: "tv2" }] } });
fs.writeFileSync(path.join(gitdir, "tracked.txt"), "tv2\n");
await fire3b("tool_result", { type: "tool_result", toolCallId: "g-edit1", toolName: "edit", input: { path: "tracked.txt", edits: [] }, content: [], isError: false });
await fire3b("tool_call", { type: "tool_call", toolCallId: "g-bash2", toolName: "bash", input: { command: "true" } });
fs.writeFileSync(path.join(gitdir, "tracked.txt"), "tv3\n"); // bash over the same file
fs.writeFileSync(path.join(gitdir, "nb.txt"), "nb\n");
await fire3b("turn_end", { type: "turn_end", turnIndex: 2 });
await sleep(20);
const gitChanges2 = entries3.filter((e) => e.customType === "file-review-change");
const newBashEntries = gitChanges2.slice(5).filter((e) => (e.data as { via?: string }).via === "bash");
check(
	"only nb.txt attributed to bash (tracked.txt suppressed)",
	gitChanges2.length === 7 && newBashEntries.length === 1 && (newBashEntries[0].data as { path: string }).path === path.join(gitdir, "nb.txt"),
	JSON.stringify(gitChanges2.map((e) => `${(e.data as { via?: string }).via ?? "tool"}:${(e.data as { path: string }).path}`)),
);

// reject tracked.txt via the tool window (restores pre-tool state), nb.txt via bash
ui3.selectScript = ["M tracked.txt  +1 −1", "Cancel"];
ui3.customDriver = (_c, resolve) => resolve({ action: "reject" });
await changes3.handler("", baseCtx3);
await sleep(20);
check("tracked.txt restored to tv1 (tool window precedence)", fs.readFileSync(path.join(gitdir, "tracked.txt"), "utf8") === "tv1\n");
ui3.confirmScript = [true];
await changes3.handler("reject-all", baseCtx3);
await sleep(20);
check("nb.txt deleted via reject-all", !fs.existsSync(path.join(gitdir, "nb.txt")));
check("status cleared after reject-all", ui3.statuses["file-review"] === undefined, JSON.stringify(ui3.statuses));

// resume: bash entries replay with working restore
const { pi: pi4, handlers: handlers4, commands: commands4 } = makePi();
extensionFactory(pi4 as never);
const ui4 = new UiStub();
const baseCtx4 = {
	...baseCtx3,
	ui: ui4,
	sessionManager: makeSessionManager(gitSid, gitdir, entries3.map((e) => ({ type: "custom", ...e }))),
};
await handlers4.get("session_start")!({ type: "session_start" }, baseCtx4);
check("no pending after git-session resume", ui4.statuses["file-review"] === undefined, JSON.stringify(ui4.statuses));

// cleanup
fs.rmSync(workdir, { recursive: true, force: true });
fs.rmSync(gitdir, { recursive: true, force: true });
fs.rmSync(path.join(os.homedir(), ".pi", "agent", "file-review", sessionId), { recursive: true, force: true });
fs.rmSync(gitStoreDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll mock tests passed." : `\n${failures} mock test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
