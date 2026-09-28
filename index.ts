import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
    canonicalizeNestedPowerShellCommand,
    canonicalizeQuotedShellPaths,
    canonicalizeSetContentWriteTarget,
    canonicalizeUnquotedShellPaths,
    resolveExistingPath,
    resolveWritePath,
} from "./canonicalize.ts";
import {
    buildContextEditDraft,
    buildCorrectionNotification,
    buildPathGuardStatus,
    CorrectionTelemetry,
    repairAssistantContent,
} from "./repair.ts";

function isShellTool(event: ToolCallEvent): boolean {
    return (
        isToolCallEventType("bash", event) ||
        isToolCallEventType("powershell", event)
    );
}
function getStructuredPath(event: ToolCallEvent): string | undefined {
    if (
        isToolCallEventType("read", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event) ||
        isToolCallEventType("grep", event) ||
        isToolCallEventType("find", event) ||
        isToolCallEventType("ls", event)
    ) {
        const input = event.input as Record<string, unknown>;
        return typeof input.path === "string" ? input.path : undefined;
    }

    return undefined;
}

function setStructuredPath(event: ToolCallEvent, path: string): void {
    const input = event.input as Record<string, unknown>;
    input.path = path;
}

/**
 * Resolve the authoritative Git repository root for the current Pi working
 * directory without invoking a shell.
 *
 * V3A is discovery-only. Later versions may use this root as a mutation
 * boundary, but this version does not block or rewrite any tool call based
 * on repository containment.
 */
function discoverRepositoryRoot(cwd: string): string | undefined {
    try {
        const output = execFileSync(
            "git",
            ["rev-parse", "--show-toplevel"],
            {
                cwd,
                encoding: "utf8",
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            }
        ).trim();

        if (output.length === 0) {
            return undefined;
        }

        return normalize(resolve(output));
    } catch {
        return undefined;
    }
}
/**
 * Determine whether a path is contained by the established repository root.
 *
 * Both paths are normalized to absolute paths first. Using relative() avoids
 * unsafe string-prefix checks such as treating "repo-other" as inside "repo".
 */
function isContainedPath(
    parentPath: string,
    candidatePath: string
): boolean {
    const relativePath = relative(parentPath, candidatePath);

    return (
        relativePath === "" ||
        (
            relativePath !== ".." &&
            !relativePath.startsWith(`..\\`) &&
            !relativePath.startsWith("../") &&
            !isAbsolute(relativePath)
        )
    );
}

function deepestExistingAncestor(path: string): string | undefined {
    let current = normalize(path);

    while (!existsSync(current)) {
        const parent = parse(current).dir;

        if (parent === current || parent.length === 0) {
            return undefined;
        }

        current = parent;
    }

    return current;
}

function isPathInsideRepository(
    requestedPath: string,
    cwd: string,
    repositoryRoot: string
): boolean {
    const absolutePath = isAbsolute(requestedPath)
        ? normalize(requestedPath)
        : resolve(cwd, requestedPath);

    /*
     * Lexical containment remains the first barrier.
     */
    if (!isContainedPath(repositoryRoot, absolutePath)) {
        return false;
    }

    /*
     * The final mutation target may not exist yet. Resolve the deepest
     * existing ancestor so symlinks and Windows junctions are evaluated
     * according to their physical filesystem destination.
     */
    const existingAncestor = deepestExistingAncestor(absolutePath);

    if (existingAncestor === undefined) {
        return false;
    }

    try {
        const physicalRepositoryRoot = realpathSync(repositoryRoot);
        const physicalAncestor = realpathSync(existingAncestor);

        return isContainedPath(
            physicalRepositoryRoot,
            physicalAncestor
        );
    } catch {
        /*
         * Mutation containment fails closed if physical resolution cannot
         * be established reliably.
         */
        return false;
    }
}
export default function (pi: ExtensionAPI) {
    // Canonical-only, bounded session telemetry for successful corrections.
    // Retains the exact total correction count plus an aggregated per-
    // destination counter keyed by the authoritative canonical path. The
    // malformed/original spelling is NEVER stored here.
    const telemetry = new CorrectionTelemetry();
    let repositoryRoot: string | undefined;

    pi.on("session_start", async (_event, ctx) => {
        repositoryRoot = discoverRepositoryRoot(ctx.cwd);

        const rootStatus =
            repositoryRoot === undefined
                ? "NO GIT ROOT"
                : `root: ${repositoryRoot}`;

        ctx.ui.setStatus(
            "path-canonicalizer",
            ctx.ui.theme.fg(
                "accent",
                `Pi Path Guard v0.1.0: ON | ${rootStatus}`
            )
        );

        if (repositoryRoot === undefined) {
            ctx.ui.notify(
                "Path canonicalizer could not establish a Git repository root. " +
                    "V3A remains discovery-only.",
                "warning"
            );
        }
    });

    pi.on("tool_call", async (event, ctx) => {
        if (isShellTool(event)) {
            const input = event.input as Record<string, unknown>;
            const command =
                typeof input.command === "string" ? input.command : undefined;

            if (command === undefined) {
                return;
            }

            const quotedResult = canonicalizeQuotedShellPaths(command, ctx.cwd);

            let finalCommand = quotedResult.command;
            const shellCorrections = [...quotedResult.corrections];
            let shellWriteTarget: string | undefined;

            if (isToolCallEventType("powershell", event)) {
                const unquotedResult = canonicalizeUnquotedShellPaths(
                    finalCommand,
                    ctx.cwd
                );

                finalCommand = unquotedResult.command;
                shellCorrections.push(...unquotedResult.corrections);

                const writeResult = canonicalizeSetContentWriteTarget(
                    finalCommand,
                    ctx.cwd
                );

                finalCommand = writeResult.command;
                shellCorrections.push(...writeResult.corrections);
                shellWriteTarget = writeResult.writeTarget;
            } else if (isToolCallEventType("bash", event)) {
                const nestedPowerShellResult = canonicalizeNestedPowerShellCommand(
                    finalCommand,
                    ctx.cwd
                );

                finalCommand = nestedPowerShellResult.command;
                shellCorrections.push(...nestedPowerShellResult.corrections);
                shellWriteTarget = nestedPowerShellResult.writeTarget;
            }

            if (shellWriteTarget !== undefined) {
                if (repositoryRoot === undefined) {
                    return {
                        block: true,
                        reason: [
                            "REPOSITORY_ROOT_UNAVAILABLE",
                            `Shell write target: ${shellWriteTarget}`,
                            "Recognized shell mutation refused because the authorized Git repository root was not established.",
                        ].join("\n"),
                    };
                }

                if (
                    !isPathInsideRepository(
                        shellWriteTarget,
                        ctx.cwd,
                        repositoryRoot
                    )
                ) {
                    return {
                        block: true,
                        reason: [
                            "PATH_OUTSIDE_REPOSITORY",
                            `Shell write target: ${shellWriteTarget}`,
                            `Repository root: ${repositoryRoot}`,
                            "Recognized shell mutation outside the authorized repository is refused.",
                        ].join("\n"),
                    };
                }
            }

            if (shellCorrections.length === 0) {
                return;
            }

            input.command = finalCommand;
            for (const correction of shellCorrections) {
                telemetry.record(correction.actual);
            }

            ctx.ui.notify(
                buildCorrectionNotification(
                    "Shell path canonicalized before command execution:",
                    shellCorrections.map((correction) => correction.actual)
                ),
                "warning"
            );

            return;
        }

        const requestedPath = getStructuredPath(event);

        if (requestedPath === undefined) {
            return;
        }

        const result = isToolCallEventType("write", event)
            ? resolveWritePath(requestedPath, ctx.cwd)
            : resolveExistingPath(requestedPath, ctx.cwd);

        if (result.kind === "unresolved") {
            return {
                block: true,
                reason: [
                    "PATH_CANONICALIZATION_FAILED",
                    `Requested path: ${requestedPath}`,
                    result.reason,
                    "Rediscover the real filesystem path before retrying.",
                ].join("\n"),
            };
        }

        const effectivePath =
            result.kind === "corrected"
                ? result.path
                : requestedPath;

        const isStructuredMutation =
            isToolCallEventType("write", event) ||
            isToolCallEventType("edit", event);

        if (isStructuredMutation) {
            if (repositoryRoot === undefined) {
                return {
                    block: true,
                    reason: [
                        "REPOSITORY_ROOT_UNAVAILABLE",
                        `Requested path: ${requestedPath}`,
                        "Structured mutation refused because the authorized Git repository root was not established.",
                    ].join("\n"),
                };
            }

            if (
                !isPathInsideRepository(
                    effectivePath,
                    ctx.cwd,
                    repositoryRoot
                )
            ) {
                return {
                    block: true,
                    reason: [
                        "PATH_OUTSIDE_REPOSITORY",
                        `Requested path: ${requestedPath}`,
                        `Effective path: ${effectivePath}`,
                        `Repository root: ${repositoryRoot}`,
                        "Structured mutation outside the authorized repository is refused.",
                    ].join("\n"),
                };
            }
        }

        if (result.kind === "corrected") {
            setStructuredPath(event, result.path);
            telemetry.record(result.path);

            ctx.ui.notify(
                buildCorrectionNotification(
                    "Path canonicalized before tool execution:",
                    [result.path]
                ),
                "warning"
            );
        }

        return;
    });

    // Model-facing repair of malformed paths emitted by the assistant.
    //
    // At turn_end, the raw assistant message still carries the LLM's original
    // (possibly misspelled) tool-call arguments and path-like prose. Those strings
    // are what will be projected back into the model's context on the next turn.
    // We canonicalize only unambiguously resolvable path spans (using the same
    // filesystem-backed authority as the execution guard) and, when something
    // actually changed, emit a `context_edit` that rewrites ONLY the model-facing
    // projection of this message. The raw session history is never modified.
    pi.on("turn_end", async (event, ctx) => {
        if (event.message.role !== "assistant") return;

        const { content, changed, repairs } = repairAssistantContent(
            event.message.content,
            ctx.cwd
        );

        if (!changed) return;

        event.entries.push(
            buildContextEditDraft(event.messageEntryId, content)
        );

        for (const repair of repairs) {
            telemetry.record(repair.actual);
        }

        ctx.ui.notify(
            buildCorrectionNotification(
                `Path spelling repaired for the next model turn (${repairs.length}):`,
                repairs.map((repair) => repair.actual)
            ),
            "warning"
        );

        return;
    });

    pi.registerCommand("path-guard", {
        description: "Show path canonicalizer status",
        handler: async (_args, ctx) => {
            ctx.ui.notify(
                buildPathGuardStatus(repositoryRoot, telemetry),
                "info"
            );
        },
    });
}














