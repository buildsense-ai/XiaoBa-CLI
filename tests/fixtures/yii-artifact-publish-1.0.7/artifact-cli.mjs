// Thin CLI over the platform's application endpoints. It resolves the bot
// credential itself, so callers never pass a key and never choose one.
//
//   node artifact-cli.mjs list
//   node artifact-cli.mjs publish <应用id> <显示名> <本地端口> [uploadLimitMb]
//   node artifact-cli.mjs delete <应用id>
//   node artifact-cli.mjs whoami
//
// `publish` reads the public key from the connector's own directory (it is derived
// from the key pair `init-connector.mjs` created), so the key never has to be copied
// by hand — a mistyped or empty key is rejected by the gateway as an invalid
// registration, which is a confusing way to learn about a copy-paste mistake.
import fs from 'node:fs';
import path from 'node:path';
import { resolveBotCredential, authHeader } from './credential.mjs';

const [command, ...args] = process.argv.slice(2);

function usage() {
  console.error(`用法:
  artifact-cli.mjs whoami                        确认凭据属于哪个 bot
  artifact-cli.mjs list                          列出本 bot 已发布的应用
  artifact-cli.mjs publish ID TITLE PORT [UPLOAD_MB]
  artifact-cli.mjs delete ID`);
  process.exit(2);
}

// The public key lives next to the connector config, written by init-connector.mjs.
function readPublicKey(stateDir, appId) {
  const candidates = [
    path.join(stateDir, 'id_ed25519.pub'),
    path.join(stateDir, `${appId}.pub`),
  ];
  for (const file of candidates) {
    try {
      const key = fs.readFileSync(file, 'utf8').trim();
      if (/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(key)) return key;
    } catch { /* try the next candidate */ }
  }
  return null;
}

const credential = resolveBotCredential();
const base = credential.baseUrl.replace(/\/+$/, '');

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...authHeader(credential), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: keep the raw text */ }
  return { status: response.status, body: parsed, text };
}

if (command === 'whoami') {
  console.log(JSON.stringify({
    botUid: credential.botUid,
    botName: credential.botName,
    baseUrl: credential.baseUrl,
    credentialSource: credential.source,
  }, null, 2));
  process.exit(0);
}

if (command === 'list') {
  const { status, body, text } = await call('GET', '/api/artifacts/apps');
  if (status !== 200) {
    console.error(`列出失败 HTTP ${status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const apps = Array.isArray(body?.apps) ? body.apps : [];
  console.log(`共 ${apps.length} 个应用（归属 bot ${credential.botUid}）`);
  for (const app of apps) {
    console.log(`  ${app.id}  remote_port=${app.remote_port}  ${app.title || ''}`);
  }
  process.exit(0);
}

if (command === 'publish') {
  const [id, title, portArg, uploadArg] = args;
  if (!id || !title || !portArg) usage();
  const localPort = Number(portArg);
  if (!Number.isInteger(localPort)) { console.error('本地端口必须是整数'); process.exit(2); }
  const stateDir = process.env.ARTIFACT_STATE_DIR || `/opt/xiaoba-cloud-bot/state/artifacts/${id}`;
  const publicKey = readPublicKey(stateDir, id);
  if (!publicKey) {
    console.error(
      `找不到公钥。先用 init-connector.mjs 生成密钥（传 auto），它会在 ${stateDir}/id_ed25519.pub 写出公钥。`,
    );
    process.exit(2);
  }
  const payload = { id, title, publicKey, localPort };
  if (uploadArg) payload.uploadLimitMb = Number(uploadArg);
  const { status, body, text } = await call('POST', '/api/artifacts/apps', payload);
  if (status !== 201 && status !== 200) {
    console.error(`发布失败 HTTP ${status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  const remotePort = body?.remote_port;
  console.log(JSON.stringify(body, null, 2));
  if (remotePort) console.error(`远端端口 = ${remotePort}（下一步 init-connector 要用它写出连接器配置）`);
  process.exit(0);
}

if (command === 'delete') {
  const [id] = args;
  if (!id) usage();
  const { status, body, text } = await call('DELETE', `/api/artifacts/apps/${encodeURIComponent(id)}`);
  if (status !== 200 && status !== 204) {
    console.error(`下架失败 HTTP ${status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(body ? JSON.stringify(body) : `已下架 ${id}`);
  process.exit(0);
}

usage();
