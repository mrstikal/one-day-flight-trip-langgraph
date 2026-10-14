import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Same-origin VAD asset preparation (VOICE_CONTROLL.md section 10).
 *
 * Copies the pinned Silero model, the bundled AudioWorklet, and the matching
 * ONNX runtime `.wasm`/`.mjs` files from the installed dependencies into
 * `apps/web/public/voice-vad/`, so both `next dev` and `next build` serve them
 * from the app origin. Nothing is ever fetched from a CDN at run time and the
 * script fails closed when a pinned asset is missing. It runs before web
 * development and production builds via the workspace `predev`/`prebuild`
 * hooks.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(repoRoot, "apps/web/public/voice-vad");
const require = createRequire(import.meta.url);

function packageRoot(packageName: string): string {
  let dir = dirname(require.resolve(packageName));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`could not locate the install directory of ${packageName}`);
}

interface AssetSpec {
  readonly packageName: string;
  readonly source: string;
  readonly target: string;
}

function pinnedAssets(vadRoot: string, ortRoot: string): readonly AssetSpec[] {
  return [
    {
      packageName: "@ricky0123/vad-web",
      source: join(vadRoot, "dist/silero_vad_v5.onnx"),
      target: "silero_vad_v5.onnx",
    },
    {
      packageName: "@ricky0123/vad-web",
      source: join(vadRoot, "dist/vad.worklet.bundle.min.js"),
      target: "vad.worklet.bundle.min.js",
    },
    {
      packageName: "onnxruntime-web",
      source: join(ortRoot, "dist/ort-wasm-simd-threaded.wasm"),
      target: "ort-wasm-simd-threaded.wasm",
    },
    {
      packageName: "onnxruntime-web",
      source: join(ortRoot, "dist/ort-wasm-simd-threaded.mjs"),
      target: "ort-wasm-simd-threaded.mjs",
    },
    {
      packageName: "onnxruntime-web",
      source: join(ortRoot, "dist/ort-wasm-simd-threaded.jsep.wasm"),
      target: "ort-wasm-simd-threaded.jsep.wasm",
    },
    {
      packageName: "onnxruntime-web",
      source: join(ortRoot, "dist/ort-wasm-simd-threaded.jsep.mjs"),
      target: "ort-wasm-simd-threaded.jsep.mjs",
    },
  ];
}

function packageManifest(root: string): { name: string; version: string; license?: string } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string;
  };
}

function copyIfChanged(source: string, target: string): boolean {
  if (existsSync(target)) {
    const sourceStat = statSync(source);
    const targetStat = statSync(target);
    // A reinstall/re-pin touches the source mtime, so stale same-size copies
    // are still refreshed.
    if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
      return false;
    }
  }
  copyFileSync(source, target);
  return true;
}

function shippedLicenseFiles(root: string): string[] {
  return readdirSync(root).filter((entry) => /^licen[cs]e/i.test(entry));
}

function main(): void {
  const vadRoot = packageRoot("@ricky0123/vad-web");
  const ortRoot = packageRoot("onnxruntime-web");
  const assets = pinnedAssets(vadRoot, ortRoot);

  const missing = assets.filter((asset) => !existsSync(asset.source));
  if (missing.length > 0) {
    for (const asset of missing) {
      console.error(`missing pinned VAD asset: ${asset.source}`);
    }
    throw new Error(
      "pinned VAD assets are missing; run npm install with the pinned @ricky0123/vad-web and onnxruntime-web versions",
    );
  }

  mkdirSync(outputDir, { recursive: true });
  let copied = 0;
  for (const asset of assets) {
    if (copyIfChanged(asset.source, join(outputDir, asset.target))) {
      copied += 1;
    }
  }

  // Preserve upstream license/provenance notices without inventing texts: copy
  // any shipped license files and always record declared package metadata.
  const packageRoots = [
    { root: vadRoot, manifest: packageManifest(vadRoot) },
    { root: ortRoot, manifest: packageManifest(ortRoot) },
  ];
  const copiedLicenses: Array<{ packageName: string; target: string }> = [];
  for (const { root, manifest } of packageRoots) {
    for (const licenseFile of shippedLicenseFiles(root)) {
      const target = `LICENSE-${manifest.name.replace(/[/@]/g, "-")}`;
      copyFileSync(join(root, licenseFile), join(outputDir, target));
      copiedLicenses.push({ packageName: manifest.name, target });
    }
  }
  const provenance = {
    generatedBy: "scripts/voice-vad-assets.ts",
    note: "Generated copies of pinned VAD/model/runtime assets; safe to delete, regenerated on dev/build.",
    packages: packageRoots.map(({ root, manifest }) => ({
      name: manifest.name,
      version: manifest.version,
      declaredLicense: manifest.license ?? null,
      shippedLicenseFiles: shippedLicenseFiles(root),
    })),
    copiedLicenseFiles: copiedLicenses,
    files: assets.map((asset) => ({ target: asset.target, sourcePackage: asset.packageName })),
  };
  writeFileSync(
    join(outputDir, "MANIFEST.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `voice VAD assets ready in ${relative(repoRoot, outputDir)} (${String(assets.length)} pinned files, ${String(copied)} updated)`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
