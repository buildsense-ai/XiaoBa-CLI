import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const optionalNativePackages = ["canvas", "path2d"];
const obsoleteDeasyncBinaries = [
  "darwin-x64-node-0.10",
  "darwin-x64-node-0.11",
  "darwin-x64-node-0.12",
];

for (const packageName of optionalNativePackages) {
  const packagePath = path.resolve(repoRoot, "node_modules", packageName);
  const nodeModulesRoot = path.resolve(repoRoot, "node_modules") + path.sep;

  if (!packagePath.startsWith(nodeModulesRoot)) {
    throw new Error(`Refusing to prune outside node_modules: ${packagePath}`);
  }

  if (!fs.existsSync(packagePath)) {
    continue;
  }

  fs.rmSync(packagePath, { recursive: true, force: true });
  console.log(`Pruned optional native package for Electron build: ${packageName}`);
}

const deasyncBinRoot = path.resolve(repoRoot, "node_modules", "deasync", "bin");
for (const binaryDirectory of obsoleteDeasyncBinaries) {
  const binaryPath = path.resolve(deasyncBinRoot, binaryDirectory);
  if (!binaryPath.startsWith(deasyncBinRoot + path.sep)) {
    throw new Error(`Refusing to prune outside deasync/bin: ${binaryPath}`);
  }

  if (!fs.existsSync(binaryPath)) {
    continue;
  }

  fs.rmSync(binaryPath, { recursive: true, force: true });
  console.log(`Pruned obsolete deasync binary from Electron build: ${binaryDirectory}`);
}
