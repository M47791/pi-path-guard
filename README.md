# Pi Path Guard

A safety extension for the Pi coding agent that helps protect filesystem operations from malformed model-generated paths.

Local and cloud language models can occasionally corrupt paths while generating tool calls or shell commands—for example, turning:

    src/Example.Core/Tasks/File.cs

into:

    src/Example .Core/Tasks/File.cs

A malformed path can be more than an inconvenience. During a write operation it can create unintended directories or modify files outside the repository the agent was supposed to work in.

Pi Path Guard adds a filesystem-backed correction and containment layer before supported tool operations execute.

## What it does

Pi Path Guard:

- Discovers the active Git repository root dynamically.
- Leaves exact valid filesystem paths unchanged.
- Attempts to canonicalize malformed path components against real filesystem entries.
- Uses conservative whitespace-insensitive recovery when there is a unique filesystem-backed match.
- Refuses ambiguous or unresolved structured paths rather than guessing.
- Allows genuinely new filenames beneath verified existing parent paths.
- Prevents recognized mutations from escaping the active Git repository.
- Resolves existing ancestors physically so symlinks and Windows junctions cannot trivially bypass repository containment.
- Supports Pi structured path tools and conservative handling of recognized shell path patterns.

When a path is corrected, Pi Path Guard reports the model-generated path and the filesystem path actually used.

## Example

A model attempts to read:

    src/Example .Core/Tasks/File.cs

If the filesystem uniquely contains:

    src/Example.Core/Tasks/File.cs

Pi Path Guard can canonicalize the path before execution.

For mutations, the effective destination must also remain inside the discovered Git repository.

## Installation

Pi supports packages installed directly from Git repositories.

After this repository is published, install a tagged release with:

    pi install git:github.com/<OWNER>/pi-path-guard@v0.1.0

You can also test a local checkout without installing it:

    pi --no-extensions -e ./index.ts

Or install the local package:

    pi install ./pi-path-guard

Restart Pi after installation.

A successful load displays a status similar to:

    Pi Path Guard v0.1.0: ON | root: /path/to/repository

## Requirements

- Pi coding agent with extension support.
- Git available on PATH.
- The working directory must be inside a Git repository for mutation containment to become active.

The initial release was developed and tested with Pi 0.87.1 on Windows. The implementation uses Node.js filesystem/path APIs, but other platforms have not yet received the same level of runtime testing.

## Safety model

For structured path operations, Pi Path Guard resolves paths against the filesystem before execution.

For mutations, it additionally verifies that the effective path remains within the discovered repository root.

Containment includes physical resolution of the deepest existing ancestor. This is intended to prevent an apparently in-repository path from escaping through a symbolic link or Windows junction whose physical destination lies outside the repository.

If repository containment cannot be established reliably for a recognized mutation, the guard fails closed.

## Important limitations

Pi Path Guard is **not a general-purpose shell sandbox**.

Shell commands are arbitrary text and can express filesystem mutations in many ways. The extension only applies shell mutation containment where it recognizes a supported command/path form with sufficient confidence.

In v0.1.0, shell write recognition is intentionally conservative. In particular, PowerShell `Set-Content` paths are handled, including supported PowerShell invocations nested through Pi's bash tool. Other mutating commands and arbitrary scripts should not be assumed to be contained.

The extension does not replace:

- operating-system sandboxing,
- containers or virtual machines,
- filesystem permissions,
- source control,
- backups,
- human review of destructive commands.

Treat it as an additional safety layer for model-generated filesystem paths.

## Design principle

The extension does not globally replace strings such as `"Example .Core"` with `"Example.Core"`.

Instead, correction is based on the actual filesystem. A malformed component must resolve conservatively to a real entry. This avoids embedding project-specific spelling corrections and reduces the risk of silently rewriting unrelated text.

## Current status

v0.1.0 is the first public release.

The core behavior has been tested for:

- exact structured paths,
- malformed structured reads,
- malformed structured writes,
- new files beneath canonicalized parents,
- malformed structured edits,
- quoted shell paths,
- unquoted paths in supported PowerShell commands,
- supported `Set-Content` writes,
- repository escape attempts,
- Windows junction escape attempts,
- legitimate in-repository writes.

Windows received the primary test coverage for v0.1.0.

## Security

Pi extensions execute with the permissions of the Pi process. Review third-party extension source before installing it.

If you discover a case where Pi Path Guard incorrectly permits a recognized mutation outside the repository boundary, please report it with a minimal reproduction.

## License

MIT
