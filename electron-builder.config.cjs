const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("./package.json");

const DESKTOP_EXCLUDED_PRODUCTION_DEPENDENCIES = ["deasync"];

function removeDesktopExcludedDependencies(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const appNodeModules = path.join(resourcesDir, "app", "node_modules");
  const nodeModulesRoot = path.resolve(appNodeModules) + path.sep;

  for (const packageName of DESKTOP_EXCLUDED_PRODUCTION_DEPENDENCIES) {
    const packagePath = path.resolve(appNodeModules, packageName);
    if (!packagePath.startsWith(nodeModulesRoot)) {
      throw new Error(`Refusing to remove a desktop dependency outside node_modules: ${packagePath}`);
    }
    if (!fs.existsSync(packagePath)) continue;
    fs.rmSync(packagePath, { recursive: true, force: true });
    console.log(`Removed desktop-excluded production dependency: ${packageName}`);
  }
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/\/+$/, "");
}

function getPublishConfig() {
  const githubPublish = packageJson.build?.publish || {};
  const updateBaseUrl = normalizeBaseUrl(process.env.XIAOBA_UPDATE_BASE_URL);

  if (updateBaseUrl) {
    return [
      {
        provider: "generic",
        url: updateBaseUrl,
        // Volcengine TOS supports single byte-range requests, but responds to
        // a multi-range request with the complete object. electron-updater
        // otherwise downloads the full installer while attempting a delta.
        useMultipleRangeRequest: false,
      },
      {
        provider: "github",
        owner: process.env.XIAOBA_UPDATE_GITHUB_OWNER || githubPublish.owner || "buildsense-ai",
        repo: process.env.XIAOBA_UPDATE_GITHUB_REPO || githubPublish.repo || "XiaoBa-CLI",
        publishAutoUpdate: false,
      },
    ];
  }

  return {
    provider: "github",
    owner: process.env.XIAOBA_UPDATE_GITHUB_OWNER || githubPublish.owner || "buildsense-ai",
    repo: process.env.XIAOBA_UPDATE_GITHUB_REPO || githubPublish.repo || "XiaoBa-CLI",
  };
}

module.exports = {
  ...packageJson.build,
  publish: getPublishConfig(),
  afterPack: removeDesktopExcludedDependencies,
};
