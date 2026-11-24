import { test } from "bun:test";
import assert from "node:assert/strict";
import {
    mkdtempSync,
    rmSync,
    rmdirSync,
    symlinkSync,
    unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
    basename,
    dirname,
    join
} from "node:path";
import { isPathInsideAuthorizedRoots } from "./index.ts";

const repo = process.cwd();
const temp = tmpdir();
const allowed = (path) =>
    isPathInsideAuthorizedRoots(path, repo, repo);

test("allows repository mutations", () => {
    assert.equal(
        allowed(join(repo, "new-file.tmp")),
        true
    );
});

test("allows ordinary temporary files", () => {
    assert.equal(
        allowed(join(temp, "path-guard-test.tmp")),
        true
    );
});

test("allows nested temporary destinations", () => {
    assert.equal(
        allowed(join(temp, "nested", "more", "file.json")),
        true
    );
});

test("rejects unrelated directories", () => {
    const outside = join(
        dirname(repo),
        basename(repo) + "-unrelated",
        "file.txt"
    );

    assert.equal(allowed(outside), false);
});

test("rejects temp-like sibling directories", () => {
    const sibling = join(
        dirname(temp),
        basename(temp) + "-other",
        "file.txt"
    );

    assert.equal(allowed(sibling), false);
});

test("rejects traversal outside temp", () => {
    const escaped = join(
        temp,
        "..",
        "path-guard-outside",
        "file.txt"
    );

    assert.equal(allowed(escaped), false);
});

test("rejects temp junction escapes", () => {
    const scratch = mkdtempSync(
        join(temp, "path-guard-regression-")
    );
    const link = join(scratch, "escape");
    let linkCreated = false;

    try {
        // The target is an existing directory outside TEMP.
        // No data is written through the junction.
        symlinkSync(dirname(temp), link, "junction");
        linkCreated = true;

        assert.equal(
            allowed(join(link, "outside.txt")),
            false
        );
    } finally {
        if (linkCreated) {
            // Remove ONLY the junction, never its target.
            try {
                unlinkSync(link);
            } catch (error) {
                if (process.platform !== "win32") {
                    throw error;
                }
                rmdirSync(link);
            }
        }

        // Safe only after the junction has been removed.
        rmSync(scratch, {
            recursive: true,
            force: true
        });
    }
});