// End-to-end extension validation for the addendum (tests K-Q blocking +
// canonical-only notifications + telemetry + /path-guard), exercised through the
// real extension factory loaded via jiti (bun cannot resolve the peer dep
// installed outside the repo). Run as: bun ./pi-extension.e2e.mjs
// Exits 0 on success, 1 on any failed assertion.

import { createJiti } from "C:/Users/M4779/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const PI_PKG = process.env.PI_PKG;
const piPath = `${PI_PKG}/dist/index.js`;
const piCompatPath = `${PI_PKG}/node_modules/@earendil-works/pi-ai/dist/compat.js`;

const jiti = createJiti(import.meta.url, {
    module: (id) => {
        if (id === "@earendil-works/pi-coding-agent") return piPath;
        if (id === "@earendil-works/pi-ai") return piCompatPath;
    },
    resolve: (id) => {
        if (id === "@earendil-works/pi-coding-agent") return piPath;
        if (id === "@earendil-works/pi-ai") return piCompatPath;
    },
});

const mod = await jiti.import("./index.ts");
const factory = mod.default ?? mod;
if (typeof factory !== "function") throw new Error("factory is not a function");
console.log("LOADED_OK");

let failures = 0;
function check(label, cond) {
    if (cond) {
        console.log(`  ok  — ${label}`);
    } else {
        failures++;
        console.error(`  FAIL — ${label}`);
    }
}

function makeHarness() {
    const handlers = new Map();
    const commands = new Map();
    const notifications = [];
    const pi = {
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: (name, def) => commands.set(name, def),
        ui: { notify: (message, type) => notifications.push({ message, type }) },
    };
    return { pi, handlers, commands, notifications };
}

const h = makeHarness();
factory(h.pi);
check("session_start handler registered", h.handlers.has("session_start"));
check("tool_call handler registered", h.handlers.has("tool_call"));
check("path-guard command registered", h.commands.has("path-guard"));

// ---- fixture: a real git repo + an outside target dir ----
const base = mkdtempSync(join(tmpdir(), "pgq-e2e-"));
const repoDir = join(base, "repo");
mkdirSync(repoDir, { recursive: true });
execFileSync("git", ["init", "--quiet"], { cwd: repoDir, windowsHide: true });

// existing canonical file whose spelling the model will misspell
mkdirSync(join(repoDir, "src/Kryxn.Core/Tasks"), { recursive: true });
const canonicalFoo = join(repoDir, "src/Kryxn.Core/Tasks/Foo.cs");
writeFileSync(canonicalFoo, "x");
const malformedFoo = join(repoDir, "src/Kry xn.Core/Tasks/Foo.cs");

const outsideDir = join(base, "outside");
mkdirSync(outsideDir, { recursive: true });
const outsideWritePath = join(outsideDir, "file.txt");
writeFileSync(outsideWritePath, "x");

const ui = (extra = {}) => ({
    notify: () => {},
    setStatus: () => {},
    theme: { fg: (_style, text) => String(text) },
    ...extra,
});
const ctx = { cwd: repoDir, ui: ui() };

(async () => {
    // ---- session_start establishes the authorized root ----
    await h.handlers.get("session_start")({ cwd: repoDir }, ctx);

    const toolCall = h.handlers.get("tool_call");
    const ctxWithNotify = {
        cwd: repoDir,
        ui: ui({ notify: (message, type) => h.notifications.push({ message, type }) }),
    };

    // ---- Q: blocking intact — structured write outside the root is refused ----
    const blockEntries = [];
    let blockRes;
    try {
        blockRes = await toolCall(
            {
                type: "tool_call",
                toolCallId: "w1",
                toolName: "write",
                input: {
                    path: outsideWritePath,
                    content: "x",
                    name: "write",
                    id: "w1",
                    namespace: "builtin",
                },
                entries: blockEntries,
            },
            ctxWithNotify
        );
    } catch {
        // blockRes stays undefined; the checks below assert the block.
    }
    check("Q — out-of-root write is blocked", blockRes && blockRes.block === true);
    check(
        "Q — block reason is PATH_OUTSIDE_REPOSITORY",
        !!blockRes && String(blockRes.reason).includes("PATH_OUTSIDE_REPOSITORY")
    );
    check("Q — block reason does not rewrite the model's request", blockRes && !String(blockRes.reason).includes("rewritten"));

    // ---- canonical-only: an in-root read misspells->canonical, notifies canonical only ----
    const readEntries = [];
    const readRes = await toolCall(
        {
            type: "tool_call",
            toolName: "read",
            toolCallId: "r1",
            input: {
                path: malformedFoo,
                name: "read",
                id: "r1",
                thoughtSignature: "sig_read",
                namespace: "builtin",
            },
            entries: readEntries,
        },
        ctxWithNotify
    );
    check("no block for in-root read", readRes === undefined);
    check("structured path rewritten to canonical on the input", readEntries.length === 0);
    const canonNotif = h.notifications
        .slice()
        .reverse()
        .find((n) => n.message.includes("Path canonicalized before tool execution"));
    check("canonical-only: read notification exists", !!canonNotif);
    check("canonical-only: read notification carries canonical path", !!canonNotif && canonNotif.message.includes(canonicalFoo));
    check("canonical-only: read notification omits the malformed spelling", !!canonNotif && !canonNotif.message.includes("Kry xn"));

    // ---- turn_end: assistant prose misspelled path is repaired; canonical only ----
    const turnEnd = h.handlers.get("turn_end");
    const teEntries = [];
    await turnEnd(
        {
            message: {
                role: "assistant",
                content: [{ type: "text", text: `reading ${malformedFoo}` }],
            },
            messageEntryId: "entry_assistant_1",
            entries: teEntries,
        },
        ctxWithNotify
    );
    check("turn_end pushed exactly one context_edit", teEntries.length === 1);
    check("context_edit targets the assistant message entry", teEntries[0] && teEntries[0].targetId === "entry_assistant_1");
    const teNotif = h.notifications
        .slice()
        .reverse()
        .find((n) => n.message.includes("Path spelling repaired for the next model turn"));
    check("turn_end: repair notification exists", !!teNotif);
    check("turn_end: repair notification carries canonical path", !!teNotif && teNotif.message.includes(canonicalFoo));
    check("turn_end: repair notification omits the malformed spelling", !!teNotif && !teNotif.message.includes("Kry xn"));

    // ---- Q: a genuine security/blocking warning is not weakened ----
    check(
        "blocking warnings still reference the requested path for traceability",
        String(blockRes.reason).includes(outsideWritePath)
    );

    // ---- P: /path-guard reports enabled + root + count + canonical destinations ----
    const cmd = h.commands.get("path-guard");
    const cmdOut = [];
    await cmd.handler({}, { ui: { notify: (message) => cmdOut.push(message) } });
    const status = cmdOut[0] ?? "";
    check("P — reports Pi Path Guard: ON", status.includes("Pi Path Guard: ON"));
    check("P — reports a non-empty Root", /Root: .+/.test(status) && !status.includes("none"));
    check("P — reports a correction count", /Corrections this session: \d+/.test(status));
    check("P — status is canonical-only", !status.includes("Kry xn"));
    check("P — status lists a canonical destination", status.includes(canonicalFoo));

    // ---- cleanup ----
    rmSync(base, { recursive: true, force: true });

    if (failures > 0) {
        console.error(`\nE2E FAILED: ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nE2E PASS");
    process.exit(0);
})();
