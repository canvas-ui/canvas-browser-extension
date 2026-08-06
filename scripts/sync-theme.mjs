#!/usr/bin/env node
/**
 * Vendor the canvas-web design-token layer into this repo.
 *
 * The token layer lives in the canvas-web repo (src/ui/web/src/theme/), which
 * is a *different* git submodule of canvas-server. This one cannot @import
 * across that boundary and still be cloneable on its own for store packaging,
 * so the tokens are vendored: this script generates src/theme/theme.css and
 * that file is committed.
 *
 *   npm run sync:theme            regenerate src/theme/theme.css
 *   npm run sync:theme -- --check exit non-zero if it is out of date
 *
 * `npm run build` never calls this. A fresh clone of just this repo builds
 * from the committed output with canvas-web nowhere in sight.
 *
 * ── Why a generator and not a copy ──────────────────────────────────────────
 *
 * Roughly half the token layer is declared inside Tailwind v4 `@theme` blocks,
 * which Tailwind hoists into `:root` at build time. This extension has no
 * Tailwind, and a browser *silently drops* an unknown at-rule — so a plain copy
 * would lose --shadow-elevation-*, --duration-*, --ease-*, --radius-* and the
 * entire layout scale, with no error anywhere. Every var() referencing them
 * would resolve to nothing and the rule would be dropped. This script unwraps
 * those blocks into real `:root` blocks and strips the constructs that only
 * mean something to Tailwind.
 *
 * ── When the pnpm monorepo lands ────────────────────────────────────────────
 *
 * Delete this script and src/theme/theme.css. The theme layer becomes a
 * workspace package that both the web app and this extension depend on, and
 * src/popup/popup.css @imports it from node_modules instead.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = path.join(repoRoot, 'src', 'theme', 'theme.css')

/**
 * Where the source layer lives.
 *
 * The relative path is where canvas-web sits when this repo is checked out as
 * a submodule of canvas-server — the only place both halves exist at once.
 * Anywhere else, point CANVAS_THEME_SRC at a checkout.
 */
const SOURCE_CANDIDATES = [
  process.env.CANVAS_THEME_SRC,
  path.join(repoRoot, '..', '..', 'src', 'ui', 'web', 'src', 'theme', 'css'),
].filter(Boolean)

function resolveSource() {
  for (const candidate of SOURCE_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, 'index.css'))) return path.resolve(candidate)
  }
  console.error('Could not find the canvas-web theme layer. Looked in:')
  for (const candidate of SOURCE_CANDIDATES) console.error(`  ${path.resolve(candidate)}`)
  console.error('\nEither run this from inside a canvas-server checkout with the')
  console.error('src/ui/web submodule initialised, or set CANVAS_THEME_SRC to a')
  console.error('canvas-web checkout, e.g.')
  console.error('  CANVAS_THEME_SRC=/path/to/canvas-web/src/theme/css npm run sync:theme')
  process.exit(1)
}

/**
 * The import list from the source's own index.css, in order.
 *
 * Read rather than hardcoded for two reasons: the order is load-bearing (every
 * selector in the layer has specificity (0,1,0), so source order alone decides
 * which theme/density value wins), and a new theme file added upstream should
 * arrive here without anyone remembering to update this script.
 */
function readImportOrder(sourceDir) {
  const index = fs.readFileSync(path.join(sourceDir, 'index.css'), 'utf8')
  const imports = [...index.matchAll(/@import\s+['"]\.\/([^'"]+)['"]\s*;/g)].map((m) => m[1])
  if (!imports.length) throw new Error(`No @import statements found in ${sourceDir}/index.css`)
  return imports
}

/**
 * Rewrite one source file into plain CSS.
 *
 * Three transforms, all of them about Tailwind constructs that a browser does
 * not understand:
 *
 *   @theme { … } / @theme inline { … }  ->  :root { … }
 *       Tailwind hoists these into :root itself. `inline` only controls whether
 *       the emitted utilities reference var() or a copied value, which is
 *       meaningless without utilities — the declarations are identical.
 *
 *   @utility name { … }                 ->  dropped
 *       Generates a utility class. This extension writes real selectors, so
 *       there is nothing to generate into.
 *
 *   @custom-variant …;                  ->  dropped
 *       Declares a Tailwind variant. Same reason.
 *
 * Brace matching is comment-aware; the layer has no braces inside strings.
 */
function transform(css) {
  let out = ''
  let i = 0

  while (i < css.length) {
    // Copy comments through verbatim — they carry the reasoning, which is most
    // of the value of reading a token file at all.
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? css.length : end + 2
      out += css.slice(i, stop)
      i = stop
      continue
    }

    if (css.startsWith('@custom-variant', i)) {
      const end = css.indexOf(';', i)
      i = end === -1 ? css.length : end + 1
      continue
    }

    const theme = /^@theme(\s+inline)?\s*\{/.exec(css.slice(i))
    if (theme) {
      const body = readBlock(css, i + theme[0].length - 1)
      out += `:root {${body.inner}}`
      i = body.end
      continue
    }

    const utility = /^@utility\s+[\w-]+\s*\{/.exec(css.slice(i))
    if (utility) {
      i = readBlock(css, i + utility[0].length - 1).end
      continue
    }

    out += css[i]
    i += 1
  }

  return out
}

/** Read a `{ … }` block starting at `open`. Returns its inner text and the index past `}`. */
function readBlock(css, open) {
  let depth = 0
  let i = open

  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return { inner: css.slice(open + 1, i), end: i + 1 }
    }
    i += 1
  }

  throw new Error('Unbalanced braces in source CSS')
}

/** Short commit of the source checkout, or null outside a git worktree. */
function sourceCommit(sourceDir) {
  try {
    return execFileSync('git', ['-C', sourceDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function generate(sourceDir) {
  const files = readImportOrder(sourceDir)
  const raw = files.map((file) => ({ file, css: fs.readFileSync(path.join(sourceDir, file), 'utf8') }))

  /*
   * The hash covers the *inputs*, not the output, and it is what --check
   * compares. Keying off the commit instead would report drift every time
   * canvas-web moved for an unrelated reason, which trains you to ignore it.
   */
  const hash = createHash('sha256')
  for (const { file, css } of raw) hash.update(`${file}\0${css}\0`)
  const sourceHash = hash.digest('hex').slice(0, 16)

  const commit = sourceCommit(sourceDir)
  const body = raw
    .map(({ file, css }) => `/* ═══ ${file} ${'═'.repeat(Math.max(0, 68 - file.length))} */\n\n${transform(css).trim()}`)
    .join('\n\n')

  const header = `/**
 * GENERATED FILE — do not edit.
 *
 * The Canvas design-token layer, vendored from canvas-web. Regenerate with:
 *   npm run sync:theme
 *
 * source      canvas-web src/theme/css
 * synced-from ${commit ?? 'unknown (source is not a git checkout)'}
 * source-hash ${sourceHash}
 * files       ${files.length}
 *
 * Tailwind's @theme / @utility / @custom-variant constructs have been unwrapped
 * or stripped by scripts/sync-theme.mjs — see that file for why a plain copy
 * would silently lose half the tokens. Import order is preserved from the
 * source's index.css and is load-bearing: every selector here has specificity
 * (0,1,0), so order alone decides whether a theme or a density value wins.
 *
 * When the pnpm monorepo migration lands, this file and its generator go away
 * in favour of a workspace package shared with the web app.
 */

`

  return { text: header + body + '\n', sourceHash, commit, files }
}

/** Read the source-hash recorded in an existing output file, if any. */
function storedHash() {
  if (!fs.existsSync(OUTPUT)) return null
  const match = /^ \* source-hash (\w+)$/m.exec(fs.readFileSync(OUTPUT, 'utf8'))
  return match ? match[1] : null
}

const sourceDir = resolveSource()
const result = generate(sourceDir)
const check = process.argv.includes('--check')

if (check) {
  const stored = storedHash()
  if (stored === result.sourceHash) {
    console.log(`src/theme/theme.css is up to date (source-hash ${stored}).`)
    process.exit(0)
  }
  console.error(
    stored
      ? `src/theme/theme.css is stale — has ${stored}, canvas-web is at ${result.sourceHash}.`
      : 'src/theme/theme.css is missing or has no provenance header.',
  )
  console.error('Run: npm run sync:theme')
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, result.text)

const themes = result.files.filter((f) => f.startsWith('themes/')).length
console.log(`  read  ${path.relative(repoRoot, sourceDir)} (canvas-web @ ${result.commit ?? 'unknown'})`)
console.log(`  wrote src/theme/theme.css  (${result.files.length} files, ${themes} themes, hash ${result.sourceHash})`)
