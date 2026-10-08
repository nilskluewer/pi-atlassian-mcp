# Publishing

Publishing runs in GitHub Actions (`.github/workflows/publish.yml`) when a `v*` tag is pushed.
Auth is npm trusted publishing (OIDC). There is no token and no OTP.
Do NOT run `npm publish` locally.

Steps:

1. Make sure all changes are merged to `main` and you are on `main` with a clean tree:
   ```bash
   git switch main && git pull && git status -s
   ```
2. Run the tests:
   ```bash
   npm ci && npm test
   ```
3. Bump the version. This edits `package.json` and the lockfile, commits, and creates the tag `vX.Y.Z`:
   ```bash
   npm version patch   # or minor / major
   ```
4. Push the commit and the tag. The tag starts the workflow:
   ```bash
   git push --follow-tags
   ```
5. Check the run. It tests, publishes to npm with provenance, and creates the GitHub release:
   ```bash
   gh run watch
   npm view @nilskluewer/pi-atlassian-mcp version
   ```

Notes:
- The tag must match `package.json` version. The workflow fails if not.
- Add a new user-facing feature to the README. Credit outside contributors by `@name` in the README or release notes.
- If the workflow fails with 404/403 on publish, check the Trusted Publisher on npmjs.com: owner `nilskluewer`, repo `pi-atlassian-mcp`, workflow `publish.yml`.
