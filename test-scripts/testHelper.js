const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

function httpGet(targetUrl) {
  return new Promise((resolve) => {
    const parsed = new URL(targetUrl);
    const start = Date.now();
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        agent: false
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = raw;
          try {
            data = JSON.parse(raw);
          } catch (e) {}
          resolve({
            statusCode: res.statusCode,
            data,
            duration: Date.now() - start
          });
        });
      }
    );
    req.on('error', (err) => {
      resolve({
        statusCode: 0,
        error: err,
        duration: Date.now() - start
      });
    });
  });
}

function httpPost(targetUrl, body = {}, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(targetUrl);
    const postData = JSON.stringify(body);
    const start = Date.now();

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          data,
          duration: Date.now() - start
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 0,
        error: err,
        duration: Date.now() - start
      });
    });

    req.write(postData);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let activeProcesses = [];

function spawnService(scriptPath, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  const child = spawn('node', [scriptPath], {
    env: mergedEnv,
    stdio: 'pipe'
  });

  activeProcesses.push(child);
  return child;
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  return new Promise((resolve) => {
    child.on('close', () => resolve());
    child.kill('SIGKILL');
    setTimeout(() => {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (e) {}
      resolve();
    }, 500);
  });
}

async function stopAllProcesses() {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch (e) {}
  }
  activeProcesses = [];
  await sleep(300);
}

async function waitForServiceReady(url, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await httpGet(url);
    if (res.statusCode > 0) return true;
    await sleep(100);
  }
  return false;
}

module.exports = {
  httpGet,
  httpPost,
  sleep,
  spawnService,
  stopProcess,
  stopAllProcesses,
  waitForServiceReady
};
