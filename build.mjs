import archiver from 'archiver'
import esbuild from 'esbuild'
import fs from 'fs-extra'
import process from 'node:process'
import path from 'path'

const outdir = 'build'
const packagesDir = 'packages'
const appName = 'canvas-extension-'

const isDev = process.env.NODE_ENV === 'dev'

/*
 * Baseline the JS and CSS are compiled against.
 *
 * Chromium 111 / Firefox 128 is what the theme layer needs: src/theme/theme.css
 * uses OKLCH relative colour (`oklch(from var(--x) l c h / …)`), which esbuild
 * does not down-level. The previous chrome88/firefox109 target was aspirational
 * rather than true — nothing verified it, and the CSS would simply not render on
 * those versions. Engines older than this fall back through the `@supports not
 * (color: oklch(…))` block the theme ships for exactly that case.
 */
const target = ['chrome111', 'firefox128']

let buildConfig = {
  entryPoints: {
    'background/service-worker': 'src/background/service-worker.js',
    'popup/popup': 'src/popup/popup.js',
    'settings/settings': 'src/settings/settings.js',
  },
  bundle: true,
  outdir: outdir,
  treeShaking: true,
  minify: !isDev,
  drop: isDev ? [] : ['console', 'debugger'],
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  format: 'esm',
  target,
  loader: {
    '.png': 'file',
    '.svg': 'file',
    '.ico': 'file',
  },
  external: [],
}

/*
 * CSS is its own esbuild pass.
 *
 * popup.css and settings.css are @import manifests over the partials in the
 * same directory plus src/theme/theme.css; esbuild resolves those and emits one
 * flat file per page, so nothing @imports at runtime.
 *
 * Separate from the JS config on purpose — that one is `format: 'esm'`, and a
 * CSS entry point in an ESM build is a category error. Keeping them apart also
 * means the JS pass never has to carry a `.css` loader entry, which is what
 * would turn a stylesheet into a JS module.
 */
const cssBuildConfig = {
  entryPoints: {
    'popup/popup': 'src/popup/popup.css',
    'settings/settings': 'src/settings/settings.css',
  },
  bundle: true,
  outdir: outdir,
  minify: !isDev,
  legalComments: 'none',
  target,
  // Nothing should leave the bundle. The only url() in the sources is a data:
  // URI, which esbuild passes through untouched.
  external: [],
}

/*
 * The pre-paint theme applier, built alone because it is the one script that
 * must NOT be a module.
 *
 * popup.html and settings.html load it from <head> as a classic
 * <script src>, above the stylesheet. A module script is deferred and would run
 * after first paint, which reintroduces exactly the flash of the default theme
 * it exists to prevent. IIFE keeps it synchronous and render-blocking.
 */
const themeInitBuildConfig = {
  entryPoints: { 'theme/theme-init': 'src/theme/theme-init.js' },
  bundle: true,
  outdir: outdir,
  minify: !isDev,
  legalComments: 'none',
  format: 'iife',
  target,
}

async function deleteOldDir() {
  await fs.remove(outdir)
  await fs.remove(packagesDir)
}

async function runEsbuild() {
  console.log('Building JavaScript files...')
  await esbuild.build(buildConfig)

  console.log('Building the pre-paint theme applier...')
  await esbuild.build(themeInitBuildConfig)

  console.log('Bundling CSS...')
  await esbuild.build(cssBuildConfig)
}

async function zipFolder(dir) {
  const output = fs.createWriteStream(`${dir}.zip`)
  const archive = archiver('zip', {
    zlib: { level: 9 },
  })
  archive.pipe(output)
  archive.directory(dir, false)
  await archive.finalize()
}

async function copyFiles(entryPoints, targetDir) {
  await fs.ensureDir(targetDir)
  await Promise.all(
    entryPoints.map(async (entryPoint) => {
      await fs.copy(entryPoint.src, `${targetDir}/${entryPoint.dst}`)
    }),
  )
}

function copyDirectoryContent(source, destination) {
  try {
    if (!fs.existsSync(source)) {
      console.log(`Source directory ${source} does not exist, skipping...`)
      return
    }

    // Get list of files and directories in source directory
    const items = fs.readdirSync(source);

    // Loop through each item
    for (const item of items) {
      // Get the full path of the item
      const itemPath = path.join(source, item);

      // Get the stats of the item
      const stats = fs.statSync(itemPath);

      // Determine if the item is a file or directory
      if (stats.isFile()) {
        // If it's a file, copy it to the destination directory
        fs.copyFileSync(itemPath, path.join(destination, item));
      } else if (stats.isDirectory()) {
        // If it's a directory, create it in the destination directory
        fs.ensureDirSync(path.join(destination, item));

        // Recursively copy files in the subdirectory
        copyDirectoryContent(itemPath, path.join(destination, item));
      }
    }
  } catch (err) {
    console.error('Error copying directory content:', err);
  }
}

async function exportForBrowser(browser) {
  console.log(`Building for ${browser}...`)

  const browserDir = `./${outdir}/${browser}`

    // Common files to copy
  const commonFiles = [
    // Background script (will be renamed for Firefox)
    { src: 'build/background/service-worker.js', dst: 'service-worker.js' },

    // Pre-paint theme applier. Shared by both pages, loaded from <head>.
    { src: 'build/theme/theme-init.js', dst: 'theme/theme-init.js' },

    // Popup files. The CSS comes from build/, not src/ — it is an @import
    // manifest over ../theme/theme.css and the partials beside it, and esbuild
    // has already flattened it.
    { src: 'src/popup/popup.html', dst: 'popup/popup.html' },
    { src: 'build/popup/popup.js', dst: 'popup/popup.js' },
    { src: 'build/popup/popup.css', dst: 'popup/popup.css' },

    // Settings files
    { src: 'src/settings/settings.html', dst: 'settings/settings.html' },
    { src: 'build/settings/settings.js', dst: 'settings/settings.js' },
    { src: 'build/settings/settings.css', dst: 'settings/settings.css' },

    // Manifest (browser-specific)
    { src: `manifest-${browser}.json`, dst: 'manifest.json' },
  ]

  // Copy all files
  await copyFiles(commonFiles, browserDir)

  // For Firefox, also copy service worker as background.js
  if (browser === 'firefox') {
    await fs.copy('build/background/service-worker.js', `${browserDir}/background.js`);
  }

  // Copy assets directory if it exists
  if (fs.existsSync('assets')) {
    console.log(`Copying assets for ${browser}...`)
    copyDirectoryContent('assets', path.join(browserDir, 'assets'))
  } else {
    // Create basic icon structure if assets don't exist
    await fs.ensureDir(path.join(browserDir, 'assets', 'icons'))
    console.log(`Assets directory not found, created placeholder for ${browser}`)
    console.warn(`⚠️  Missing logo: assets/icons/logo-wr_64x64.png`)
    console.warn(`   The extension will work but may show broken icon images`)
  }

  // Update manifest paths for the build structure
  const manifestPath = path.join(browserDir, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    // Update background script path
    if (manifest.background) {
      if (browser === 'chromium') {
        manifest.background.service_worker = 'service-worker.js'
        delete manifest.background.scripts
        delete manifest.background.type
      } else if (browser === 'firefox') {
        manifest.background.scripts = ['background.js']
        delete manifest.background.service_worker
        delete manifest.background.type
      }
    }

    // Update popup path
    if (manifest.action && manifest.action.default_popup) {
      manifest.action.default_popup = 'popup/popup.html'
    }

    // Update web accessible resources
    if (manifest.web_accessible_resources) {
      manifest.web_accessible_resources[0].resources = ['settings/settings.html']
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }

  // Create zip package
  await zipFolder(browserDir)

  // Copy to packages directory
  await fs.ensureDir(packagesDir)
  await copyFiles(
    [
      {
        src: `${outdir}/${browser}.zip`,
        dst: `${appName}${browser}.zip`,
      },
    ],
    `./${packagesDir}`,
  )

  // Also copy unzipped folder
  await copyFiles(
    [
      {
        src: `${outdir}/${browser}`,
        dst: `./${browser}`,
      },
    ],
    `./${packagesDir}`,
  )

  console.log(`✅ ${browser} build complete`)
}

async function build() {
  console.log('🚀 Starting Canvas Browser Extension build...')

  try {
    // Clean previous builds
    await deleteOldDir()

    // Build JavaScript with esbuild
    await runEsbuild()

    // Build for Chromium-based browsers
    await exportForBrowser('chromium')

    // Build for Firefox
    await exportForBrowser('firefox')

    console.log('🎉 Build completed successfully!')
    console.log('')
    console.log('📦 Packages created:')
    console.log(`  - packages/chromium/ (development)`)
    console.log(`  - packages/firefox/ (development)`)
    console.log(`  - packages/${appName}chromium.zip (distribution)`)
    console.log(`  - packages/${appName}firefox.zip (distribution)`)
    console.log('')
    console.log('🔧 To install for development:')
    console.log('  Chrome: Load unpacked -> packages/chromium/')
    console.log('  Firefox: about:debugging -> Load Temporary Add-on -> packages/firefox/manifest.json')

  } catch (error) {
    console.error('❌ Build failed:', error)
    process.exit(1)
  }
}

build()
