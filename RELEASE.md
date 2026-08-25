# Canvas Browser Extension Release Guide

Two separate things, on two different cadences:

1. **The GitHub release** — automatic, every version, built in CI.
2. **The store submissions** — manual, occasional, done by a human when a
   version is worth shipping to users.

Don't confuse them. Tagging a version does *not* put it in front of users.

## 1. GitHub release

From the stack root:

```bash
./canvas-release.sh --apps extension --bump patch
```

From the monorepo root:

```bash
npm run release:extension -- --bump patch     # or minor / major
```

That bumps the version in **all three** files (`package.json`,
`manifest-chromium.json`, `manifest-firefox.json`), commits, pushes `main`,
and pushes the tag `extension-v<version>`. CI takes it from there.

`canvas-release.sh` without `--apps` does the same for every app whose code
moved. CI never tags on its own.

The `extension` job in `.github/workflows/release.yml` then:

1. **Asserts** the tag matches `package.json` *and* both manifests. All three
   must agree or the job fails — this is why you bump with the script rather
   than editing `package.json` by hand.
2. **Builds** on a clean runner with a frozen lockfile.
3. **Validates** both zips with `unzip -t` and writes `SHA256SUMS`.
4. **Attaches** `canvas-extension-chromium.zip` and
   `canvas-extension-firefox.zip` to the GitHub Release for the tag.

Until recently this was built on a maintainer's laptop and uploaded with
`gh release create`. It builds in CI now, so the artifact users install is
reproducible from a known commit.

Watch it: `gh run list --workflow=release.yml --limit 1`

## 2. Store submissions (manual)

The extension is live on both stores:

| Browser | Listing | Dashboard |
| --- | --- | --- |
| Chrome / Chromium | [Chrome Web Store](https://chromewebstore.google.com/detail/nddefgjgkhcpmgpipifjacmoinoncdgl) | [Developer Dashboard](https://chrome.google.com/webstore/devconsole) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/canvas-browser-extension) | [Developer Hub](https://addons.mozilla.org/developers/) |
| Edge | not listed | [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) |

**Upload the zips from the GitHub release** — not a local build. They are the
exact validated artifacts, and using them keeps what's in the store traceable
to a tag and a commit.

- Chrome Web Store → `canvas-extension-chromium.zip`. Review is typically 1–3
  business days.
- Firefox AMO → `canvas-extension-firefox.zip`. Review is typically 1–7 days.
  AMO requires a **source code upload** alongside the package, because the
  build is bundled and minified by esbuild; point the reviewer at `build.mjs`.
- Edge accepts the Chromium zip unchanged, if the listing is ever created.

Not every tagged version needs to go to the stores, and historically most
haven't. Store review queues are slow and can't be cancelled once submitted,
so batching several versions into one submission is a legitimate choice.

## Automating the submissions

This is the obvious next step whenever the release cadence makes it worth it.
The shape:

- Chrome Web Store — `chrome-webstore-upload-cli`, needs `CLIENT_ID`,
  `CLIENT_SECRET`, `REFRESH_TOKEN`, `EXTENSION_ID`.
- Firefox AMO — `web-ext sign`, needs a JWT issuer and secret.
- Edge — Partner Center API, needs a product ID and client credentials.

Put them in a **GitHub Environment with a required reviewer**, not plain
secrets on the job. A submission is irreversible and enters a human review
queue; a stray version bump must not be able to fire three of them
unattended. The approval gate is what preserves today's "not every version
ships" behaviour while removing the manual upload.

## Versions

The version lives in three files that must always agree: `package.json`,
`manifest-chromium.json`, `manifest-firefox.json`. `npm run release:extension
-- --bump <level>` keeps them in sync; CI enforces it.

Note the stores have their own rules — Chrome will reject an upload whose
manifest version isn't strictly greater than the published one, so a version
you skipped is simply skipped, never reused.

## Rollback

- **GitHub**: mark the release as a pre-release to bury it, or delete the tag
  if nothing consumed it:
  `git tag -d extension-v3.0.1 && git push origin :refs/tags/extension-v3.0.1`
- **Stores**: you cannot pull a version once approved. Roll forward — bump,
  release, submit again. In an emergency, unpublish the listing from the
  dashboard; this removes it for new users but leaves existing installs on the
  bad version until they update.

Since store submission is manual, a bad tag caught before submission costs
nothing. That's a real advantage of the current gap between the two steps.
