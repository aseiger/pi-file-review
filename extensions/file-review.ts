/**
 * file-review — per-file accept/reject for agent file changes
 *
 * Tracks every write/edit the agent performs, snapshots the pre-change
 * file contents on disk, and lets you review each file individually:
 *
 *   /changes              interactive review (diff viewer, accept/reject per file)
 *   /changes list         summary of all tracked changes
 *   /changes accept-all   keep every pending change
 *   /changes reject-all   restore every pending file to its pre-change state
 *
 * Rejecting a file restores the exact content it had before the agent
 * first modified it in the current pending window (files the agent
 * created are deleted). Accepting just marks the change as reviewed.
 *
 * Snapshots live outside the repo in ~/.pi/agent/file-review/<sessionId>/
 * and change/decision records are stored as hidden session entries, so
 * state survives resume, /tree navigation, and compaction.
 *
 * Bash changes are tracked via a git fallback: before the first bash call of
 * each turn a worktree baseline is captured (git stash create + untracked
 * file list, with content snapshots of untracked files), and at turn end the
 * baseline diff yields per-file changes (marked "bash") that are restorable
 * through git (tracked files) or the captured content (untracked files).
 * Requires a git work tree; silently disabled outside one.
 *
 * Limitations:
 *  - bash tracking needs a git work tree (write/edit tracking does not)
 *  - files larger than 20 MB are listed but not restorable
 *  - renames/copies done via bash are left to git (not restorable here)
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { unifiedDiff, type DiffData } from "./diff.ts";
import * as gittrack from "./gittrack.ts";

const ENTRY_CHANGE = "file-review-change";
const ENTRY_RESOLVE = "file-review-resolve";
const STATUS_KEY = "file-review";
const STORE_ROOT = path.join(os.homedir(), ".pi", "agent", "file-review");
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const PRUNE_KEEP = 20;

// ---------------------------------------------------------------------------
// state

type Resolution = "accepted" | "rejected";

interface FileState {
	path: string; // absolute
	created: boolean; // true when the file did not exist before the agent touched it
	hasSnapshot: boolean; // pre-change content available on disk
	edits: number;
	status: "pending" | Resolution;
	/** How the change was detected: the write/edit tools, or the git/bash fallback. */
	via: "tool" | "bash";
	/** Baseline git SHA to restore from (bash-tracked, tracked-in-git files). */
	gitRef?: string;
}

interface PendingCall {
	path: string;
	before: string | null;
	tooBig: boolean;
}

class FileReview {
	private files = new Map<string, FileState>();
	private pendingCalls = new Map<string, PendingCall>();

	constructor(readonly sessionId: string, readonly cwd: string) {}

	get dir(): string {
		return path.join(STORE_ROOT, this.sessionId);
	}

	snapPath(abs: string): string {
		return path.join(this.dir, `${createHash("sha256").update(abs).digest("hex")}.before`);
	}

	private snapFile(abs: string): string {
		return this.snapPath(abs);
	}

	rel(abs: string): string {
		const r = path.relative(this.cwd, abs);
		return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : abs;
	}

	setPending(toolCallId: string, p: PendingCall): void {
		this.pendingCalls.set(toolCallId, p);
	}

	dropPending(toolCallId: string): void {
		this.pendingCalls.delete(toolCallId);
	}

	/** Called after a successful write/edit result. Returns the tracked state. */
	async commitToolResult(toolCallId: string): Promise<FileState | undefined> {
		const p = this.pendingCalls.get(toolCallId);
		this.pendingCalls.delete(toolCallId);
		if (!p) return undefined;

		let st = this.files.get(p.path);
		if (!st || st.status !== "pending") {
			st = {
				path: p.path,
				created: p.before === null,
				hasSnapshot: false,
				edits: 0,
				status: "pending",
				via: "tool",
			};
			this.files.set(p.path, st);
			if (p.before !== null && !p.tooBig) {
				try {
					await fs.promises.mkdir(this.dir, { recursive: true });
					await fs.promises.writeFile(this.snapFile(p.path), p.before);
					st.hasSnapshot = true;
				} catch {
					st.hasSnapshot = false;
				}
			}
		}
		st.edits++;
		return st;
	}

	/** Record (or replay from the session branch) a change for a file. */
	noteChange(abs: string, created: boolean, via: "tool" | "bash" = "tool", gitRef?: string): FileState {
		let st = this.files.get(abs);
		if (!st || st.status !== "pending") {
			st = {
				path: abs,
				created,
				hasSnapshot: !created && !gitRef && fs.existsSync(this.snapFile(abs)),
				edits: 0,
				status: "pending",
				via,
				gitRef,
			};
			this.files.set(abs, st);
		}
		st.edits++;
		return st;
	}

	hasPending(abs: string): boolean {
		return this.files.get(abs)?.status === "pending";
	}

	/** Replay a resolve entry from the session branch (resume path). */
	noteResolve(abs: string, resolution: Resolution): void {
		const st = this.files.get(abs);
		if (st && st.status === "pending") st.status = resolution;
	}

	pending(): FileState[] {
		return [...this.files.values()].filter((f) => f.status === "pending");
	}

	all(): FileState[] {
		return [...this.files.values()];
	}

	accept(abs: string): boolean {
		const st = this.files.get(abs);
		if (st && st.status === "pending") {
			st.status = "accepted";
			return true;
		}
		return false;
	}

	acceptAll(): number {
		let n = 0;
		for (const f of this.pending()) {
			f.status = "accepted";
			n++;
		}
		return n;
	}

	async reject(abs: string): Promise<{ ok: boolean; error?: string }> {
			const st = this.files.get(abs);
		if (!st || st.status !== "pending") return { ok: false, error: "not pending" };
		try {
			if (st.gitRef) {
				const res = await gittrack.gitRestoreFile(this.cwd, st.gitRef, st.path);
				if (res.ok) st.status = "rejected";
				return res;
			}
			if (st.created) {
				await fs.promises.rm(st.path, { force: true });
			} else if (st.hasSnapshot) {
				const data = await fs.promises.readFile(this.snapFile(st.path));
				await fs.promises.mkdir(path.dirname(st.path), { recursive: true });
				await fs.promises.writeFile(st.path, data);
			} else {
				return { ok: false, error: "no snapshot available for this file" };
			}
			st.status = "rejected";
			return { ok: true };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async diffOf(st: FileState): Promise<{ diff: DiffData; note?: string } | { error: string }> {
		let before: string | null;
		if (st.gitRef) {
			before = await gittrack.gitShowFile(this.cwd, st.gitRef, st.path);
			if (before === null) return { error: "baseline content unreadable" };
		} else if (st.created) {
			before = null;
		} else if (st.hasSnapshot) {
			try {
				before = (await fs.promises.readFile(this.snapFile(st.path))).toString("utf8");
			} catch {
				return { error: "snapshot unreadable" };
			}
		} else {
			return { error: "no snapshot available (cannot show diff)" };
		}
		let after: string | null;
		try {
			after = (await fs.promises.readFile(st.path)).toString("utf8");
		} catch {
			after = null;
		}
		let note: string | undefined;
		if (after === null && !st.created) note = "file no longer exists (reject would restore it)";
		if (after === null && st.created) note = "created file was deleted (reject keeps it deleted)";
		return { diff: unifiedDiff(before, after), note };
	}
}

// ---------------------------------------------------------------------------
// viewer component (bordered, scrollable box with per-line colors)

interface ViewerLine {
	text: string;
	color?: ThemeColor;
}

interface ViewerResult {
	action: "accept" | "reject";
}

class BoxViewer implements Focusable {
	/** Set by the TUI when focus changes. */
	focused = false;
	private offset = 0;
	private static readonly BODY = 18;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private title: string,
		private subtitle: string,
		private lines: ViewerLine[],
		private footer: string,
		private done: (r: ViewerResult | undefined) => void,
	) {}

	private maxOffset(): number {
		return Math.max(0, this.lines.length - BoxViewer.BODY);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter")) return this.done(undefined);
		if (data === "q") return this.done(undefined);
		if (data === "a") return this.done({ action: "accept" });
		if (data === "r") return this.done({ action: "reject" });
		const page = BoxViewer.BODY - 2;
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset(), this.offset + 1);
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
		else if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maxOffset(), this.offset + page);
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = this.maxOffset();
		else return;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; render: boolean } | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset - event.wheelDelta));
			this.tui.requestRender();
			return { handled: true, render: true };
		}
		return undefined;
	}

	invalidate(): void {}
	dispose(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(40, Math.min(width - 2, 100));
		const inner = w - 2;
		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content, inner) + th.fg("border", "│");

		const out: string[] = [];
		out.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
		out.push(row(` ${th.fg("accent", this.title)}`));
		if (this.subtitle) out.push(row(` ${th.fg("dim", this.subtitle)}`));
		out.push(row(th.fg("dim", "─".repeat(inner))));

		const body = this.lines.slice(this.offset, this.offset + BoxViewer.BODY);
		for (let i = 0; i < BoxViewer.BODY; i++) {
			const l = body[i];
			if (!l) {
				out.push(row(""));
				continue;
			}
			const text = l.color ? th.fg(l.color, l.text) : l.text;
			out.push(row(pad(` ${text}`, inner)));
		}

		const pos =
			this.lines.length === 0
				? ""
				: th.fg("dim", ` ${this.offset + 1}–${Math.min(this.lines.length, this.offset + BoxViewer.BODY)}/${this.lines.length}`);
		out.push(row(th.fg("dim", "─".repeat(inner))));
		out.push(row(` ${th.fg("dim", this.footer)}${pos}`));
		out.push(th.fg("border", `╰${"─".repeat(inner)}╯`));
		return out;
	}
}

// ---------------------------------------------------------------------------
// extension

export default function (pi: ExtensionAPI) {
	let review: FileReview | undefined;
	let turn: { baselined: boolean; baseline: gittrack.GitBaseline | undefined } = { baselined: false, baseline: undefined };

	function updateStatus(ctx: ExtensionCommandContext | { ui: { setStatus: (k: string, t: string | undefined) => void } }): void {
		try {
			const n = review?.pending().length ?? 0;
			ctx.ui.setStatus(STATUS_KEY, n > 0 ? `⚑ ${n} file change${n > 1 ? "s" : ""} · /changes` : undefined);
		} catch {
			/* non-interactive mode: no status bar */
		}
	}

	function pruneStore(): string[] {
		try {
			const entries = fs
				.readdirSync(STORE_ROOT, { withFileTypes: true })
				.filter((e) => e.isDirectory());
			if (entries.length <= PRUNE_KEEP) return [];
			const withMtime = entries
				.map((e) => {
					try {
						return { name: e.name, mtime: fs.statSync(path.join(STORE_ROOT, e.name)).mtimeMs };
					} catch {
						return { name: e.name, mtime: 0 };
					}
				})
				.sort((a, b) => b.mtime - a.mtime);
			const pruned: string[] = [];
			for (const e of withMtime.slice(PRUNE_KEEP)) {
				fs.rmSync(path.join(STORE_ROOT, e.name), { recursive: true, force: true });
				pruned.push(e.name);
			}
			return pruned;
		} catch {
			/* best effort */
			return [];
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const sm = ctx.sessionManager;
			const cwd = sm.getCwd();
			review = new FileReview(sm.getSessionId(), cwd);
			turn = { baselined: false, baseline: undefined };
			for (const entry of sm.getBranch()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === ENTRY_CHANGE) {
					const d = entry.data as { path?: string; created?: boolean; via?: string; ref?: string } | undefined;
					if (d?.path) {
						const via = d.via === "bash" ? "bash" : "tool";
						review.noteChange(d.path, d.created === true, via, typeof d.ref === "string" ? d.ref : undefined);
					}
				} else if (entry.customType === ENTRY_RESOLVE) {
					const d = entry.data as { path?: string; resolution?: Resolution } | undefined;
					if (d?.path && (d.resolution === "accepted" || d.resolution === "rejected")) {
						review.noteResolve(d.path, d.resolution);
					}
				}
			}
			for (const pruned of pruneStore()) {
				void gittrack.deleteSessionRefs(cwd, pruned).catch(() => {});
			}
			updateStatus(ctx);
		} catch (e) {
			ctx.ui.notify(`file-review: session_start error: ${e instanceof Error ? e.message : e}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
		review = undefined;
		turn = { baselined: false, baseline: undefined };
	});

	// Bash fallback: capture a git worktree baseline before the first bash
	// call of a turn so bash-side effects can be attributed and restored.
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName === "bash") {
				const r = review;
				if (r && !turn.baselined) {
					turn.baselined = true; // one attempt per turn, fail soft
					try {
						const baseline = await gittrack.createBaseline(ctx.cwd, `${r.sessionId}-${Date.now()}`);
						if (baseline) await gittrack.snapshotUntracked(baseline, r.dir);
						turn.baseline = baseline;
					} catch {
						turn.baseline = undefined;
					}
				}
				return;
			}
			if (event.toolName !== "write" && event.toolName !== "edit") return;
			const p = (event.input as { path?: unknown }).path;
			if (typeof p !== "string" || p.length === 0) return;
			const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
			let before: string | null = null;
			let tooBig = false;
			try {
				const stat = await fs.promises.stat(abs);
				if (stat.size > MAX_SNAPSHOT_BYTES) {
					tooBig = true;
				} else {
					before = (await fs.promises.readFile(abs)).toString("utf8");
				}
			} catch {
				before = null; // file does not exist yet
			}
			review?.setPending(event.toolCallId, { path: abs, before, tooBig });
		} catch {
			// never throw: a failing tool_call handler blocks the tool
		}
	});

	// End of turn: attribute bash-side changes against the turn baseline.
	pi.on("turn_end", async (_event, ctx) => {
		try {
			const r = review;
				const baseline = turn.baseline;
				if (r && baseline) {
					const changes = await gittrack.changedSince(ctx.cwd, baseline, r.dir);
					for (const ch of changes) {
					// A pending write/edit window for the same file is more precise.
					if (r.hasPending(ch.absPath)) continue;
					// Only files tracked in the baseline commit are restorable via git;
					// untracked files use their captured content instead.
					const gitRef = !ch.created && !ch.untracked ? baseline.sha : undefined;
					const st = r.noteChange(ch.absPath, ch.created, "bash", gitRef);
					// Untracked file modified/deleted: promote the baseline content
					// snapshot to the canonical restore source.
					if (!ch.created && ch.untracked) {
						const ut = path.join(r.dir, gittrack.utFileName(ch.absPath));
						if (fs.existsSync(ut)) {
							try {
								await fs.promises.copyFile(ut, r.snapPath(ch.absPath));
								st.hasSnapshot = true;
							} catch {
								/* restore unavailable for this file */
							}
						}
					}
					pi.appendEntry(ENTRY_CHANGE, { path: ch.absPath, created: ch.created, via: "bash", ref: gitRef });
				}
				updateStatus(ctx);
			}
		} catch {
			/* never break the turn */
		}
		turn = { baselined: false, baseline: undefined };
	});

	// Record the change once the tool succeeds.
	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "write" && event.toolName !== "edit") return;
			if (!review) return;
			if (event.isError) {
				review.dropPending(event.toolCallId);
				return;
			}
			const st = await review.commitToolResult(event.toolCallId);
			if (st) {
				pi.appendEntry(ENTRY_CHANGE, { path: st.path, created: st.created });
				updateStatus(ctx);
			}
		} catch {
			/* never throw */
		}
	});

	function rememberResolution(ctx: ExtensionCommandContext, abs: string, resolution: Resolution): void {
		try {
			pi.appendEntry(ENTRY_RESOLVE, { path: abs, resolution });
		} catch {
			/* best effort */
		}
		updateStatus(ctx);
	}

	// -----------------------------------------------------------------------
	// commands

	async function listSummary(ctx: ExtensionCommandContext): Promise<void> {
		const r = review;
		if (!r) return;
		const all = r.all();
		if (all.length === 0) {
			ctx.ui.notify("file-review: no tracked file changes in this session.", "info");
			return;
		}
		const lines: ViewerLine[] = [];
		for (const st of all) {
			const rel = r.rel(st.path);
			let exists = false;
			try {
				await fs.promises.access(st.path);
				exists = true;
			} catch {
				/* missing */
			}
			let marker: string;
			let label: string;
			if (st.status === "pending") {
				let stats = "";
				try {
					const d = await r.diffOf(st);
					if ("diff" in d) stats = `+${d.diff.added} −${d.diff.removed}`;
				} catch {
					/* ignore */
				}
				marker = st.created ? (exists ? "A " : "D ") : exists ? "M " : "D ";
				label = stats;
			} else if (st.status === "accepted") {
				marker = "✓ ";
				label = "accepted";
			} else {
				marker = "↩ ";
				label = "rejected";
			}
			const viaNote = st.via === "bash" ? " (bash)" : "";
			lines.push({
				text: `${marker}${rel}${viaNote}${label ? `  ${label}` : ""}  (${st.edits} edit${st.edits > 1 ? "s" : ""})`,
				color: st.status === "pending" ? "accent" : "dim",
			});
		}
		const pending = r.pending().length;
		if (ctx.mode === "tui") {
			await ctx.ui.custom<ViewerResult | undefined>(
				(tui, theme, _kb, done) =>
					new BoxViewer(tui, theme, "File changes", `${pending} pending · Esc close`, lines, "review: /changes", done),
				{ overlay: true, overlayOptions: { width: "85%" } },
			);
		} else {
			for (const l of lines) ctx.ui.notify(l.text, "info");
		}
	}

	async function runInteractive(ctx: ExtensionCommandContext): Promise<void> {
		const r = review;
		if (!r) return;
		if (!ctx.hasUI) {
			ctx.ui.notify("file-review: /changes needs an interactive UI (use /changes list).", "warning");
			return;
		}

		while (true) {
			const pending = r.pending();
			if (pending.length === 0) {
				ctx.ui.notify("No pending file changes — all reviewed.", "info");
				break;
			}

			interface Row {
				st: FileState;
				option: string;
			}
			const rows: Row[] = [];
			for (const st of pending) {
				let exists = false;
				try {
					await fs.promises.access(st.path);
					exists = true;
				} catch {
					/* missing */
				}
				let stats = "";
				try {
					const d = await r.diffOf(st);
					if ("diff" in d) {
						stats = `+${d.diff.added} −${d.diff.removed}${d.note ? " ⚠" : ""}`;
					} else {
						stats = "(no diff)";
					}
				} catch {
					stats = "";
				}
				const marker = st.created ? (exists ? "A " : "D ") : exists ? "M " : "D ";
				const rel = r.rel(st.path);
				const viaNote = st.via === "bash" ? " (bash)" : "";
				rows.push({ st, option: `${marker}${rel}${viaNote}  ${stats}`.trimEnd() });
			}

			const options = [
				...rows.map((x) => x.option),
				"✓ Accept all",
				"✗ Reject all",
				"Cancel",
			];
			const choice = await ctx.ui.select(`File changes — ${pending.length} pending`, options);
			if (choice === undefined || choice === "Cancel") break;

			if (choice === "✓ Accept all") {
				const n = r.acceptAll();
				for (const st of pending) rememberResolution(ctx, st.path, "accepted");
				ctx.ui.notify(`Accepted ${n} file change${n > 1 ? "s" : ""}.`, "info");
				continue;
			}

			if (choice === "✗ Reject all") {
				const ok = await ctx.ui.confirm(
					"Reject all",
					`Restore ${pending.length} file(s) to their state before the agent changed them? Created files will be deleted.`,
				);
				if (!ok) continue;
				let done = 0;
				let failed = 0;
				for (const st of pending) {
					const res = await r.reject(st.path);
					if (res.ok) {
						done++;
						rememberResolution(ctx, st.path, "rejected");
					} else {
						failed++;
						ctx.ui.notify(`reject failed for ${r.rel(st.path)}: ${res.error}`, "error");
					}
				}
				ctx.ui.notify(`Rejected ${done} file(s)${failed ? `, ${failed} failed` : ""}.`, failed ? "warning" : "info");
				continue;
			}

			const row = rows.find((x) => x.option === choice);
			if (!row) continue;
			const st = row.st;
			const rel = r.rel(st.path);

			// Show the diff, then act on the viewer result.
			let action: ViewerResult["action"] | undefined;
			const d = await r.diffOf(st).catch(() => undefined);
			if (d && "diff" in d) {
				const viaNote = st.via === "bash" ? " · via bash" : "";
				const title = `${st.created ? "A " : "M "}${rel}${viaNote}`;
				const subtitle = `+${d.diff.added} −${d.diff.removed}${d.note ? ` · ${d.note}` : ""} · ${st.edits} edit${st.edits > 1 ? "s" : ""}`;
				const lines: ViewerLine[] = d.diff.lines.map((l) =>
					l.kind === "hunk"
						? { text: l.text, color: "dim" }
						: l.kind === "add"
							? { text: `+${l.text}`, color: "toolDiffAdded" }
							: l.kind === "del"
								? { text: `-${l.text}`, color: "toolDiffRemoved" }
								: { text: ` ${l.text}`, color: "toolDiffContext" },
				);
				if (ctx.mode === "tui") {
					const res = await ctx.ui.custom<ViewerResult | undefined>(
						(tui, theme, _kb, done2) =>
							new BoxViewer(tui, theme, title, subtitle, lines, "a accept · r reject · esc/q back", done2),
						{ overlay: true, overlayOptions: { width: "90%" } },
					);
					action = res?.action;
				} else {
					// No custom components in RPC mode: confirm with stats only.
					const rej = await ctx.ui.confirm(
						`Reject ${rel}?`,
						`${subtitle}. No diff preview is available in this mode.`,
					);
					action = rej ? "reject" : "accept";
				}
			} else {
				const rej = await ctx.ui.confirm(`Reject ${rel}?`, d && "error" in d ? d.error : "Diff unavailable.");
				action = rej ? "reject" : "accept";
			}

			if (action === "reject") {
				const res = await r.reject(st.path);
				if (res.ok) {
					rememberResolution(ctx, st.path, "rejected");
					ctx.ui.notify(st.created ? `Rejected ${rel} (file deleted).` : `Rejected ${rel} (original restored).`, "info");
				} else {
					ctx.ui.notify(`Reject failed for ${rel}: ${res.error}`, "error");
				}
			} else if (action === "accept") {
				r.accept(st.path);
				rememberResolution(ctx, st.path, "accepted");
				ctx.ui.notify(`Accepted ${rel}.`, "info");
			}
		}
	}

	pi.registerCommand("changes", {
		description: "Review agent file changes: per-file accept/reject with diff preview",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!review) {
				ctx.ui.notify("file-review: not initialized (session not started).", "error");
				return;
			}
			const a = args.trim().toLowerCase();
			try {
				if (a === "") {
					await runInteractive(ctx);
				} else if (a === "list") {
					await listSummary(ctx);
				} else if (a === "accept-all" || a === "accept") {
					const wasPending = review.pending();
					const n = review.acceptAll();
					for (const st of wasPending) rememberResolution(ctx, st.path, "accepted");
					ctx.ui.notify(n ? `Accepted ${n} file change${n > 1 ? "s" : ""}.` : "Nothing pending.", n ? "info" : "warning");
				} else if (a === "reject-all" || a === "reject") {
					const pending = review.pending();
					if (pending.length === 0) {
						ctx.ui.notify("Nothing pending.", "warning");
						return;
					}
					if (ctx.hasUI) {
						const ok = await ctx.ui.confirm("Reject all", `Restore ${pending.length} file(s) to their pre-agent state?`);
						if (!ok) return;
					}
					let done = 0;
					for (const st of pending) {
						const res = await review.reject(st.path);
						if (res.ok) {
							done++;
							rememberResolution(ctx, st.path, "rejected");
						} else {
							ctx.ui.notify(`reject failed for ${review.rel(st.path)}: ${res.error}`, "error");
						}
					}
					ctx.ui.notify(`Rejected ${done}/${pending.length} file(s).`, done < pending.length ? "warning" : "info");
				} else {
					ctx.ui.notify("Usage: /changes [list | accept-all | reject-all]", "info");
				}
			} catch (e) {
				ctx.ui.notify(`file-review error: ${e instanceof Error ? e.message : e}`, "error");
			}
		},
	});
}
