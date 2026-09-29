// Authoritative package/version source for Pi Path Guard.
//
// The extension footer and any other user-visible version label derive from the
// version declared in package.json. There is ONE source of truth: reading
// package.json at load time. A future package-version bump therefore never
// requires editing a separate hard-coded UI string, and the footer can never
// drift from the published version again.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read the version declared in this package's package.json.
 *
 * Returns an empty string if the manifest cannot be read or has no version, so
 * callers can fall back to a safe placeholder without throwing.
 */
export function getPackageVersion(): string {
    try {
        const manifestPath = fileURLToPath(new URL("./package.json", import.meta.url));
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            version?: string;
        };
        return typeof manifest.version === "string" ? manifest.version : "";
    } catch {
        return "";
    }
}

/**
 * Build the user-facing version prefix shown in the footer/status line.
 *
 * The version token is ALWAYS derived from getPackageVersion(), never
 * hard-coded, so the displayed version tracks the package version exactly.
 */
export function formatVersionPrefix(version: string): string {
    return `Pi Path Guard v${version}: ON`;
}
