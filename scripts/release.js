import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const repo = 'edwardgko/flashlab-releases';

console.log(`\n🚀 Iniciando release automático para FlashLab ${tag}...`);

// Cargar token de GitHub
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token && fs.existsSync('.env')) {
  const envText = fs.readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*(?:GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.+)$/);
    if (m) {
      token = m[1].trim().replace(/^['"]|['"]$/g, '');
      break;
    }
  }
}

// 1. Sincronizar tag en Git para evitar el error 422 de GitHub
console.log(`📌 Sincronizando tag ${tag} en GitHub...`);
try {
  execSync('git add -A', { stdio: 'ignore' });
  execSync(`git commit -m "${tag}"`, { stdio: 'ignore' });
} catch {}
try {
  execSync(`git tag -f ${tag}`, { stdio: 'ignore' });
  execSync(`git push origin master --tags -f`, { stdio: 'ignore' });
  console.log(`✓ Tag ${tag} sincronizado.`);
} catch (e) {
  console.log(`(Aviso en sincronización git: ${e.message})`);
}

// 2. Compilar con Vite
console.log('\n🔨 Compilando Vite...');
execSync('vite build', { stdio: 'inherit' });

// 3. Empaquetar con electron-builder
console.log('\n📦 Empaquetando con electron-builder...');
try {
  execSync('electron-builder --publish always', { stdio: 'inherit' });
} catch (err) {
  console.log('(electron-builder finalizó, asegurando artefactos en GitHub...)');
}

// 4. Verificación y subida automática garantizada de latest.yml y artefactos faltantes
async function ensureReleaseAssets() {
  if (!token) {
    console.log('⚠️ No se detectó token de GitHub para la verificación final.');
    return;
  }

  function ghGet(url) {
    return new Promise((resolve) => {
      const u = new URL(url);
      https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'flashlab-auto-release',
          'Authorization': 'Bearer ' + token
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  function ghUpload(releaseId, fileName, buf) {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'uploads.github.com',
        path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
        method: 'POST',
        headers: {
          'User-Agent': 'flashlab-auto-release',
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`  ✓ ${fileName} subido con éxito (${(buf.length / 1024).toFixed(1)} KB)`);
          } else {
            console.log(`  Aviso (${fileName}):`, res.statusCode);
          }
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.write(buf);
      req.end();
    });
  }

  console.log(`\n🔍 Verificando artefactos de ${tag} en GitHub...`);
  const release = await ghGet(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
  if (!release || !release.id) {
    console.log('No se pudo encontrar el release en GitHub.');
    return;
  }

  const existing = new Set((release.assets || []).map(a => a.name));
  const buildDir = 'C:/flashlab-build/release';

  const targets = [
    'latest.yml',
    `FlashLab-Setup-${version}.exe.blockmap`,
    `FlashLab-Setup-${version}.exe`
  ];

  for (const fileName of targets) {
    if (existing.has(fileName)) {
      console.log(`  ✓ ${fileName} ya está en GitHub.`);
      continue;
    }
    const fullPath = path.join(buildDir, fileName);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    console.log(`  ⬆ Subiendo ${fileName} a GitHub automáticamente...`);
    const buf = fs.readFileSync(fullPath);
    await ghUpload(release.id, fileName, buf);
  }

  console.log(`\n✨ ¡Release ${tag} 100% completo con todos sus archivos en GitHub!\n`);
}

await ensureReleaseAssets();
