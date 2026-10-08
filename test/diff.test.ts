/**
 * Unit tests for the diff engine.
 * Run: node --experimental-transform-types test/diff.test.ts
 */
import { computeOps, toLines, unifiedDiff } from "../extensions/diff.ts";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
	if (cond) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.error(`FAIL  ${name} ${extra}`);
	}
}

// --- toLines
check("toLines(null) = []", toLines(null).length === 0);
check(
	"toLines strips single trailing newline",
	JSON.stringify(toLines("a\nb\n")) === JSON.stringify(["a", "b"]),
);
check(
	"toLines keeps content without trailing newline",
	JSON.stringify(toLines("a\nb")) === JSON.stringify(["a", "b"]),
);
check(
	"toLines(\\n) = ['']",
	JSON.stringify(toLines("\n")) === JSON.stringify([""]),
);

// --- computeOps basics
function ops(a: string, b: string): string[] {
	return computeOps(toLines(a), toLines(b)).map((o) => (o.op === "=" ? " 1" : o.op + "1"));
}

check(
	"identical files -> only context ops",
	ops("a\nb\n", "a\nb\n").every((o) => o === " 1"),
	JSON.stringify(ops("a\nb\n", "a\nb\n")),
);
check(
	"single line change",
	JSON.stringify(ops("a\nb\nc", "a\nx\nc")) === JSON.stringify([" 1", "-1", "+1", " 1"]),
	JSON.stringify(ops("a\nb\nc", "a\nx\nc")),
);
check(
	"created file -> all adds",
	JSON.stringify(ops("", "a\nb")) === JSON.stringify(["+1", "+1"]),
);
check(
	"deleted file -> all dels",
	JSON.stringify(ops("a\nb", "")) === JSON.stringify(["-1", "-1"]),
);
check(
	"common prefix/suffix stripped, middle exact",
	JSON.stringify(ops("1\n2\n3\n4\n5", "1\n2\nX\nY\n4\n5")) ===
		JSON.stringify([" 1", " 1", "-1", "+1", "+1", " 1", " 1"]),
	JSON.stringify(ops("1\n2\n3\n4\n5", "1\n2\nX\nY\n4\n5")),
);
check(
	"reorder detected (one anchor kept, 2 adds + 2 dels)",
	JSON.stringify(ops("a\nb\nc", "c\nb\na").sort()) === JSON.stringify([" 1", "+1", "+1", "-1", "-1"]),
	JSON.stringify(ops("a\nb\nc", "c\nb\na")),
);

// large middle falls back to one block (still exact counts)
const bigA = Array.from({ length: 700 }, (_, i) => `a${i}`).join("\n");
const bigB = Array.from({ length: 700 }, (_, i) => `b${i}`).join("\n");
const bigOps = computeOps(toLines(bigA), toLines(bigB));
const bigAdds = bigOps.filter((o) => o.op === "+").length;
const bigDels = bigOps.filter((o) => o.op === "-").length;
check("large middle: counts exact", bigAdds === 700 && bigDels === 700);

// --- unifiedDiff hunks
const d1 = unifiedDiff("a\nb\nc\nd\ne\nf", "a\nX\nc\nd\ne\nf");
check(
	"hunk header line numbers (3 context lines after change)",
	d1.lines[0].kind === "hunk" && d1.lines[0].text === "@@ -1,5 +1,5 @@",
	d1.lines[0].text,
);
check("hunk counts", d1.added === 1 && d1.removed === 1);
check(
	"plain includes +/- prefixes",
	d1.plain.includes("+X") && d1.plain.includes("-b"),
);

// two distant changes -> two hunks
const d2 = unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12", "1\n2\n3\nX\n5\n6\n7\n8\n9\n10\n11\nY");
const hunks = d2.lines.filter((l) => l.kind === "hunk");
check("two distant hunks", hunks.length === 2, JSON.stringify(hunks.map((h) => h.text)));
check(
	"hunk 2 header",
	hunks[1].text === "@@ -9,4 +9,4 @@",
	hunks[1].text,
);

// no changes
const d3 = unifiedDiff("same", "same");
check("no-change marker", d3.lines.length === 1 && d3.lines[0].text === "(no changes)");

// created file diff
const d4 = unifiedDiff(null, "hello\nworld");
check("created: all adds", d4.added === 2 && d4.removed === 0);

// deleted file diff
const d5 = unifiedDiff("hello\nworld", null);
check("deleted: all dels", d5.added === 0 && d5.removed === 2);

// trailing newline differences should not produce spurious changes
const d6 = unifiedDiff("a\nb", "a\nb\n");
check("trailing newline ignored", d6.added === 0 && d6.removed === 0);

console.log(failures === 0 ? "\nAll diff tests passed." : `\n${failures} diff test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
