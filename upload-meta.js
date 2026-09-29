const fs = require('fs');
const https = require('https');

let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token && fs.existsSync('.env')) {
  const m = fs.readFileSync('.env', 'utf8').match(/(?:GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.+)/);
  if (m) token = m[1].trim().replace(/^['"]|['"]$/g, '');
}

if (!token) {
  console.log("No se encontró token en variable de entorno. Usa la Opción A (arrastrar y soltar en la web).");
  process.exit(0);
}

const releaseId = 399462677; // v0.1.72

async function uploadFile(fileName) {
  const filePath = `C:/flashlab-build/release/${fileName}`;
  if (!fs.existsSync(filePath)) {
    console.error(`No existe ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath);
  console.log(`Subiendo ${fileName}...`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'uploads.github.com',
      path: `/repos/edwardgko/flashlab-releases/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'Node',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': content.length,
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✓ ${fileName} subido correctamente`);
          resolve();
        } else {
          console.error(`Error subiendo ${fileName}: ${res.statusCode}`, data);
          resolve();
        }
      });
    });
    req.on('error', reject);
    req.write(content);
    req.end();
  });
}

(async () => {
  await uploadFile('latest.yml');
  await uploadFile('FlashLab-Setup-0.1.72.exe.blockmap');
})();
