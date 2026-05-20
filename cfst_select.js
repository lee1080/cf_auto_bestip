// cron "0 23 * * 4" cfst_select.js, tag:CFST优选测速
function Env(name) { this.name = name; }
const $ = new Env('CFST优选测速');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const https = require('https');
const http = require('http');

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
  spawnWithCleanOutput,
} = require('./utils/shared');

function getSelectDataPaths(dataRootDir = resolveDataDir()) {
  const dataDir = path.join(dataRootDir, 'cfst_select');
  return {
    dataRootDir,
    dataDir,
    outputSpeedFile: path.join(dataDir, 'speed_results.txt'),
    outputIpFile: path.join(dataDir, 'valid_ips.txt'),
    outputPreferredIpFile: path.join(dataDir, 'preferred_ips.txt'),
    tempIpFile: path.join(dataDir, 'ips.txt'),
    resultCsvFile: path.join(dataDir, 'result.csv'),
  };
}

// ================================
// 本地目录约定
// ================================

const CONFIG_TXT_PATH = path.join(__dirname, 'config.txt');
const SELECT_DATA_PATHS = getSelectDataPaths();
const DATA_DIR = SELECT_DATA_PATHS.dataDir;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }

const OUTPUT_SPEED_FILE = SELECT_DATA_PATHS.outputSpeedFile;
const OUTPUT_IP_FILE = SELECT_DATA_PATHS.outputIpFile;
const OUTPUT_PREFERRED_IP_FILE = SELECT_DATA_PATHS.outputPreferredIpFile;
const TEMP_IP_FILE = SELECT_DATA_PATHS.tempIpFile;
const RESULT_CSV_FILE = SELECT_DATA_PATHS.resultCsvFile;

// 优先：青龙环境变量(天然优先) > 青龙 config -> 再用本目录 config.txt 补齐默认值
loadEnvFromQingLongConfigIfNeeded();
loadEnvFromConfigTxtIfNeeded(CONFIG_TXT_PATH);

// ================================
// CloudflareST 自动下载与执行
// ================================

const cfstCandidates = os.platform() === 'win32' ? ['CloudflareST.exe', 'cfst.exe'] : ['CloudflareST', 'cfst'];
let cfstExecutable = cfstCandidates[0];
let CFST_PATH = path.join(__dirname, cfstExecutable);

function getReleaseAssetPrefix(platform, arch) {
  if (platform === 'linux') {
    return `cfst_linux_${arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'amd64'}`;
  }
  if (platform === 'darwin') {
    return `cfst_darwin_${arch === 'arm64' ? 'arm64' : 'amd64'}`;
  }
  if (platform === 'win32') {
    return `cfst_windows_${arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : 'amd64'}`;
  }
  throw new Error(`不支持的操作系统: ${platform}`);
}

function normalizeLatencyTestConcurrency(rawValue) {
  if (typeof rawValue === 'number' && Number.isInteger(rawValue)) {
    return rawValue > 0 ? rawValue : 200;
  }

  const value = String(rawValue ?? '').trim();
  if (!/^-?\d+$/.test(value)) return 200;

  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : 200;
}

async function downloadCFST() {
  const platform = os.platform();
  const arch = os.arch();
  let fileName = '';
  let isZip = false;

  const rawProxy = (process.env.github_proxy || '').trim();
  const normalizedProxy = rawProxy ? (rawProxy.endsWith('/') ? rawProxy : `${rawProxy}/`) : '';

  async function fetchLatestReleaseAssetUrl(assetNamePrefix) {
    const apiUrl = 'https://api.github.com/repos/XIU2/CloudflareSpeedTest/releases/latest';
    const jsonText = await new Promise((resolve, reject) => {
      https.get(apiUrl, { headers: { 'User-Agent': 'cfst-local-script' } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const release = JSON.parse(jsonText);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const matched = assets.find(a => a && typeof a.name === 'string' && a.name.startsWith(assetNamePrefix));
    if (!matched || !matched.browser_download_url) {
      throw new Error(`未在 latest release 资产中找到 ${assetNamePrefix}*，请检查平台/架构或上游改名。`);
    }
    return { name: matched.name, url: matched.browser_download_url };
  }

  const assetPrefix = getReleaseAssetPrefix(platform, arch);
  const latest = await fetchLatestReleaseAssetUrl(assetPrefix);
  fileName = latest.name;
  isZip = fileName.endsWith('.zip');
  const destPath = path.join(__dirname, fileName);

  function isGzipFile(fp) {
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      return buf[0] === 0x1f && buf[1] === 0x8b;
    } catch (e) {
      return false;
    }
  }

  async function curlDownload(url) {
    console.log(`正在下载 CloudflareSpeedTest... (URL: ${url})`);
    await new Promise((resolve, reject) => {
      exec(
        `curl -L --fail --retry 2 --retry-delay 1 --connect-timeout 10 --max-time 180 -o "${destPath}" "${url}"`,
        (error) => {
        if (error) return reject(new Error(`下载失败: ${error.message}`));
        resolve();
      });
    });
  }

  function execWithTimeout(cmd, timeoutMs, errPrefix) {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: timeoutMs }, (error) => {
        if (error) return reject(new Error(`${errPrefix}: ${error.message}`));
        resolve();
      });
    });
  }

  const directUrl = latest.url;
  const primaryUrl = normalizedProxy ? `${normalizedProxy}${directUrl}` : directUrl;
  const fallbackUrl = directUrl;

  // 先按当前 baseUrl 下载，若文件类型不符合预期则自动回退到直连 GitHub 再试一次
  await curlDownload(primaryUrl);
  if (!isZip && !isGzipFile(destPath)) {
    console.warn('下载到的 tar.gz 文件格式异常，自动切换直连 GitHub 重试一次...');
    try { fs.unlinkSync(destPath); } catch (e) { }
    await curlDownload(fallbackUrl);
  }

  console.log('正在解压...');
  try {
    if (isZip) {
      // zip 优先用 unzip（macOS 上 tar -xf zip 可能会卡住）
      await execWithTimeout(`unzip -o "${destPath}" -d "${__dirname}"`, 120000, '解压 zip 失败');
    } else {
      if (!isGzipFile(destPath)) {
        throw new Error('tar.gz 文件格式异常（不是 gzip 压缩包），请检查 github_proxy 或网络劫持/重定向。');
      }
      await execWithTimeout(`tar -xzf "${destPath}" -C "${__dirname}"`, 120000, '解压 tar.gz 失败');
    }
  } finally {
    try { fs.unlinkSync(destPath); } catch (e) { }
  }

  console.log(`正在从 ${__dirname} 探测可执行文件 (${cfstCandidates.join(', ')})...`);
  const foundPath = findBinaryRecursive(__dirname, cfstCandidates);
  if (!foundPath) throw new Error(`解压成功但未找到 ${cfstCandidates.join(' 或 ')} 文件`);

  CFST_PATH = foundPath;
  cfstExecutable = path.basename(foundPath);
  console.log(`✅ 已成功定位二进制文件: ${CFST_PATH}`);
  if (platform !== 'win32') fs.chmodSync(CFST_PATH, 0o755);
}

// ================================
// 配置与辅助逻辑
// ================================

function parseConfigSh(data) {
  const config = {};
  const lines = data.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('export ')) {
      const match = line.match(/export\s+(\w+)="([^"]+)"/);
      if (match) {
        const key = match[1];
        const value = match[2];
        if (!process.env[key]) process.env[key] = value;
        config[key.toLowerCase()] = value;
      } else {
        const matchInt = line.match(/export\s+(\w+)=([0-9]+)/);
        if (matchInt) {
          if (!process.env[matchInt[1]]) process.env[matchInt[1]] = matchInt[2];
          config[matchInt[1].toLowerCase()] = matchInt[2];
        }
      }
    }
  }
  return config;
}

function loadConfig() {
  const config = {};
  const envConfig = {
    ip_source_url: process.env.IP_SOURCE_URL,
    cfst_select_latency_threshold: process.env.CFST_SELECT_LATENCY_THRESHOLD ? parseInt(process.env.CFST_SELECT_LATENCY_THRESHOLD) : undefined,
    cfst_select_speed_test_duration_s: process.env.CFST_SELECT_SPEED_TEST_DURATION_S ? parseInt(process.env.CFST_SELECT_SPEED_TEST_DURATION_S) : undefined,
    cfst_select_download_speed_threshold_mbps: process.env.CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS ? parseFloat(process.env.CFST_SELECT_DOWNLOAD_SPEED_THRESHOLD_MBPS) : undefined,
    preferred_ip_count: process.env.PREFERRED_IP_COUNT ? parseInt(process.env.PREFERRED_IP_COUNT) : undefined,
    cfst_select_test_count: process.env.CFST_SELECT_TEST_COUNT ? parseInt(process.env.CFST_SELECT_TEST_COUNT) : undefined,
    cfst_select_latency_test_concurrency: process.env.CFST_SELECT_LATENCY_TEST_CONCURRENCY ? parseInt(process.env.CFST_SELECT_LATENCY_TEST_CONCURRENCY) : undefined,
    ip_random_source_url: process.env.IP_RANDOM_SOURCE_URL,
    ip_random_sample_count: process.env.IP_RANDOM_SAMPLE_COUNT ? parseInt(process.env.IP_RANDOM_SAMPLE_COUNT) : undefined,
    cfst_select_speed_test_url: process.env.CFST_SELECT_SPEED_TEST_URL
  };

  // 兼容青龙 config.sh / config.json（保持原脚本能力）
  const qinglongCandidates = [
    '/ql/data/config/config.json',
    '/ql/config/config.json',
    '/ql/data/config/config.sh'
  ];
  let qlConfig = {};
  for (const pathStr of qinglongCandidates) {
    if (fs.existsSync(pathStr)) {
      try {
        const qlConfigData = fs.readFileSync(pathStr, 'utf8');
        if (pathStr.endsWith('.json')) qlConfig = JSON.parse(qlConfigData);
        else if (pathStr.endsWith('.sh')) qlConfig = parseConfigSh(qlConfigData);
        console.log(`已加载配置文件: ${pathStr}`);
        break;
      } catch (e) {
        console.warn(`无法加载配置 ${pathStr}: ${e.message}`);
      }
    }
  }

  const mergeConfig = (key, envValue, qlValue, defaultValue) => {
    if (envValue !== undefined && envValue !== null && envValue !== '') {
      config[key] = envValue;
    } else if (qlValue !== undefined && qlValue !== null && qlValue !== '') {
      config[key] = qlValue;
    } else {
      config[key] = defaultValue;
    }
  };

  mergeConfig('ip_source_url', envConfig.ip_source_url, qlConfig.ip_source_url, null);
  mergeConfig('cfst_select_latency_threshold', envConfig.cfst_select_latency_threshold, qlConfig.cfst_select_latency_threshold, 500);
  mergeConfig('cfst_select_speed_test_duration_s', envConfig.cfst_select_speed_test_duration_s, qlConfig.cfst_select_speed_test_duration_s, 10);
  mergeConfig('cfst_select_download_speed_threshold_mbps', envConfig.cfst_select_download_speed_threshold_mbps, qlConfig.cfst_select_download_speed_threshold_mbps, 10);
  mergeConfig('cfst_select_test_count', envConfig.cfst_select_test_count, qlConfig.cfst_select_test_count, 30);
  mergeConfig('preferred_ip_count', envConfig.preferred_ip_count, qlConfig.preferred_ip_count, 10);
  mergeConfig('cfst_select_latency_test_concurrency', envConfig.cfst_select_latency_test_concurrency, qlConfig.cfst_select_latency_test_concurrency, 200);
  mergeConfig('ip_random_source_url', envConfig.ip_random_source_url, qlConfig.ip_random_source_url, null);
  mergeConfig('ip_random_sample_count', envConfig.ip_random_sample_count, qlConfig.ip_random_sample_count, 300);
  mergeConfig('cfst_select_speed_test_url', envConfig.cfst_select_speed_test_url, qlConfig.cfst_select_speed_test_url, null);

  if (!config.ip_source_url && !config.ip_random_source_url) {
    console.error('错误: 请至少配置 IP_SOURCE_URL 或 IP_RANDOM_SOURCE_URL');
    return null;
  }
  return config;
}

function displayConfig(config) {
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`速度测试 URL: ${config.cfst_select_speed_test_url ? config.cfst_select_speed_test_url : '[使用 CloudflareST 默认地址]'}`);
  console.log(`下载速度阈值: ${config.cfst_select_download_speed_threshold_mbps} MB/s`);
  console.log(`延迟测试阈值: ${config.cfst_select_latency_threshold} ms`);
  console.log(`测速时长: ${config.cfst_select_speed_test_duration_s} s`);
  console.log(`CFST 测速测试数量: ${config.cfst_select_test_count}`);
  console.log(`最终保存优选IP数量: ${config.preferred_ip_count}`);
}

async function loadIpsFromUrl(urlString) {
  try {
    if (!urlString) return [];
    const sources = urlString.split(',').map(u => u.trim()).filter(Boolean);
    const allIps = new Set();

    const parseIpsFromText = (text) => expandCidrs(
      extractValidIpv4Candidates(text).map(candidate => candidate.includes(':') ? candidate.split(':')[0] : candidate)
    );

    for (const source of sources) {
      try {
        let foundIps = [];
        if (source.startsWith('http://') || source.startsWith('https://')) {
          const client = source.startsWith('https') ? https : http;
          const data = await new Promise((resolve, reject) => {
            client.get(source, (response) => {
              if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`StatusCode: ${response.statusCode}`));
              let responseData = '';
              response.on('data', chunk => responseData += chunk);
              response.on('end', () => resolve(responseData));
            }).on('error', reject);
          });
          foundIps = parseIpsFromText(data);
        } else {
          const asPath = path.isAbsolute(source) ? source : path.resolve(__dirname, source);
          if (fs.existsSync(asPath)) {
            const data = fs.readFileSync(asPath, 'utf8');
            foundIps = parseIpsFromText(data);
          } else {
            // 兼容直接写单个 IP（可带端口）
            foundIps = parseIpsFromText(source);
            if (foundIps.length === 0) {
              console.warn(`来源不存在且不是有效 IP，已跳过: ${source}`);
            }
          }
        }
        foundIps.forEach(ip => allIps.add(ip));
      } catch (e) {
        console.warn(`获取 ${source} IP 时警告: ${e.message}`);
      }
    }
    return Array.from(allIps);
  } catch (e) {
    return [];
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function parseCsvResults(csvPath) {
  const data = fs.readFileSync(csvPath, 'utf8');
  const lines = data.split('\n').filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 6) {
      const ip = cols[0];
      const speed = parseFloat(cols[5]);
      if (!isNaN(speed) && ip) results.push({ ip, speed });
    }
  }
  return results;
}

async function saveResults(finalResults, preferredIpCount) {
  const speedFileContent = finalResults.map(r => `${r.ip}, ${r.speed.toFixed(2)} MB/s`).join('\n');
  fs.writeFileSync(OUTPUT_SPEED_FILE, speedFileContent);

  const ipFileContent = finalResults.map(r => r.ip).join('\n');
  fs.writeFileSync(OUTPUT_IP_FILE, ipFileContent);

  const preferredIps = finalResults.slice(0, preferredIpCount).map(r => r.ip).join('\n');
  fs.writeFileSync(OUTPUT_PREFERRED_IP_FILE, preferredIps);

  console.log(`结果文件已保存（本地存储，不再上传远程服务）：`);
  console.log(`- ${OUTPUT_SPEED_FILE}`);
  console.log(`- ${OUTPUT_IP_FILE}`);
  console.log(`- ${OUTPUT_PREFERRED_IP_FILE}`);
}

// ================================
// 主流程
// ================================

async function main() {
  console.log('=== CloudflareSpeedTest 测速脚本开始运行（本地存储版） ===');

  const existingPath = findBinaryRecursive(__dirname, cfstCandidates);
  if (existingPath) {
    CFST_PATH = existingPath;
    cfstExecutable = path.basename(existingPath);
    console.log(`✅ 检测到已安装 CloudflareSpeedTest: ${CFST_PATH}`);
  } else {
    console.log(`未找到 ${cfstCandidates.join(' 或 ')}，准备自动下载...`);
    try {
      await downloadCFST();
    } catch (error) {
      console.error(`自动下载 CloudflareST 失败: ${error.message}`);
      await sendNotification('CFST 测速失败', `自动下载 CloudflareST 失败: ${error.message}`);
      return;
    }
  }

  console.log('正在加载配置...');
  const config = loadConfig();
  if (!config) return;
  displayConfig(config);

  console.log('开始获取 IP 列表...');
  let ipsFull = await loadIpsFromUrl(config.ip_source_url);
  let ipsToSample = config.ip_random_source_url ? await loadIpsFromUrl(config.ip_random_source_url) : [];

  if (ipsToSample && ipsToSample.length > 0) {
    const sampleCount = config.ip_random_sample_count || 300;
    console.log(`正在从采样源中随机挑选 ${sampleCount} 个 IP...`);
    shuffleArray(ipsToSample);
    ipsToSample = ipsToSample.slice(0, sampleCount);
  }

  const ips = Array.from(new Set([...(ipsFull || []), ...(ipsToSample || [])]));
  if (ips.length === 0) {
    console.error('错误：未能从任何 URL 获取到 IP 地址，请检查网络或配置。');
    await sendNotification('CFST 测速失败', '未能获取到任何 IP 地址。');
    return;
  }
  console.log(`成功加载并去重，共计 ${ips.length} 个待测试 IP 地址。`);

  const cleanIps = ips.map(ip => ip.split(':')[0]).filter(Boolean);
  const uniqueCleanIps = Array.from(new Set(cleanIps));
  fs.writeFileSync(TEMP_IP_FILE, uniqueCleanIps.join('\n'));
  console.log(`已将 ${uniqueCleanIps.length} 个 IP 写入测试文件 ${TEMP_IP_FILE}`);

  if (fs.existsSync(RESULT_CSV_FILE)) {
    try { fs.unlinkSync(RESULT_CSV_FILE); } catch (e) { }
  }

  const cfstArgs = [
    '-f', TEMP_IP_FILE,
    '-tl', config.cfst_select_latency_threshold,
    '-sl', config.cfst_select_download_speed_threshold_mbps,
    '-dn', config.cfst_select_test_count || Math.max(config.preferred_ip_count, 10),
    '-dt', config.cfst_select_speed_test_duration_s
  ];

  if (config.cfst_select_speed_test_url) cfstArgs.push('-url', config.cfst_select_speed_test_url);
  cfstArgs.push('-n', normalizeLatencyTestConcurrency(config.cfst_select_latency_test_concurrency));

  console.log(`\n============== 开始执行 CloudflareSpeedTest ==============`);
  console.log(`CMD: ${cfstExecutable} ${cfstArgs.join(' ')}\n`);

  console.log('正在运行 CloudflareST，请稍候...');
  try {
    const exitCode = await spawnWithCleanOutput(CFST_PATH, cfstArgs, { cwd: DATA_DIR });
    console.log(`\nCloudflareST 执行完毕，退出码: ${exitCode}`);
  } catch (err) {
    console.error(`执行 CloudflareST 时出错: ${err.message}`);
    await sendNotification('CFST 测速异常', `执行 CloudflareST 失败: ${err.message}`);
    return;
  }

  if (!fs.existsSync(RESULT_CSV_FILE)) {
    console.error('未找到 result.csv，可能是没有节点达标或执行异常。');
    await sendNotification('CFST 测速失败', '未找到 result.csv，没有符合要求（延迟/速度）的 IP。');
    return;
  }

  console.log('开始解析 CSV 结果...');
  const results = parseCsvResults(RESULT_CSV_FILE);
  if (results.length === 0) {
    console.log('从 CSV 中未能提取到任何通过阈值的节点。');
    await sendNotification('CFST 优选失败', 'CSV 中没有节点通过速度测试阈值。');
    return;
  }

  await saveResults(results, config.preferred_ip_count);

  let preferredIpsContent = '';
  try {
    if (fs.existsSync(OUTPUT_PREFERRED_IP_FILE)) preferredIpsContent = fs.readFileSync(OUTPUT_PREFERRED_IP_FILE, 'utf8');
  } catch (e) {
    console.warn(`读取优选 IP 文件失败: ${e.message}`);
  }

  await sendNotification(
    'CFST 优选成功',
    `脚本执行完成，已优选 ${results.length} 个 IP。\n\n本地文件：${OUTPUT_PREFERRED_IP_FILE}\n\n部分优选 IP:\n${preferredIpsContent.substring(0, 500)}...`
  );

  console.log('=== 脚本成功运行结束 ===');
}

module.exports = {
  getReleaseAssetPrefix,
  getSelectDataPaths,
  loadConfig,
  main,
  normalizeLatencyTestConcurrency,
  parseCsvResults,
  saveResults,
};

if (require.main === module) {
  main().catch(async error => {
    console.error(`脚本全局错误: ${error.stack}`);
    await sendNotification('CFST 脚本崩溃', error.message);
  });
}

