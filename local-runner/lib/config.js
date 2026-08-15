const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.txt");

const DEFAULTS = {
  SERVER_URL: "https://waqas-ai-studio.waqaskhan1437.workers.dev",
  FRONTEND_URL: "https://frontend-nine-jet-27.vercel.app",
  RUNNER_TOKEN: "",
  ACCESS_TOKEN: "",
  POSTFORME_API_KEY: "",
};

function readConfigFile(defaults = {}) {
  const config = { ...defaults };
  if (!fs.existsSync(CONFIG_PATH)) {
    return config;
  }

  const lines = fs.readFileSync(CONFIG_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) {
      continue;
    }

    config[key.trim()] = rest.join("=").trim();
  }

  return config;
}

module.exports = {
  CONFIG_PATH,
  DEFAULTS,
  readConfigFile,
};
