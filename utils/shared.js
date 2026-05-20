/**
 * Shared utilities for cfst_select.js and ip_sync.js
 */

const fs = require('fs');
const path = require('path');

// --- Directory & config loading ---

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveDataDir() {
  const envDir = process.env.LOCAL_DATA_DIR;
  const resolved = envDir
    ? path.isAbsolute(envDir) ? envDir : path.resolve(PROJECT_ROOT, envDir)
    : path.join(PROJECT_ROOT, 'data');
  try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { }
  return resolved;
}

function loadEnvFromConfigTxtIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice('export '.length).trim();
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseConfigShToEnv(data) {
  const lines = data.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('export ')) continue;

    let m = trimmed.match(/^export\s+(\w+)="([^"]*)"$/);
    if (m) {
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
      continue;
    }

    m = trimmed.match(/^export\s+(\w+)='([^']*)'$/);
    if (m) {
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
      continue;
    }

    m = trimmed.match(/^export\s+(\w+)=(.+)$/);
    if (m) {
      const key = m[1];
      const raw = (m[2] || '').trim();
      if (!process.env[key]) process.env[key] = raw;
    }
  }
}

function loadEnvFromQingLongConfigIfNeeded() {
  const candidates = [
    '/ql/data/config/config.json',
    '/ql/config/config.json',
    '/ql/data/config/config.sh'
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      if (fp.endsWith('.json')) {
        const json = JSON.parse(raw);
        if (json && typeof json === 'object') {
          for (const [k, v] of Object.entries(json)) {
            if (v === undefined || v === null) continue;
            const str = String(v);
            if (!process.env[k]) process.env[k] = str;
          }
        }
      } else {
        parseConfigShToEnv(raw);
      }
      console.log(`已加载青龙配置文件: ${fp}`);
      return;
    } catch (e) {
      console.warn(`无法加载青龙配置 ${fp}: ${e.message}`);
    }
  }
}

// --- File system helpers ---

function findBinaryRecursive(dir, targetNames) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findBinaryRecursive(fullPath, targetNames);
      if (found) return found;
    } else if (targetNames.includes(file)) {
      return fullPath;
    }
  }
  return null;
}

function findFileUpwards(filename, startDir) {
  let currentDir = startDir || __dirname;
  const root = path.parse(currentDir).root;
  while (currentDir !== root) {
    const fp = path.join(currentDir, filename);
    if (fs.existsSync(fp)) return fp;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return null;
}

// --- Notification ---

async function sendNotification(title, content) {
  console.log(`\n准备发送通知 [${title}]...`);
  try {
    const sendNotifyPath = findFileUpwards('sendNotify.js');
    if (sendNotifyPath) {
      const notify = require(sendNotifyPath);
      if (notify && typeof notify.sendNotify === 'function') {
        await notify.sendNotify(title, content);
        console.log('Node.js sendNotify.js 方式通知发送完毕。');
      }
    }
  } catch (e) {
    console.warn(`通知模块调用失败: ${e.message}`);
  }
}

// --- CIDR expansion ---

function cidrToIps(cidr) {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return [cidr];
  const parts = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
  const mask = parseInt(m[5]);
  if (parts.some(p => p > 255) || mask < 0 || mask > 32) return [cidr];
  const hostBits = 32 - mask;
  const count = 1 << hostBits;
  if (count > 2000000) {
    console.warn(`CIDR ${cidr} 包含 ${count} 个 IP (>200万)，已跳过`);
    return [];
  }
  if (count > 1000000) {
    console.warn(`CIDR ${cidr} 包含 ${count} 个 IP，展开可能消耗较多内存`);
  }
  const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const base = ((ipInt >>> hostBits) << hostBits) >>> 0;
  const ips = [];
  for (let i = 0; i < count; i++) {
    const a = base + i;
    ips.push(`${(a >>> 24) & 0xFF}.${(a >>> 16) & 0xFF}.${(a >>> 8) & 0xFF}.${a & 0xFF}`);
  }
  return ips;
}

function expandCidrs(ipList) {
  return ipList.flatMap(ip => cidrToIps(ip));
}

function isValidIpv4(ip) {
  const parts = String(ip).split('.');
  return parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function normalizeIpv4Candidate(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(value)) {
    const [ip, mask] = value.split('/');
    return isValidIpv4(ip) && Number(mask) >= 0 && Number(mask) <= 32 ? value : '';
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    const [ip] = value.split(':');
    return isValidIpv4(ip) ? value : '';
  }

  return isValidIpv4(value) ? value : '';
}

function extractValidIpv4Candidates(text) {
  const matches = String(text || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?::\d+)?\b/g) || [];
  return matches.map(candidate => normalizeIpv4Candidate(candidate)).filter(Boolean);
}

// --- cfst output cleaning (QingLong compatibility) ---

/**
 * Spawn a process whose stdout uses \r for in-place progress bars
 * (like CloudflareST). Filters out progress bar frames and only
 * emits clean, readable lines suitable for QingLong or other
 * non-TTY log viewers.
 */
function spawnWithCleanOutput(command, args, options = {}) {
  const { spawn: spawnImpl } = require('child_process');
  const child = spawnImpl(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lineBuffer = '';
  let lastEmitted = '';

  const emit = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Skip progress bar lines (brackets with progress indicators)
    if (/\[[↗↘↙↖↕↔_\-= ]+\]/.test(trimmed)) return;
    // Skip standalone fraction lines like "0 / 5000"
    if (/^\d+\s*\/\s*\d+\s*$/.test(trimmed)) return;
    if (trimmed === lastEmitted) return;
    lastEmitted = trimmed;
    process.stdout.write(trimmed + '\n');
  };

  const onData = (data) => {
    const text = data.toString();
    for (const ch of text) {
      if (ch === '\n') { emit(lineBuffer); lineBuffer = ''; }
      else if (ch === '\r') { lineBuffer = ''; }
      else { lineBuffer += ch; }
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (lineBuffer.trim()) emit(lineBuffer);
      resolve(code);
    });
    child.on('error', reject);
  });
}

module.exports = {
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
  isValidIpv4,
  normalizeIpv4Candidate,
  spawnWithCleanOutput,
};
