# Core versioning

`release.json` records the current lifecycle, existing version and Git baseline. Each first-parent source commit advances its numeric prerelease identifier or patch once. A non-numeric prerelease gets a numeric identifier. Major/minor changes and promotion to Stable remain deliberate API decisions. Schema, protocol and token-standard versions remain independent.

`node .pfx/release.mjs --sync` writes the actual package/Cargo versions, local lockfile entries, public `version.json` and `version-badge.svg`. CI runs it before building. Existing release gates stay in place. GitHub release archives use this version where automated distribution already exists; a source version is not a claim of a published registry package.

After successful checks, one existing CI job commits only generated version files on current main. It never force-pushes, never overwrites a newer source update, and uses `[skip ci]` to avoid recursive builds. Its exact bot message is excluded from version counting. Pull requests never write to main.

Pinned consumers keep their pinned core revision and version until explicitly updated. Do not report the latest upstream release as the version embedded in a consumer.
