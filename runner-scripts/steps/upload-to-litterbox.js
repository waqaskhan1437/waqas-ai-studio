const { fs, path } = require('../lib/core');

const LITTERBOX_API = 'https://litterbox.catbox.moe/resources/internals/api.php';

module.exports = async function uploadToLitterbox(filePath, expiry = '72h') {
  const file = path.resolve(filePath);
  if (!fs.existsSync(file)) {
    console.log('[LITTERBOX] File not found, skipping:', file);
    return null;
  }

  const stat = fs.statSync(file);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`[LITTERBOX] Uploading ${path.basename(file)} (${sizeMB} MB) with ${expiry} expiry...`);

  if (stat.size > 1024 * 1024 * 1024) {
    console.log('[LITTERBOX] File exceeds 1GB limit, skipping');
    return null;
  }

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const fileData = fs.readFileSync(file);
  const fileName = path.basename(file);

  const encoder = new TextEncoder();
  const parts = [];

  const append = (str) => parts.push(encoder.encode(str));
  const appendBuf = (buf) => parts.push(buf);

  append(`--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`);
  append(`--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n${expiry}\r\n`);
  append(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  appendBuf(fileData);
  append(`\r\n--${boundary}--\r\n`);

  const totalLen = parts.reduce((a, b) => a + b.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { body.set(p, offset); offset += p.length; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(LITTERBOX_API, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: body,
        signal: AbortSignal.timeout(300000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const url = (await response.text()).trim();
      if (url.startsWith('https://')) {
        console.log(`[LITTERBOX] OK: ${url}`);
        return url;
      }
      throw new Error('Invalid response: ' + url);
    } catch (err) {
      console.warn(`[LITTERBOX] Attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt === 3) return null;
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }

  return null;
};
