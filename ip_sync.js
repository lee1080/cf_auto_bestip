// cron "*/5 * * * *" ip_sync.js, tag:Cloudflare IP同步
function Env(name) {
  this.name = name;
}
const syncEnv = new Env("Cloudflare IP同步");
/**
 * Cloudflare 域名优选 IP 自动故障转移与解析同步脚本 (Node.js 版)
 *
 * 本地存储协作版改动：
 * - 支持从同目录 `config.txt` 自动加载环境变量（缺失时补齐）
 * - CF_IP_POOL 支持“本地文件路径”（相对/绝对），用于直接读取 cfst_select.js 落盘的优选 IP 列表
 * - 若 CF_IP_POOL 为空，默认读取 `./data/cfst_select/preferred_ips.txt`
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const {
  resolveDataDir,
  loadEnvFromConfigTxtIfNeeded,
  parseConfigShToEnv,
  loadEnvFromQingLongConfigIfNeeded,
  findBinaryRecursive,
  findFileUpwards,
  sendNotification,
  cidrToIps,
  expandCidrs,
  extractValidIpv4Candidates,
  normalizeIpv4Candidate,
  spawnWithCleanOutput,
} = require("./utils/shared");

function getSyncDataPaths(dataRootDir = resolveDataDir()) {
  const dataDir = path.join(dataRootDir, "ip_sync");
  return {
    dataRootDir,
    dataDir,
    defaultPoolFile: path.join(dataRootDir, "cfst_select", "preferred_ips.txt"),
    preferredOutputFile: path.join(dataDir, "preferred_ips.txt"),
    gistIdStateFile: path.join(dataDir, "gist_id.txt"),
    inputFilePath: path.join(dataDir, "ips.txt"),
    resultCsvPath: path.join(dataDir, "result.csv"),
  };
}

function ensureDataDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensurePreferredOutputFile(filePath = PREFERRED_OUTPUT_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
  }
  return filePath;
}

function writePreferredOutputFile(ips, filePath = PREFERRED_OUTPUT_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${ips.join("\n")}\n`, "utf8");
  return filePath;
}

// ================================
// 兼容青龙/本地配置自动加载变量
// ================================

const CONFIG_TXT_PATH = path.join(__dirname, "config.txt");

// 优先级：青龙环境变量(天然优先) > 青龙配置 -> 再用本目录 config.txt 补齐默认值
loadEnvFromQingLongConfigIfNeeded();
loadEnvFromConfigTxtIfNeeded(CONFIG_TXT_PATH);

const SYNC_DATA_PATHS = getSyncDataPaths();
const DATA_DIR = ensureDataDir(SYNC_DATA_PATHS.dataDir);
const DEFAULT_POOL_FILE = SYNC_DATA_PATHS.defaultPoolFile;
const PREFERRED_OUTPUT_FILE = SYNC_DATA_PATHS.preferredOutputFile;
const GIST_ID_STATE_FILE = SYNC_DATA_PATHS.gistIdStateFile;
const CFST_CANDIDATES =
  os.platform() === "win32"
    ? ["CloudflareST.exe", "cfst.exe"]
    : ["CloudflareST", "cfst"];

// --- 配置区域 (优先从环境变量读取) ---
function normalizeIpUpdateMode(rawMode) {
  return rawMode === "speed" ? "speed" : "latency";
}

function parseBooleanEnv(rawValue) {
  return (
    String(rawValue || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function parseIntegerEnvValue(rawValue) {
  if (typeof rawValue === "number" && Number.isInteger(rawValue)) {
    return rawValue;
  }

  const value = String(rawValue ?? "").trim();
  if (!/^-?\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

function parsePositiveIntegerEnv(rawValue, defaultValue) {
  const parsed = parseIntegerEnvValue(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseNonNegativeIntegerEnv(rawValue, defaultValue) {
  const parsed = parseIntegerEnvValue(rawValue);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parseOptionalPositiveIntegerEnv(rawValue) {
  const parsed = parseIntegerEnvValue(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalPositiveFloatEnv(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolvePositiveIntegerEnvWithFallback(
  env,
  primaryKey,
  fallbackKey,
  defaultValue,
) {
  const primary = parseOptionalPositiveIntegerEnv(env[primaryKey]);
  if (primary !== null) return primary;
  const fallback = parseOptionalPositiveIntegerEnv(env[fallbackKey]);
  return fallback !== null ? fallback : defaultValue;
}

function resolvePositiveFloatEnvWithFallback(
  env,
  primaryKey,
  fallbackKey,
  defaultValue,
) {
  const primary = parseOptionalPositiveFloatEnv(env[primaryKey]);
  if (primary !== null) return primary;
  const fallback = parseOptionalPositiveFloatEnv(env[fallbackKey]);
  return fallback !== null ? fallback : defaultValue;
}

function resolveStringEnvWithFallback(env, primaryKey, fallbackKey, defaultValue) {
  const primary = String(env[primaryKey] ?? "").trim();
  if (primary) return primary;
  const fallback = String(env[fallbackKey] ?? "").trim();
  return fallback || defaultValue;
}

function getMissingCloudflareOutputConfig(config) {
  return ["CF_API_TOKEN", "CF_ZONE_ID", "CF_DOMAIN"].filter(
    (key) => !config[key],
  );
}

function getMissingGistOutputConfig(config) {
  return ["GITHUB_TOKEN", "GIST_NAME"].filter((key) => !config[key]);
}

function getMissingS3OutputConfig(config) {
  return [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_KEY",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ].filter((key) => !config[key]);
}

function hasCloudflareOutput(config) {
  return getMissingCloudflareOutputConfig(config).length === 0;
}

function hasGistOutput(config) {
  return getMissingGistOutputConfig(config).length === 0;
}

function hasS3Output(config) {
  return getMissingS3OutputConfig(config).length === 0;
}

function formatGistIpContent(ips) {
  return ips.join("\n");
}

function formatInputSourceSummary({ directCount, urlCount, fileCount }) {
  return `📋 输入来源: 直接 IP ${directCount} 个 | 远程 URL ${urlCount} 个 | 本地文件 ${fileCount} 个`;
}

function formatLatencySelectionSummary(selection) {
  return [
    "📊 Latency 全量探测结果:",
    ...selection.allResults.map((result) =>
      result.success
        ? `   - ${result.ip} | ${result.latency} ms`
        : `   - ${result.ip} | ${result.reason || "failed"}`,
    ),
    "✅ Latency 最终保留结果:",
    ...selection.finalResults.map(
      (result) => `   - ${result.ip} | ${result.latency} ms`,
    ),
  ];
}

function formatSpeedSelectionSummary(selection) {
  return [
    "📊 Speed 候选测速结果:",
    ...selection.allResults.map(
      (result) => `   - ${result.ip} | ${result.speed.toFixed(2)} MB/s`,
    ),
    "✅ Speed 最终保留结果:",
    ...selection.finalResults.map(
      (result) => `   - ${result.ip} | ${result.speed.toFixed(2)} MB/s`,
    ),
  ];
}

function formatSelectionOutput(selection) {
  const summaryLines =
    selection.mode === "speed"
      ? formatSpeedSelectionSummary(selection)
      : formatLatencySelectionSummary(selection);

  return [
    ...summaryLines,
    `✅ 最终目标 IP 集合: [${selection.finalHealthyIps.join(", ")}]`,
  ].join("\n");
}

function formatDnsOutputSummary(output) {
  if (!output.triggered) {
    return `ℹ️ Cloudflare DNS: 已跳过，缺少配置: ${output.missingConfig.join(", ")}`;
  }
  if (output.error) {
    return `❌ Cloudflare DNS: ${output.error}`;
  }
  if (!output.result) return "";
  return `☁️ Cloudflare DNS 结果: 当前 ${output.result.currentIps.length} 条 | 计划新增 ${output.result.toAdd.length} | 计划删除 ${output.result.toDelete.length} | 成功 ${output.result.successfulChangeCount} | 失败 ${output.result.failedChangeCount}`;
}

function formatGistOutputSummary(output) {
  if (!output.triggered) {
    return `ℹ️ Gist: 已跳过，缺少配置: ${output.missingConfig.join(", ")}`;
  }
  if (output.error) {
    return `❌ Gist: 同步失败 | 文件 ${output.filename} | ${output.error}`;
  }
  if (!output.result) return "";
  return `📝 Gist 结果: ${output.result.action} | gistId ${output.result.gistId} | 文件 ${output.filename}`;
}

function formatS3OutputSummary(output) {
  if (!output.triggered) {
    return `ℹ️ S3: 已跳过，缺少配置: ${output.missingConfig.join(", ")}`;
  }
  if (output.error) {
    return `❌ S3: 上传失败 | bucket ${output.bucket} | key ${output.key} | ${output.error}`;
  }
  if (!output.result) return "";
  return `📦 S3 结果: ${output.result.action} | bucket ${output.result.bucket} | key ${output.result.key}`;
}

function readGistIdStateFile(filePath = GIST_ID_STATE_FILE) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8").trim();
}

function writeGistIdStateFile(gistId, filePath = GIST_ID_STATE_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${gistId}\n`, "utf8");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmacSha256(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function encodeS3PathPart(part) {
  return encodeURIComponent(part).replace(/%2F/g, "/");
}

function buildS3PutObjectRequest(config, content, now = new Date()) {
  const endpoint = new URL(config.S3_ENDPOINT);
  if (endpoint.protocol !== "https:" && !config.S3_ALLOW_HTTP) {
    throw new Error("S3_ENDPOINT must use https unless S3_ALLOW_HTTP=true");
  }

  const body = content;
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const endpointPathPrefix =
    endpoint.pathname && endpoint.pathname !== "/"
      ? endpoint.pathname.replace(/\/+$/, "")
      : "";
  const canonicalUri = `${endpointPathPrefix}/${encodeURIComponent(config.S3_BUCKET)}/${config.S3_KEY.split("/").map(encodeS3PathPart).join("/")}`;
  const host = endpoint.host;
  const payloadHash = sha256Hex(body);
  const headers = {
    "cache-control": "no-cache, max-age=0",
    "content-type": "text/plain",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.S3_REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(
    config.S3_SECRET_ACCESS_KEY,
    dateStamp,
    config.S3_REGION,
    "s3",
  );
  const signature = hmacSha256(signingKey, stringToSign, "hex");

  return {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port || "",
    method: "PUT",
    path: canonicalUri,
    body,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.S3_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function uploadS3Request(request) {
  const transport = request.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: request.hostname,
        port: request.port || undefined,
        method: request.method,
        path: request.path,
        headers: request.headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: raw });
            return;
          }
          reject(new Error(`HTTP ${res.statusCode}${raw ? ` ${raw}` : ""}`));
        });
      },
    );
    req.on("error", reject);
    req.write(request.body);
    req.end();
  });
}

async function syncS3IpList(config, finalHealthyIps, deps = {}) {
  const request = buildS3PutObjectRequest(
    config,
    formatGistIpContent(finalHealthyIps),
    deps.now ? deps.now() : new Date(),
  );
  const upload = deps.uploadS3Request || uploadS3Request;
  await upload(request);
  return {
    action: "uploaded",
    bucket: config.S3_BUCKET,
    key: config.S3_KEY,
  };
}

function parseRuntimeConfig(env) {
  const maxIps = parsePositiveIntegerEnv(env.MAX_IPS, 2);
  const sharedDuration = resolvePositiveIntegerEnvWithFallback(
    env,
    "IP_SYNC_SPEED_TEST_DURATION_S",
    "CFST_SELECT_SPEED_TEST_DURATION_S",
    10,
  );

  return {
    CF_API_TOKEN: env.CF_API_TOKEN,
    CF_ZONE_ID: env.CF_ZONE_ID,
    CF_DOMAIN: env.CF_DOMAIN,
    CF_IP_POOL: env.CF_IP_POOL || "",
    MAX_IPS: maxIps,
    NOTIFY_THRESHOLD: parseNonNegativeIntegerEnv(env.NOTIFY_THRESHOLD, 2),
    IP_UPDATE_MODE: normalizeIpUpdateMode(env.IP_UPDATE_MODE),
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GIST_NAME: (env.GIST_NAME || "").trim(),
    GIST_SECRET: parseBooleanEnv(env.GIST_SECRET),
    S3_ENDPOINT: (env.S3_ENDPOINT || "").trim(),
    S3_REGION: (env.S3_REGION || "").trim(),
    S3_BUCKET: (env.S3_BUCKET || "").trim(),
    S3_KEY: (env.S3_KEY || "").trim(),
    S3_ACCESS_KEY_ID: (env.S3_ACCESS_KEY_ID || "").trim(),
    S3_SECRET_ACCESS_KEY: (env.S3_SECRET_ACCESS_KEY || "").trim(),
    S3_ALLOW_HTTP: parseBooleanEnv(env.S3_ALLOW_HTTP),
    IP_SYNC_LATENCY_THRESHOLD: resolvePositiveIntegerEnvWithFallback(
      env,
      "IP_SYNC_LATENCY_THRESHOLD",
      "CFST_SELECT_LATENCY_THRESHOLD",
      500,
    ),
    IP_SYNC_TEST_COUNT: resolvePositiveIntegerEnvWithFallback(
      env,
      "IP_SYNC_TEST_COUNT",
      "CFST_SELECT_TEST_COUNT",
      30,
    ),
    IP_SYNC_LATENCY_TEST_CONCURRENCY: resolvePositiveIntegerEnvWithFallback(
      env,
      "IP_SYNC_LATENCY_TEST_CONCURRENCY",
      "CFST_SELECT_LATENCY_TEST_CONCURRENCY",
      200,
    ),
    IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS: resolvePositiveFloatEnvWithFallback(
      env,
      "IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS",
      "CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS",
      10,
    ),
    IP_SYNC_SPEED_TEST_URL: resolveStringEnvWithFallback(
      env,
      "IP_SYNC_SPEED_TEST_URL",
      "CFST_SELECT_SPEED_TEST_URL",
      "",
    ),
    IP_SYNC_SPEED_TEST_DURATION_S:
      parseOptionalPositiveIntegerEnv(env.IP_SYNC_SPEED_TEST_DURATION_S) ??
      getSpeedModeDurationSeconds(sharedDuration),
    IP_SYNC_SPEED_CANDIDATE_COUNT:
      parseOptionalPositiveIntegerEnv(env.IP_SYNC_SPEED_CANDIDATE_COUNT) ??
      getSpeedModeCandidateCount(maxIps),
  };
}

function loadRuntimeConfig() {
  return parseRuntimeConfig(process.env);
}

const TEST_TIMEOUT = 2000;

function parseIpsFromText(text) {
  return expandCidrs(
    extractValidIpv4Candidates(text).map((candidate) =>
      candidate.includes(":") ? candidate.split(":")[0] : candidate,
    ),
  );
}

function fetchIpsFromUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn(`  ⚠️ 获取 ${url} 失败，HTTP ${res.statusCode}`);
          resolve([]);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const ips = parseIpsFromText(data);
          console.log(`   ✅ 远程 URL: ${url} -> ${ips.length} 个 IP`);
          resolve(ips);
        });
      })
      .on("error", (e) => {
        console.warn(`  ⚠️ 获取 ${url} 出错: ${e.message}`);
        resolve([]);
      });
  });
}

function readIpsFromLocalFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, "utf8");
    const ips = parseIpsFromText(data);
    console.log(`   ✅ 本地文件: ${filePath} -> ${ips.length} 个 IP`);
    return ips;
  } catch (e) {
    console.warn(`  ⚠️ 读取本地文件失败 ${filePath}: ${e.message}`);
    return [];
  }
}

function isProbablyLocalPath(item) {
  if (!item) return false;
  if (item.startsWith("http://") || item.startsWith("https://")) return false;
  // 允许相对路径/绝对路径；也允许 file://
  if (item.startsWith("file://")) return true;
  if (
    item.startsWith("./") ||
    item.startsWith("../") ||
    item.startsWith("/") ||
    item.includes(path.sep)
  )
    return true;
  // 纯文件名但存在于同目录/data 里也算
  return fs.existsSync(path.resolve(__dirname, item));
}

function resolvePoolFilePath(item) {
  if (item.startsWith("file://")) return item.slice("file://".length);
  return path.isAbsolute(item) ? item : path.resolve(__dirname, item);
}

async function parseIpPool(poolStr) {
  const str = poolStr && poolStr.trim() ? poolStr.trim() : DEFAULT_POOL_FILE;
  const items = str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const directIps = [];
  const urlItems = [];
  const fileItems = [];

  for (const item of items) {
    if (item.startsWith("http://") || item.startsWith("https://")) {
      urlItems.push(item);
      continue;
    }
    if (isProbablyLocalPath(item)) {
      fileItems.push(resolvePoolFilePath(item));
      continue;
    }

    const normalizedItem = normalizeIpv4Candidate(item);
    if (normalizedItem) {
      if (normalizedItem.includes("/")) {
        directIps.push(...cidrToIps(normalizedItem));
      } else {
        directIps.push(normalizedItem.includes(":") ? normalizedItem.split(":")[0] : normalizedItem);
      }
    } else {
      console.warn(`  ⚠️ 跳过无效条目: ${item}`);
    }
  }

  console.log(
    formatInputSourceSummary({
      directCount: directIps.length,
      urlCount: urlItems.length,
      fileCount: fileItems.length,
    }),
  );

  const remoteResults = await Promise.all(
    urlItems.map((url) => fetchIpsFromUrl(url)),
  );
  const remoteIps = remoteResults.flat();
  const localIps = fileItems.flatMap((fp) => readIpsFromLocalFile(fp));

  return Array.from(new Set([...directIps, ...remoteIps, ...localIps]));
}

function findExistingCfstBinary(startDir = __dirname) {
  return findBinaryRecursive(startDir, CFST_CANDIDATES);
}

function parseCfstCsvResults(csvPath) {
  const data = fs.readFileSync(csvPath, "utf8");
  const lines = data.split("\n").filter(Boolean);
  return lines
    .slice(1)
    .map((line) => {
      const cols = line.split(",");
      return {
        ip: cols[0],
        speed: parseFloat(cols[5]),
      };
    })
    .filter((result) => result.ip && !Number.isNaN(result.speed));
}

async function defaultRunCfst({
  cfstBinaryPath,
  inputFilePath,
  resultCsvPath,
  config,
}) {
  const args = [
    "-f",
    inputFilePath,
    "-tl",
    String(config.IP_SYNC_LATENCY_THRESHOLD),
    "-sl",
    String(config.IP_SYNC_DOWNLOAD_SPEED_THRESHOLD_MBPS),
    "-dn",
    String(config.IP_SYNC_TEST_COUNT || Math.max(config.MAX_IPS, 10)),
    "-dt",
    String(config.IP_SYNC_SPEED_TEST_DURATION_S),
    "-n",
    String(config.IP_SYNC_LATENCY_TEST_CONCURRENCY),
  ];

  if (config.IP_SYNC_SPEED_TEST_URL) {
    args.push("-url", config.IP_SYNC_SPEED_TEST_URL);
  }

  const exitCode = await spawnWithCleanOutput(cfstBinaryPath, args, {
    cwd: path.dirname(resultCsvPath),
  });
  if (exitCode !== 0)
    throw new Error(`CloudflareST exited with code ${exitCode}`);
}

function testIp(ip) {
  return new Promise((resolve) => {
    const start = Date.now();
    const options = {
      hostname: ip,
      port: 443,
      path: "/cdn-cgi/trace",
      method: "GET",
      headers: { Host: "cloudflare.com" },
      timeout: TEST_TIMEOUT,
      rejectUnauthorized: false,
    };

    const req = https.get(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        const latency = Date.now() - start;
        if (res.statusCode === 200 && body.includes("fl="))
          resolve({ ip, latency, success: true });
        else resolve({ ip, success: false });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ip, success: false, reason: "timeout" });
    });

    req.on("error", (e) => {
      resolve({ ip, success: false, reason: e.message });
    });
  });
}

async function cfApiRequest(method, apiPath, data = null) {
  return new Promise((resolve, reject) => {
    const { CF_API_TOKEN } = loadRuntimeConfig();
    const options = {
      hostname: "api.cloudflare.com",
      port: 443,
      path: `/client/v4${apiPath}`,
      method: method,
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.success) resolve(json.result);
          else reject(new Error(JSON.stringify(json.errors)));
        } catch (e) {
          reject(new Error(`解析响应失败: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function githubApiRequest(method, apiPath, token, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      port: 443,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cf_auto_bestip",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = body ? JSON.parse(body) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else
            reject(new Error(json.message || `GitHub API ${res.statusCode}`));
        } catch (e) {
          reject(new Error(`解析 GitHub 响应失败: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function createGist(
  token,
  filename,
  content,
  isSecret,
  apiRequest = githubApiRequest,
) {
  return apiRequest("POST", "/gists", token, {
    public: !isSecret,
    files: {
      [filename]: {
        content,
      },
    },
  });
}

async function updateGist(
  token,
  gistId,
  filename,
  content,
  apiRequest = githubApiRequest,
) {
  return apiRequest("PATCH", `/gists/${gistId}`, token, {
    files: {
      [filename]: {
        content,
      },
    },
  });
}

async function syncGistIpList(config, finalHealthyIps, deps = {}) {
  const stateFilePath = deps.stateFilePath || GIST_ID_STATE_FILE;
  const apiRequest = deps.githubApiRequest || githubApiRequest;
  const content = formatGistIpContent(finalHealthyIps);
  const gistId = readGistIdStateFile(stateFilePath);

  if (gistId) {
    await updateGist(
      config.GITHUB_TOKEN,
      gistId,
      config.GIST_NAME,
      content,
      apiRequest,
    );
    return { action: "updated", gistId };
  }

  const created = await createGist(
    config.GITHUB_TOKEN,
    config.GIST_NAME,
    content,
    config.GIST_SECRET,
    apiRequest,
  );

  if (!created || !created.id) {
    throw new Error("创建 Gist 响应缺少 gist id");
  }

  writeGistIdStateFile(created.id, stateFilePath);
  return { action: "created", gistId: created.id };
}

function sortHealthyEntries(results) {
  return results
    .filter((result) => result.success)
    .sort((a, b) => a.latency - b.latency);
}

function buildLatencySelection(results, maxIps) {
  const healthyResults = sortHealthyEntries(results);
  const failedResults = results
    .filter((result) => !result.success)
    .map((result) => ({
      ip: result.ip,
      success: false,
      reason: result.reason || "failed",
    }));
  const finalResults = healthyResults.slice(0, maxIps);

  return {
    mode: "latency",
    allResults: [...healthyResults, ...failedResults],
    finalResults,
    finalHealthyIps: finalResults.map((result) => result.ip),
  };
}

async function mapWithConcurrencyLimit(items, concurrency, iteratee) {
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function selectIpsByLatency(poolIps, config, deps = {}) {
  const probe = deps.testIp || testIp;
  const probeConcurrency =
    Number.isInteger(config.IP_SYNC_LATENCY_TEST_CONCURRENCY) &&
    config.IP_SYNC_LATENCY_TEST_CONCURRENCY > 0
      ? config.IP_SYNC_LATENCY_TEST_CONCURRENCY
      : 200;
  const results = await mapWithConcurrencyLimit(
    poolIps,
    probeConcurrency,
    (ip) => probe(ip),
  );

  return buildLatencySelection(results, config.MAX_IPS);
}

function buildSpeedSelection(results, maxIps) {
  const finalResults = results.slice(0, maxIps);

  return {
    mode: "speed",
    allResults: results,
    finalResults,
    finalHealthyIps: finalResults.map((result) => result.ip),
  };
}

function getSpeedModeDurationSeconds(durationSeconds) {
  return Math.max(3, Math.floor(Number(durationSeconds) / 2));
}

function getSpeedModeCandidateCount(maxIps) {
  return Math.max(1, Number(maxIps) * 3);
}

async function selectIpsBySpeed(poolIps, config, deps = {}) {
  const probe = deps.testIp || testIp;
  const probeConcurrency =
    Number.isInteger(config.IP_SYNC_LATENCY_TEST_CONCURRENCY) &&
    config.IP_SYNC_LATENCY_TEST_CONCURRENCY > 0
      ? config.IP_SYNC_LATENCY_TEST_CONCURRENCY
      : 200;
  const probeResults = await mapWithConcurrencyLimit(
    poolIps,
    probeConcurrency,
    (ip) => probe(ip),
  );
  const candidates = sortHealthyEntries(probeResults)
    .slice(0, config.IP_SYNC_SPEED_CANDIDATE_COUNT)
    .map((result) => result.ip);

  if (candidates.length === 0) {
    return buildSpeedSelection([], config.MAX_IPS);
  }

  const dataPaths = deps.dataDir
    ? getSyncDataPaths(deps.dataDir)
    : { ...SYNC_DATA_PATHS, dataDir: DATA_DIR };
  const dataDir = ensureDataDir(dataPaths.dataDir);
  const inputFilePath = dataPaths.inputFilePath;
  const resultCsvPath = dataPaths.resultCsvPath;
  const cfstBinaryPath =
    deps.cfstBinaryPath ||
    (deps.findExistingCfstBinary || findExistingCfstBinary)(__dirname);

  if (!cfstBinaryPath) {
    throw new Error("未找到 CloudflareST，可先运行 cfst_select.js");
  }

  fs.writeFileSync(inputFilePath, candidates.join("\n"), "utf8");
  if (fs.existsSync(resultCsvPath)) fs.unlinkSync(resultCsvPath);

  const runCfst = deps.runCfst || defaultRunCfst;
  await runCfst({
    cfstBinaryPath,
    inputFilePath,
    resultCsvPath,
    config,
  });

  return buildSpeedSelection(
    parseCfstCsvResults(resultCsvPath),
    config.MAX_IPS,
  );
}

async function applyDnsChanges({
  currentRecords,
  finalHealthyIps,
  zoneId,
  domain,
  apiRequest = cfApiRequest,
}) {
  const currentIps = currentRecords.map((r) => r.content);
  const toDelete = currentRecords.filter(
    (r) => !finalHealthyIps.includes(r.content),
  );
  const toAdd = finalHealthyIps.filter((ip) => !currentIps.includes(ip));

  let successfulChangeCount = 0;
  let failedChangeCount = 0;

  for (const ip of toAdd) {
    console.log(`➕ 正在新增解析: ${ip} ...`);
    try {
      await apiRequest("POST", `/zones/${zoneId}/dns_records`, {
        type: "A",
        name: domain,
        content: ip,
        proxied: false,
        ttl: 60,
      });
      successfulChangeCount++;
    } catch (e) {
      failedChangeCount++;
      console.error(`❌ 添加失败: ${e.message}`);
    }
  }

  for (const record of toDelete) {
    console.log(`🗑️ 正在移除记录: ${record.content} ...`);
    try {
      await apiRequest(
        "DELETE",
        `/zones/${zoneId}/dns_records/${record.id}`,
        null,
      );
      successfulChangeCount++;
    } catch (e) {
      failedChangeCount++;
      console.error(`❌ 删除失败: ${e.message}`);
    }
  }

  return {
    currentIps,
    toDelete,
    toAdd,
    plannedChangeCount: toDelete.length + toAdd.length,
    successfulChangeCount,
    failedChangeCount,
  };
}

async function fetchCurrentDnsRecords(config, apiRequest = cfApiRequest) {
  return apiRequest(
    "GET",
    `/zones/${config.CF_ZONE_ID}/dns_records?name=${config.CF_DOMAIN}&type=A`,
  );
}

function buildOutputStates(config) {
  return {
    dns: {
      triggered: false,
      missingConfig: getMissingCloudflareOutputConfig(config),
      result: null,
      error: null,
    },
    gist: {
      triggered: false,
      missingConfig: getMissingGistOutputConfig(config),
      result: null,
      error: null,
      filename: config.GIST_NAME || "",
    },
    s3: {
      triggered: false,
      missingConfig: getMissingS3OutputConfig(config),
      result: null,
      error: null,
      bucket: config.S3_BUCKET || "",
      key: config.S3_KEY || "",
    },
  };
}

async function runOutputAdapter({ missingConfig, execute, extras = {} }) {
  if (missingConfig.length > 0) {
    return {
      triggered: false,
      missingConfig,
      result: null,
      error: null,
      ...extras,
    };
  }

  try {
    const result = await execute();
    return {
      triggered: true,
      missingConfig: [],
      result,
      error: null,
      ...extras,
    };
  } catch (error) {
    return {
      triggered: true,
      missingConfig: [],
      result: null,
      error: error.message,
      ...extras,
    };
  }
}

async function syncOutputs(config, finalHealthyIps, deps = {}) {
  const fetchDns = deps.fetchCurrentDnsRecords || fetchCurrentDnsRecords;
  const applyDns = deps.applyDnsChanges || applyDnsChanges;
  const syncGist = deps.syncGistIpList || syncGistIpList;
  const syncS3 = deps.syncS3IpList || syncS3IpList;
  const outputs = buildOutputStates(config);
  const adapters = [
    {
      name: "dns",
      missingConfig: outputs.dns.missingConfig,
      execute: async () => {
        const currentRecords = await fetchDns(
          config,
          deps.cfApiRequest || cfApiRequest,
        );
        return applyDns({
          currentRecords,
          finalHealthyIps,
          zoneId: config.CF_ZONE_ID,
          domain: config.CF_DOMAIN,
          apiRequest: deps.cfApiRequest || cfApiRequest,
        });
      },
    },
    {
      name: "gist",
      missingConfig: outputs.gist.missingConfig,
      extras: { filename: outputs.gist.filename },
      execute: async () =>
        syncGist(config, finalHealthyIps, deps.gistDeps || {}),
    },
    {
      name: "s3",
      missingConfig: outputs.s3.missingConfig,
      extras: { bucket: outputs.s3.bucket, key: outputs.s3.key },
      execute: async () => syncS3(config, finalHealthyIps, deps.s3Deps || {}),
    },
  ];

  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => ({
      name: adapter.name,
      output: await runOutputAdapter(adapter),
    })),
  );

  for (const item of settled) {
    if (item.status === "fulfilled") {
      outputs[item.value.name] = item.value.output;
      continue;
    }

    throw item.reason;
  }

  const summaries = [
    formatDnsOutputSummary(outputs.dns),
    formatGistOutputSummary(outputs.gist),
    formatS3OutputSummary(outputs.s3),
  ];

  for (const summary of summaries) {
    if (summary) console.log(summary);
  }

  if (
    !outputs.dns.triggered &&
    !outputs.gist.triggered &&
    !outputs.s3.triggered
  ) {
    console.log("ℹ️ 未配置任何输出目标，仅输出最终 IP 结果。");
  }

  return outputs;
}

async function runSync(config = loadRuntimeConfig(), deps = {}) {
  const loadPool = deps.parseIpPool || parseIpPool;
  const pickByLatency = deps.selectIpsByLatency || selectIpsByLatency;
  const pickBySpeed = deps.selectIpsBySpeed || selectIpsBySpeed;
  const notify = deps.sendNotification || sendNotification;
  const writeOutputs = deps.syncOutputs || syncOutputs;
  const syncDataPaths = deps.syncDataPaths || SYNC_DATA_PATHS;

  ensurePreferredOutputFile(syncDataPaths.preferredOutputFile);

  const poolIps = await loadPool(config.CF_IP_POOL);
  if (poolIps.length === 0) {
    throw new Error("IP 池为空，无法继续同步");
  }

  const selection =
    config.IP_UPDATE_MODE === "speed"
      ? await pickBySpeed(poolIps, config, deps)
      : await pickByLatency(poolIps, config, deps);
  const finalHealthyIps = selection.finalHealthyIps;

  if (finalHealthyIps.length === 0) {
    await notify("⚠️ CF IP 同步报警", "候选池中没有可用 IP。");
    return {
      poolIps,
      selection,
      finalHealthyIps,
      outputs: buildOutputStates(config),
    };
  }

  if (
    finalHealthyIps.length < config.MAX_IPS &&
    finalHealthyIps.length <= config.NOTIFY_THRESHOLD
  ) {
    await notify(
      "⚠️ CF IP 池告急",
      `当前仅剩 ${finalHealthyIps.length} 个可用 IP（目标: ${config.MAX_IPS}）。`,
    );
  }

  writePreferredOutputFile(finalHealthyIps, syncDataPaths.preferredOutputFile);
  const outputs = await writeOutputs(config, finalHealthyIps, deps);
  return { poolIps, selection, finalHealthyIps, outputs };
}

async function main() {
  const config = loadRuntimeConfig();
  console.log("\n🚀 开始执行 Cloudflare IP 同步...");
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`输出模式: ${config.IP_UPDATE_MODE}`);

  const result = await runSync(config);
  console.log(formatSelectionOutput(result.selection));
}

module.exports = {
  applyDnsChanges,
  getSyncDataPaths,
  buildS3PutObjectRequest,
  fetchCurrentDnsRecords,
  formatDnsOutputSummary,
  formatGistIpContent,
  formatGistOutputSummary,
  formatInputSourceSummary,
  formatLatencySelectionSummary,
  formatS3OutputSummary,
  formatSelectionOutput,
  formatSpeedSelectionSummary,
  getMissingCloudflareOutputConfig,
  getMissingGistOutputConfig,
  getMissingS3OutputConfig,
  getSpeedModeCandidateCount,
  getSpeedModeDurationSeconds,
  hasCloudflareOutput,
  hasGistOutput,
  hasS3Output,
  loadRuntimeConfig,
  normalizeIpUpdateMode,
  parseBooleanEnv,
  parseRuntimeConfig,
  readGistIdStateFile,
  runSync,
  selectIpsByLatency,
  selectIpsBySpeed,
  syncGistIpList,
  syncOutputs,
  syncS3IpList,
  writeGistIdStateFile,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ 脚本全局错误: ${err.message}`);
    sendNotification("❌ CF IP 同步脚本崩溃", err.message);
  });
}
