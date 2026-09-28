import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize, parse, relative, resolve } from "node:path";

export type Canonicalization =
    | { kind: "corrected"; path: string; original: string }
    | { kind: "unchanged"; path: string }
    | { kind: "unresolved"; path: string; reason: string };
export function comparisonKey(value: string): string {
    return value.replace(/\s+/g, "").toLowerCase();
}

export function toOutputPath(
    requestedPath: string,
    absolutePath: string,
    cwd: string
): string {
    return isAbsolute(requestedPath)
        ? absolutePath
        : relative(cwd, absolutePath) || ".";
}

export function findCanonicalComponent(
    parent: string,
    requestedComponent: string
):
    | { kind: "match"; name: string }
    | { kind: "none" }
    | { kind: "ambiguous"; candidates: string[] } {

    let entries: string[];

    try {
        entries = readdirSync(parent);
    } catch {
        return { kind: "none" };
    }

    // Existing exact spelling always wins.
    const exact = entries.find(
        (entry) => entry.toLowerCase() === requestedComponent.toLowerCase()
    );

    if (exact !== undefined) {
        return { kind: "match", name: exact };
    }

    const requestedKey = comparisonKey(requestedComponent);
    const candidates = entries.filter(
        (entry) => comparisonKey(entry) === requestedKey
    );

    if (candidates.length === 1) {
        return { kind: "match", name: candidates[0] };
    }

    if (candidates.length > 1) {
        return { kind: "ambiguous", candidates };
    }

    return { kind: "none" };
}

export function resolveExistingPath(
    requestedPath: string,
    cwd: string
): Canonicalization {
    if (!requestedPath || requestedPath.trim().length === 0) {
        return {
            kind: "unresolved",
            path: requestedPath,
            reason: "Path is empty.",
        };
    }

    const absoluteRequested = isAbsolute(requestedPath)
        ? normalize(requestedPath)
        : resolve(cwd, requestedPath);

    // A real existing path is authoritative.
    if (existsSync(absoluteRequested)) {
        return { kind: "unchanged", path: requestedPath };
    }

    const root = parse(absoluteRequested).root;
    const components = absoluteRequested
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean);

    let current = root;

    for (const requestedComponent of components) {
        if (!existsSync(current)) {
            return {
                kind: "unresolved",
                path: requestedPath,
                reason: `Parent path does not exist: ${current}`,
            };
        }

        const match = findCanonicalComponent(current, requestedComponent);

        if (match.kind === "none") {
            return {
                kind: "unresolved",
                path: requestedPath,
                reason: `No canonical filesystem match for component "${requestedComponent}".`,
            };
        }

        if (match.kind === "ambiguous") {
            return {
                kind: "unresolved",
                path: requestedPath,
                reason:
                    `Ambiguous canonical filesystem match for component ` +
                    `"${requestedComponent}": ${match.candidates.join(", ")}`,
            };
        }

        current = join(current, match.name);
    }

    if (!existsSync(current)) {
        return {
            kind: "unresolved",
            path: requestedPath,
            reason: "Canonical candidate does not exist.",
        };
    }

    const correctedPath = toOutputPath(requestedPath, current, cwd);

    if (normalize(correctedPath) === normalize(requestedPath)) {
        return { kind: "unchanged", path: requestedPath };
    }

    return {
        kind: "corrected",
        original: requestedPath,
        path: correctedPath,
    };
}

/**
 * Canonicalize the EXISTING portion of a write target.
 *
 * Once the first genuinely nonexistent component is encountered, the
 * remaining suffix is preserved exactly as requested. This permits normal
 * creation of new files/directories without guessing their names.
 */
export function resolveWritePath(
    requestedPath: string,
    cwd: string
): Canonicalization {
    if (!requestedPath || requestedPath.trim().length === 0) {
        return {
            kind: "unresolved",
            path: requestedPath,
            reason: "Path is empty.",
        };
    }

    const absoluteRequested = isAbsolute(requestedPath)
        ? normalize(requestedPath)
        : resolve(cwd, requestedPath);

    if (existsSync(absoluteRequested)) {
        return resolveExistingPath(requestedPath, cwd);
    }

    const root = parse(absoluteRequested).root;
    const components = absoluteRequested
        .slice(root.length)
        .split(/[\\/]+/)
        .filter(Boolean);

    let current = root;
    let corrected = false;

    for (let index = 0; index < components.length; index++) {
        const requestedComponent = components[index];

        if (!existsSync(current)) {
            return {
                kind: "unresolved",
                path: requestedPath,
                reason: `Existing parent chain unexpectedly disappeared at ${current}.`,
            };
        }

        const match = findCanonicalComponent(current, requestedComponent);

        if (match.kind === "ambiguous") {
            return {
                kind: "unresolved",
                path: requestedPath,
                reason:
                    `Ambiguous canonical filesystem match for component ` +
                    `"${requestedComponent}": ${match.candidates.join(", ")}`,
            };
        }

        if (match.kind === "match") {
            if (match.name !== requestedComponent) {
                corrected = true;
            }

            current = join(current, match.name);
            continue;
        }

        /*
         * First genuinely new component.
         *
         * Everything from here onward is a requested creation suffix and is
         * preserved verbatim. We do NOT fuzzy-match new names.
         */
        for (let suffix = index; suffix < components.length; suffix++) {
            current = join(current, components[suffix]);
        }

        const outputPath = toOutputPath(requestedPath, current, cwd);

        if (!corrected) {
            return { kind: "unchanged", path: requestedPath };
        }

        return {
            kind: "corrected",
            original: requestedPath,
            path: outputPath,
        };
    }

    const outputPath = toOutputPath(requestedPath, current, cwd);

    if (!corrected) {
        return { kind: "unchanged", path: requestedPath };
    }

    return {
        kind: "corrected",
        original: requestedPath,
        path: outputPath,
    };
}

/**
 * Conservatively canonicalize filesystem paths inside quoted shell literals.
 *
 * V2B intentionally handles only single-quoted and double-quoted strings.
 * A quoted value is changed only when:
 *   1. it looks path-like;
 *   2. the requested path does not exist as written; and
 *   3. filesystem-backed whitespace canonicalization proves a unique target.
 *
 * Arbitrary prose and ordinary shell arguments are left untouched.
 */
export function canonicalizeQuotedShellPaths(
    command: string,
    cwd: string
): { command: string; corrections: Array<{ original: string; actual: string }> } {
    const corrections: Array<{ original: string; actual: string }> = [];

    const rewritten = command.replace(
        /(['"])([^'"\r\n]+)\1/g,
        (fullMatch, quote: string, value: string) => {
            // Require something path-like. This prevents ordinary quoted prose
            // such as commit messages from being treated as filesystem paths.
            const looksPathLike =
                value.includes("/") ||
                value.includes("\\") ||
                /^[A-Za-z]:[\\/]/.test(value);

            if (!looksPathLike) {
                return fullMatch;
            }

            const result = resolveExistingPath(value, cwd);

            if (result.kind !== "corrected") {
                return fullMatch;
            }

            corrections.push({
                original: value,
                actual: result.path,
            });

            return `${quote}${result.path}${quote}`;
        }
    );

    return { command: rewritten, corrections };
}

/**
 * Recover whitespace-corrupted unquoted filesystem paths conservatively.
 *
 * Example:
 *   src/Kry xn.Core/Tasks/File.cs
 *
 * may become:
 *   src\Example.Core\Tasks\File.cs
 *
 * only when removing whitespace at a token boundary produces a uniquely
 * filesystem-backed existing path.
 *
 * V2C does not perform general whitespace removal and does not guess.
 */
export function canonicalizeUnquotedShellPaths(
    command: string,
    cwd: string
): { command: string; corrections: Array<{ original: string; actual: string }> } {
    const corrections: Array<{ original: string; actual: string }> = [];

    // Protect quoted regions. Quoted paths are handled separately.
    const quotedRanges: Array<{ start: number; end: number }> = [];
    const quoteRegex = /(['"])([^'"\r\n]*)\1/g;

    let quoteMatch: RegExpExecArray | null;
    while ((quoteMatch = quoteRegex.exec(command)) !== null) {
        quotedRanges.push({
            start: quoteMatch.index,
            end: quoteMatch.index + quoteMatch[0].length,
        });
    }

    const isInsideQuotedRange = (index: number): boolean =>
        quotedRanges.some(
            (range) => index >= range.start && index < range.end
        );

    /*
     * Examine EVERY whitespace boundary independently.
     *
     * For:
     *
     *   Get-Content src/Kry xn.Core/Tasks/File.cs
     *
     * this tests both:
     *
     *   Get-Content | src/Kry
     *   src/Kry     | xn.Core/Tasks/File.cs
     *
     * rather than consuming token pairs and accidentally skipping the
     * second boundary.
     */
    const whitespaceRegex = /[ \t]+/g;

    const candidates: Array<{
        start: number;
        end: number;
        original: string;
        actual: string;
    }> = [];

    let whitespaceMatch: RegExpExecArray | null;

    while ((whitespaceMatch = whitespaceRegex.exec(command)) !== null) {
        const whitespaceStart = whitespaceMatch.index;
        const whitespaceEnd =
            whitespaceStart + whitespaceMatch[0].length;

        if (
            isInsideQuotedRange(whitespaceStart) ||
            isInsideQuotedRange(whitespaceEnd - 1)
        ) {
            continue;
        }

        // Walk left to the beginning of the immediately adjacent token.
        let leftStart = whitespaceStart;

        while (
            leftStart > 0 &&
            !/[\s"'`;|&<>]/.test(command[leftStart - 1])
        ) {
            leftStart--;
        }

        // Walk right to the end of the immediately adjacent token.
        let rightEnd = whitespaceEnd;

        while (
            rightEnd < command.length &&
            !/[\s"'`;|&<>]/.test(command[rightEnd])
        ) {
            rightEnd++;
        }

        const left = command.slice(leftStart, whitespaceStart);
        const right = command.slice(whitespaceEnd, rightEnd);

        if (left.length === 0 || right.length === 0) {
            continue;
        }

        // At least one side must already look path-like.
        if (
            !left.includes("/") &&
            !left.includes("\\") &&
            !right.includes("/") &&
            !right.includes("\\")
        ) {
            continue;
        }

        const joined = left + right;

        if (!joined.includes("/") && !joined.includes("\\")) {
            continue;
        }

        /*
         * Filesystem proof is mandatory.
         *
         * We don't decide that whitespace is wrong merely because removing
         * it creates path-looking text. The joined candidate must resolve
         * through the filesystem-backed canonicalizer.
         */
        const result = resolveExistingPath(joined, cwd);

        if (result.kind !== "corrected" && result.kind !== "unchanged") {
            continue;
        }

        const original = command.slice(leftStart, rightEnd);

        /*
         * If the whitespace-containing form itself genuinely exists,
         * preserve it. It may be an intentional path containing spaces.
         */
        const originalResolved = resolve(cwd, original);

        if (existsSync(originalResolved)) {
            continue;
        }

        candidates.push({
            start: leftStart,
            end: rightEnd,
            original,
            actual: result.path,
        });
    }

    if (candidates.length === 0) {
        return { command, corrections };
    }

    /*
     * Apply right-to-left so string offsets remain stable.
     * Overlapping candidates are ignored rather than guessed.
     */
    candidates.sort((a, b) => b.start - a.start);

    let rewritten = command;
    let lastStart = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        if (candidate.end > lastStart) {
            continue;
        }

        rewritten =
            rewritten.slice(0, candidate.start) +
            candidate.actual +
            rewritten.slice(candidate.end);

        corrections.push({
            original: candidate.original,
            actual: candidate.actual,
        });

        lastStart = candidate.start;
    }

    corrections.reverse();

    return { command: rewritten, corrections };
}
/**
 * Canonicalize an unquoted path inside an explicit PowerShell -Command payload
 * when PowerShell itself is being invoked through Pi's bash tool.
 *
 * This deliberately recognizes only:
 *
 *   powershell ... -Command "PAYLOAD"
 *   pwsh       ... -Command "PAYLOAD"
 *
 * It does not recursively interpret arbitrary quoted shell strings.
 */
/**
 * Canonicalize the positional target of a PowerShell Set-Content command.
 *
 * This is deliberately narrow:
 *   - only Set-Content;
 *   - only the first positional path argument;
 *   - only when whitespace corruption split that path;
 *   - only when resolveWritePath() proves a correction in the existing
 *     filesystem portion of the target.
 *
 * The new filename/suffix is preserved verbatim by resolveWritePath().
 */
export function canonicalizeSetContentWriteTarget(
    command: string,
    cwd: string
): {
    command: string;
    corrections: Array<{ original: string; actual: string }>;
    writeTarget?: string;
} {
    const corrections: Array<{ original: string; actual: string }> = [];

    /*
     * Keep this intentionally strict. We only handle:
     *
     *   Set-Content <unquoted-target> <value...>
     *
     * The target must already contain a path separator before the whitespace
     * corruption point.
     */
    const commandMatch = /^(\s*Set-Content\s+)([\s\S]+)$/i.exec(command);

    if (commandMatch === null) {
        return { command, corrections };
    }

    const prefix = commandMatch[1];
    const remainder = commandMatch[2];

    /*
     * First recognize the ordinary unquoted first positional target.
     *
     * This is mutation recognition, not corruption recovery. If the target
     * already resolves as a write path, expose it for repository containment
     * even when no canonicalization is required.
     *
     * Example:
     *
     *   Set-Content C:\Temp\file.txt 'VALUE'
     *
     * The first token is the actual PowerShell target. We do not join later
     * whitespace here. Corruption recovery remains the responsibility of the
     * proven V2H logic below.
     */
    let ordinaryWriteTarget: string | undefined;

    const ordinaryTargetMatch = /^([^\s"'`;|&<>]+)/.exec(remainder);

    if (ordinaryTargetMatch !== null) {
        const ordinaryTarget = ordinaryTargetMatch[1];
        const ordinaryResult = resolveWritePath(ordinaryTarget, cwd);

        if (ordinaryResult.kind !== "unresolved") {
            ordinaryWriteTarget = ordinaryResult.path;
        }
    }

    /*
     * Examine whitespace boundaries in the remainder. At each boundary,
     * consider the text from the beginning of the first positional argument
     * through the token immediately to the right of that boundary.
     *
     * Example:
     *
     *   src/Kry xn.Application/Generated/NewFile.txt 'VALUE'
     *
     * Candidate at the corruption boundary:
     *
     *   src/Example.Application/Generated/NewFile.txt
     *
     * resolveWritePath() then proves/canonicalizes the existing parent while
     * preserving the genuinely new suffix.
     */
    const boundaryRegex = /[ \t]+/g;
    let boundary: RegExpExecArray | null;

    while ((boundary = boundaryRegex.exec(remainder)) !== null) {
        const whitespaceStart = boundary.index;
        const whitespaceEnd = whitespaceStart + boundary[0].length;

        const left = remainder.slice(0, whitespaceStart);

        // Once we reach a quoted value, we are beyond the positional target.
        if (left.includes("'") || left.includes('"')) {
            break;
        }

        let rightEnd = whitespaceEnd;

        while (
            rightEnd < remainder.length &&
            !/[\s"'`;|&<>]/.test(remainder[rightEnd])
        ) {
            rightEnd++;
        }

        const right = remainder.slice(whitespaceEnd, rightEnd);

        if (left.length === 0 || right.length === 0) {
            continue;
        }

        if (!left.includes("/") && !left.includes("\\")) {
            continue;
        }

        const candidate = left + right;

        if (!candidate.includes("/") && !candidate.includes("\\")) {
            continue;
        }

        const result = resolveWritePath(candidate, cwd);

        /*
         * Two forms of proof are accepted:
         *
         * 1. resolveWritePath() itself corrected an existing component; or
         *
         * 2. joining this exact whitespace boundary reconstructs an existing
         *    filesystem component, while resolveWritePath() reports the full
         *    new target unchanged because only the final creation suffix is new.
         *
         * Case 2 is what proves:
         *
         *   src/Kry + xn.Application/Generated/NewFile.txt
         *
         * without allowing arbitrary filename words such as:
         *
         *   src/Foo + Bar.txt
         */
        let provenPath = result.kind === "corrected";

        if (!provenPath && result.kind === "unchanged") {
            const leftSeparator = Math.max(
                left.lastIndexOf("/"),
                left.lastIndexOf("\\")
            );

            if (leftSeparator >= 0) {
                const parentPrefix = left.slice(0, leftSeparator + 1);
                const leftComponentPart = left.slice(leftSeparator + 1);

                const rightSeparatorCandidates = [
                    right.indexOf("/"),
                    right.indexOf("\\"),
                ].filter((value) => value >= 0);

                if (
                    leftComponentPart.length > 0 &&
                    rightSeparatorCandidates.length > 0
                ) {
                    const rightSeparator = Math.min(
                        ...rightSeparatorCandidates
                    );

                    const rightComponentPart = right.slice(
                        0,
                        rightSeparator
                    );

                    if (rightComponentPart.length > 0) {
                        const reconstructedExistingComponent =
                            parentPrefix +
                            leftComponentPart +
                            rightComponentPart;

                        const componentProof = resolveExistingPath(
                            reconstructedExistingComponent,
                            cwd
                        );

                        provenPath =
                            componentProof.kind === "unchanged" ||
                            componentProof.kind === "corrected";
                    }
                }
            }
        }

        if (!provenPath || result.kind === "unresolved") {
            continue;
        }

        const original = remainder.slice(0, rightEnd);

        const rewritten =
            prefix +
            result.path +
            remainder.slice(rightEnd);

        corrections.push({
            original,
            actual: result.path,
        });

        return {
            command: rewritten,
            corrections,
            writeTarget: result.path,
        };
    }

    return {
        command,
        corrections,
        writeTarget: ordinaryWriteTarget,
    };
}
export function canonicalizeNestedPowerShellCommand(
    command: string,
    cwd: string
): {
    command: string;
    corrections: Array<{ original: string; actual: string }>;
    writeTarget?: string;
} {
    const invocationRegex =
        /^(\s*(?:powershell|powershell\.exe|pwsh|pwsh\.exe)\b[\s\S]*?\s-(?:Command|c)\s+")([\s\S]*)("\s*)$/i;

    const match = invocationRegex.exec(command);

    if (match === null) {
        return { command, corrections: [] };
    }

    const prefix = match[1];
    const payload = match[2];
    const suffix = match[3];

    const existingResult = canonicalizeUnquotedShellPaths(payload, cwd);

    const writeResult = canonicalizeSetContentWriteTarget(
        existingResult.command,
        cwd
    );

    const corrections = [
        ...existingResult.corrections,
        ...writeResult.corrections,
    ];

    if (corrections.length === 0) {
        return {
            command,
            corrections: [],
            writeTarget: writeResult.writeTarget,
        };
    }

    return {
        command: prefix + writeResult.command + suffix,
        corrections,
        writeTarget: writeResult.writeTarget,
    };
}
