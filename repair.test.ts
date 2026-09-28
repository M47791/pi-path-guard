// A-J validation suite for the turn_end model-facing path-spelling repair.
//
// These tests use REAL temporary filesystem fixtures so the filesystem-backed
// canonicalization authority (resolveExistingPath / resolveWritePath) is exercised
// end to end, exactly as it is during tool execution.
//
// All fixtures use generic names (AlphaModule, BetaModule) — no project-specific
// identifiers anywhere in this file.

import { test } from "bun:test";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
    buildContextEditDraft,
    buildCorrectionNotification,
    buildPathGuardStatus,
    CorrectionTelemetry,
    repairAssistantContent,
    repairPathSpansInText,
} from "./repair.ts";
import {
    canonicalizeQuotedShellPaths,
    resolveExistingPath,
    resolveWritePath,
} from "./canonicalize.ts";

function scaffold(): string {
    const base = mkdtempSync(join(tmpdir(), "pi-path-guard-"));
    // Create canonical files (no spaces in directory names) under AlphaModule
    mkdirSync(join(base, "src/AlphaModule/Tasks"), { recursive: true });
    writeFileSync(join(base, "src/AlphaModule/Tasks/Foo.cs"), "x");
    writeFileSync(join(base, "src/AlphaModule/Tasks/Bar.cs"), "y");
    writeFileSync(join(base, "src/Notes.txt"), "z");
    return base;
}

// --------------------------------------------------------------------- A
test("A — absolute path spelling is repaired", () => {
    const base = scaffold();
    try {
        // Broken absolute path: "Alpha Module" has a space → unique resolvable to AlphaModule
        const broken = join(base, "src/Alpha Module/Tasks/Foo.cs");
        const { text, repairs } = repairPathSpansInText(
            `editing ${broken}`,
            base
        );
        expect(repairs.length).toBe(1);
        expect(text).toContain(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        expect(text).not.toContain("Alpha Module");
        expect(repairs.length).toBe(1);
        expect(repairs[0].original).toBe(broken);
        expect(repairs[0].actual).toBe(join(base, "src/AlphaModule/Tasks/Foo.cs"));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- B
test("B — relative path spelling is repaired", () => {
    const base = scaffold();
    try {
        const { text, repairs } = repairPathSpansInText(
            `reading src/Alpha Module/Tasks/Foo.cs now`,
            base
        );
        expect(repairs.length).toBe(1);
        expect(text).toContain("src/AlphaModule/Tasks/Foo.cs");
        // a relative input stays relative (not rewritten to absolute)
        expect(text).not.toContain(base);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- C
test("C — prose without a resolvable path is never rewritten", () => {
    const base = scaffold();
    try {
        const prose =
            "I wonder whether Alpha Mo d is the correct project name for this week's plan.";
        const { text, repairs } = repairPathSpansInText(prose, base);
        expect(repairs.length).toBe(0);
        expect(text).toBe(prose);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- D
test("D — ambiguous spelling is left unchanged", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-path-guard-"));
    try {
        // A parent containing two real components whose collapsed keys collide.
        mkdirSync(join(base, "proj/A B"), { recursive: true });
        mkdirSync(join(base, "proj/A_B"), { recursive: true });

        // Collapsing the whitespace yields a key that matches both -> ambiguous.
        const ambiguous = resolveExistingPath(join(base, "proj/AB/c.txt"), base);
        expect(ambiguous.kind).toBe("unresolved");

        const { text, repairs } = repairPathSpansInText(
            `reading proj/A B/c.txt`,
            base
        );
        expect(repairs.length).toBe(0);
        expect(text).toContain("proj/A B/c.txt");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- E
test("E — nonexistent spelling is left unchanged", () => {
    const base = scaffold();
    try {
        const { text, repairs } = repairPathSpansInText(
            `reading src/Alpha Module/Tasks/Nope.cs`,
            base
        );
        expect(repairs.length).toBe(0);
        expect(text).toBe(`reading src/Alpha Module/Tasks/Nope.cs`);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- F
test("F — context_edit draft shape + raw input preserved (non-mutation)", () => {
    const base = scaffold();
    try {
        const content = [
            { type: "text", text: "reading src/Alpha Module/Tasks/Foo.cs" },
        ];
        const before = JSON.stringify(content);
        const { content: repaired, changed, repairs } = repairAssistantContent(content, base);
        expect(changed).toBe(true);
        expect(repairs.length).toBe(1);

        // Raw input array was never mutated.
        expect(JSON.stringify(content)).toBe(before);

        const draft = buildContextEditDraft("entry-123", repaired);
        expect(draft.type).toBe("context_edit");
        expect(draft.targetId).toBe("entry-123");
        expect(draft.replacement).toBeDefined();
        expect(draft.replacement?.content).toEqual(repaired);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- G
test("G — tool-call identity, structure and unrelated args preserved", () => {
    const base = scaffold();
    try {
        const content = [
            { type: "text", text: "start" },
            {
                type: "toolCall",
                id: "call_read",
                name: "read",
                arguments: {
                    path: join(base, "src/Alpha Module/Tasks/Foo.cs"),
                    encoding: "utf-8",
                    line: 12,
                },
                thoughtSignature: "sig_read",
            },
            {
                type: "toolCall",
                id: "call_bash",
                name: "bash",
                arguments: {
                    command: `ls "${join(base, "src/Alpha Module/Tasks")}"`,
                    shell: "bash",
                },
            },
            { type: "thinking", thinking: "keep this", thinkingSignature: "sig_t" },
        ];
        const { content: out, changed, repairs } = repairAssistantContent(content, base);
        expect(changed).toBe(true);

        const types = out.map((c: any) => c.type);
        expect(types).toEqual(["text", "toolCall", "toolCall", "thinking"]);

        const readCall = out.find((c: any) => c.name === "read");
        expect(readCall).toBeDefined();
        expect(readCall.id).toBe("call_read");
        expect(readCall.thoughtSignature).toBe("sig_read");
        expect(readCall.arguments.path).toBe(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        // unrelated arguments preserved
        expect(readCall.arguments.encoding).toBe("utf-8");
        expect(readCall.arguments.line).toBe(12);

        const bashCall = out.find((c: any) => c.name === "bash");
        expect(bashCall.arguments.command).toContain(
            join(base, "src/AlphaModule/Tasks")
        );

        const thinking = out.find((c: any) => c.type === "thinking");
        expect(thinking.thinking).toBe("keep this");
        expect(thinking.thinkingSignature).toBe("sig_t");

        expect(repairs.length).toBe(2);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- H
test("H — already-correct spelling produces no edit", () => {
    const base = scaffold();
    try {
        const content = [
            {
                type: "toolCall",
                id: "call_1",
                name: "read",
                arguments: { path: join(base, "src/AlphaModule/Tasks/Foo.cs") },
            },
        ];
        const { changed } = repairAssistantContent(content, base);
        expect(changed).toBe(false);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- I
test("I — execution-time canonicalization core unchanged after refactor", () => {
    const base = scaffold();
    try {
        // Structured read/write canonicalization (guard path) still corrects and
        // requires the right kind of resolution.
        const read = resolveExistingPath(join(base, "src/Alpha Module/Tasks/Foo.cs"), base);
        expect(read.kind).toBe("corrected");
        expect(read.path).toBe(join(base, "src/AlphaModule/Tasks/Foo.cs"));

        // A write to a nonexistent parent is not silently created/corrected.
        const write = resolveWritePath(join(base, "src/Nope/Nope.cs"), base);
        expect(write.kind).not.toBe("corrected");

        // Shell quoted-path canonicalization still corrects on disk.
        const shell = canonicalizeQuotedShellPaths(
            `cat "${join(base, "src/Alpha Module/Tasks/Foo.cs")}"`,
            base
        );
        expect(shell.command).toContain(join(base, "src/AlphaModule/Tasks/Foo.cs"));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- J
test("J — deterministic across repeated runs", () => {
    const base = scaffold();
    try {
        const input = [
            { type: "text", text: "edit src/Alpha Module/Tasks/Foo.cs" },
            {
                type: "toolCall",
                id: "call_1",
                name: "read",
                arguments: { path: join(base, "src/AlphaModule/Tasks/Foo.cs") },
            },
        ];
        const first = repairAssistantContent(JSON.parse(JSON.stringify(input)), base);
        const second = repairAssistantContent(JSON.parse(JSON.stringify(input)), base);
        expect(first.content).toEqual(second.content);
        expect(first.repairs).toEqual(second.repairs);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- K
test("K — correction notification carries the canonical path", () => {
    const base = scaffold();
    try {
        const canonical = join(base, "src/AlphaModule/Tasks/Foo.cs");
        const msg = buildCorrectionNotification("Path corrected", [canonical]);
        expect(msg).toContain(canonical);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- L
test("L — correction notification never carries the broken spelling", () => {
    const base = scaffold();
    try {
        const canonical = join(base, "src/AlphaModule/Tasks/Foo.cs");
        const msg = buildCorrectionNotification("Path corrected", [canonical]);
        expect(msg).not.toContain("Alpha Module");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- M
test("M — telemetry retains only canonical destinations", () => {
    const base = scaffold();
    try {
        const t = new CorrectionTelemetry();
        t.record(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        expect(t.counts.size).toBe(1);
        for (const key of t.counts.keys()) {
            expect(key).not.toContain("Alpha Module");
        }
        expect(t.report()[0].path).toBe(join(base, "src/AlphaModule/Tasks/Foo.cs"));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- N
test("N — correction count increments per successful repair", () => {
    const base = scaffold();
    try {
        const t = new CorrectionTelemetry();
        expect(t.total).toBe(0);
        t.record(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        t.record(join(base, "src/AlphaModule/Tasks/Bar.cs"));
        t.record(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        expect(t.total).toBe(3);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- O
test("O — repeated corrections aggregate to canonical destinations", () => {
    const base = scaffold();
    try {
        const t = new CorrectionTelemetry();
        const foo = join(base, "src/AlphaModule/Tasks/Foo.cs");
        t.record(foo);
        t.record(foo);
        t.record(foo);
        t.record(join(base, "src/AlphaModule/Tasks/Bar.cs"));
        const report = t.report();
        const fooEntry = report.find((r) => r.path === foo);
        expect(fooEntry?.count).toBe(3);
        expect(report.find((r) => r.path === join(base, "src/AlphaModule/Tasks/Bar.cs"))?.count).toBe(1);
        // never stores the broken spelling
        for (const key of t.counts.keys()) {
            expect(key).not.toContain("Alpha Module");
        }
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// --------------------------------------------------------------------- P
test("P — /path-guard reports enabled, authorized root, count, canonical destinations", () => {
    const base = scaffold();
    try {
        const t = new CorrectionTelemetry();
        t.record(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        const root = join(base, ".git-parent");
        const status = buildPathGuardStatus(root, t);
        expect(status).toContain("Pi Path Guard: ON");
        expect(status).toContain(`Root: ${root}`);
        expect(status).toContain("Corrections this session: 1");
        expect(status).toContain(join(base, "src/AlphaModule/Tasks/Foo.cs"));
        expect(status).not.toContain("Alpha Module");

        // No root established -> still reports the ON status.
        expect(buildPathGuardStatus(undefined, t)).toContain("Root: none");
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// ===== Test Q: end-to-end blocking via the real extension factory =====
// The extension peer dependency is installed outside this repository, so bun
// cannot import index.ts directly. This test drives the real factory through
// jiti (loader in pi-extension.e2e.mjs) to prove blocking + canonical-only
// notifications + telemetry + /path-guard against a genuine Git repository.
test("Q — end-to-end blocking (extension factory + jiti): blocks out-of-root writes, canonicalizes in-root reads, reports via /path-guard (canonical-only)", () => {
    const loaderPath = join(__dirname, "pi-extension.e2e.mjs");
    const out = execFileSync("bun", [loaderPath], {
        cwd: __dirname,
        encoding: "utf8",
        env: {
            ...process.env,
            PI_PKG:
                "C:/Users/M4779/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent",
        },
        windowsHide: true,
    });
    expect(out).toContain("E2E PASS");
    expect(out).not.toContain("FAIL");
});
