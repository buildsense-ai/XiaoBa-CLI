const packageJson = require("./package.json");

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
};
