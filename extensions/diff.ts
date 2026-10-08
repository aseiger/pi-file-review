/**
 * Pure line-based unified diff utility (no pi imports, unit-testable).
 *
 * Strategy:
 *  - strip common prefix/suffix lines
 *  - if the remaining middle is small enough, run a real LCS to get
 *    precise per-line add/remove ops
 *  - otherwise emit the middle as one replaced block (still exact counts)
 *  - group ops into hunks with N lines of context
 */

export type DiffOp = { op: "=" | "+" | "-"; line: string };

export type DiffLine =
	| { kind: "hunk"; text: string }
	| { kind: "ctx" | "add" | "del"; text: string };

export interface DiffData {
	lines: DiffLine[];
	plain: string;
	added: number;
	removed: number;
}

const CONTEXT = 3;
/** Cap on middle lines (aMid + bMid) for exact LCS; larger falls back to one block. */
const LCS_MAX = 1200;
/** Hard cap on rendered diff lines so the viewer stays usable. */
const MAX_LINES = 8000;

export function toLines(s: string | null): string[] {
	if (s === null || s === "") return [];
	const t = s.endsWith("\n") ? s.slice(0, -1) : s;
	return t.split("\n");
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
	const n = a.length;
	const m = b.length;
	const W = m + 1;
	const dp = new Int32Array((n + 1) * W);
	for (let i = n - 1; i >= 0; i--) {
		const row = i * W;
		const next = (i + 1) * W;
		for (let j = m - 1; j >= 0; j--) {
			dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
		}
	}
	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ op: "=", line: a[i] });
			i++;
			j++;
		} else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
			ops.push({ op: "-", line: a[i] });
			i++;
		} else {
			ops.push({ op: "+", line: b[j] });
			j++;
		}
	}
	while (i < n) ops.push({ op: "-", line: a[i++] });
	while (j < m) ops.push({ op: "+", line: b[j++] });
	return ops;
}

export function computeOps(a: string[], b: string[]): DiffOp[] {
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

	const aMid = a.slice(p, a.length - s);
	const bMid = b.slice(p, b.length - s);

	const ops: DiffOp[] = [];
	for (let i = 0; i < p; i++) ops.push({ op: "=", line: a[i] });
	if (aMid.length + bMid.length <= LCS_MAX) {
		ops.push(...lcsDiff(aMid, bMid));
	} else {
		for (const l of aMid) ops.push({ op: "-", line: l });
		for (const l of bMid) ops.push({ op: "+", line: l });
	}
	for (let i = 0; i < s; i++) ops.push({ op: "=", line: a[a.length - s + i] });
	return ops;
}

function buildHunks(ops: DiffOp[]): { lines: DiffLine[]; added: number; removed: number } {
	let added = 0;
	let removed = 0;
	const changed: number[] = [];
	for (let k = 0; k < ops.length; k++) {
		if (ops[k].op === "+") added++;
		else if (ops[k].op === "-") removed++;
		if (ops[k].op !== "=") changed.push(k);
	}

	const lines: DiffLine[] = [];
	if (changed.length === 0) {
		lines.push({ kind: "hunk", text: "(no changes)" });
		return { lines, added, removed };
	}

	const ranges: Array<[number, number]> = [];
	for (const k of changed) {
		const lo = Math.max(0, k - CONTEXT);
		const hi = Math.min(ops.length - 1, k + CONTEXT);
		const last = ranges[ranges.length - 1];
		if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
		else ranges.push([lo, hi]);
	}

	for (const [lo, hi] of ranges) {
		let oldStart = 1;
		let newStart = 1;
		for (let k = 0; k < lo; k++) {
			if (ops[k].op === "=") {
				oldStart++;
				newStart++;
			} else if (ops[k].op === "-") oldStart++;
			else newStart++;
		}
		let oldCount = 0;
		let newCount = 0;
		const body: DiffLine[] = [];
		for (let k = lo; k <= hi; k++) {
			const o = ops[k];
			if (o.op === "=") {
				oldCount++;
				newCount++;
				body.push({ kind: "ctx", text: o.line });
			} else if (o.op === "-") {
				oldCount++;
				body.push({ kind: "del", text: o.line });
			} else {
				newCount++;
				body.push({ kind: "add", text: o.line });
			}
		}
		lines.push({ kind: "hunk", text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
		lines.push(...body);
	}
	return { lines, added, removed };
}

/**
 * Unified diff of before/after content.
 * `before === null` means the file did not exist (pure creation);
 * `after === null` means the file no longer exists (pure deletion).
 */
export function unifiedDiff(before: string | null, after: string | null): DiffData {
	const ops = computeOps(toLines(before), toLines(after));
	const { lines, added, removed } = buildHunks(ops);

	const out: DiffLine[] = lines;
	let plain = `+${added} / -${removed}`;
	if (out.length > MAX_LINES) {
		const head = out.slice(0, MAX_LINES);
		out.push({ kind: "hunk", text: `... ${out.length - MAX_LINES} more lines ...` });
		plain += ` (truncated)`;
	}
	const plainBody = out
		.map((l) =>
			l.kind === "hunk"
				? l.text
				: `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`,
		)
		.join("\n");
	return { lines: out, plain: `${plain}\n${plainBody}`, added, removed };
}
