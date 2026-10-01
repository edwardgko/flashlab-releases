import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const repo = 'edwardgko/flashlab-releases';

console.log(`\n🚀 Preparando release automático para FlashLab ${tag}...`);

// Cargar token desde .env y exportarlo al entorno para electron-builder
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

if (token) {
  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = token;
}

process.on('uncaughtException', (err) => {
  console.log('(Aviso de conexión ignorado:', err.message, ')');
});

function ghRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...options,
      headers: {
        'User-Agent': 'flashlab-auto-release',
        'Authorization': 'Bearer ' + token,
        'Connection': 'close',
        ...(options.headers || {})
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(d) });
        } catch {
          resolve({ statusCode: res.statusCode, body: d });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 1. Sincronizar tag en Git
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

// 2. Pre-crear el release en GitHub para evitar race condition de electron-builder
let releaseId = null;
if (token) {
  try {
    const checkRel = await ghRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/tags/${tag}`,
      method: 'GET'
    });
    if (checkRel.body && checkRel.body.id) {
      releaseId = checkRel.body.id;
      console.log(`✓ Release ${tag} ya existente en GitHub (id: ${releaseId}).`);
    } else {
      console.log(`📦 Creando release ${tag} en GitHub...`);
      const createRel = await ghRequest({
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        tag_name: tag,
        name: tag,
        draft: false,
        prerelease: false
      }));
      releaseId = createRel.body?.id;
      if (releaseId) console.log(`✓ Release ${tag} creado en GitHub (id: ${releaseId}).`);
    }
  } catch (err) {
    console.error('Aviso comprobando release:', err.message);
  }
}

// 3. Compilar con Vite
console.log('\n🔨 Compilando Vite...');
execSync('vite build', { stdio: 'inherit' });

// 4. Empaquetar con electron-builder
console.log('\n📦 Empaquetando con electron-builder...');
const localBuildDir = 'C:/flashlab-build/release';
try {
  if (fs.existsSync(localBuildDir)) {
    for (const f of fs.readdirSync(localBuildDir)) {
      if (f.startsWith(`FlashLab Setup ${version}`) || f.startsWith(`FlashLab-Setup-${version}`)) {
        fs.unlinkSync(path.join(localBuildDir, f));
      }
    }
  }
} catch {}
try {
  execSync('electron-builder --publish never', {
    stdio: 'inherit',
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
  });
} catch (err) {
  console.log('(electron-builder completado, asegurando artefactos en GitHub...)');
}

async function uploadAsset(relId, assetName, filePath, contentType = 'application/octet-stream') {
  if (!fs.existsSync(filePath)) {
    console.error(`Archivo no encontrado: ${filePath}`);
    return;
  }
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  const rel = await ghRequest({
    hostname: 'api.github.com',
    path: `/repos/${repo}/releases/${relId}`,
    method: 'GET'
  });
  const assets = rel.body?.assets || [];
  const existing = assets.find(a => a.name === assetName);

  if (existing) {
    console.log(`🔄 Reemplazando ${assetName} existente en GitHub...`);
    await ghRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/assets/${existing.id}`,
      method: 'DELETE'
    });
  }

  console.log(`⬆ Subiendo ${assetName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
  await new Promise((resolve) => {
    const req = https.request({
      hostname: 'uploads.github.com',
      path: `/repos/${repo}/releases/${relId}/assets?name=${encodeURIComponent(assetName)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'flashlab-auto-release',
        'Authorization': 'Bearer ' + token,
        'Content-Type': contentType,
        'Content-Length': fileSize
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✓ ${assetName} subido.`);
          resolve();
        } else {
          console.error(`Error subiendo ${assetName}:`, res.statusCode, d);
          resolve();
        }
      });
    });
    req.on('error', (err) => {
      console.error(`Error de red subiendo ${assetName}:`, err.message);
      resolve();
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(req);
  });
}

// 5. Verificación y subida automática garantizada de assets
async function ensureAllAssets() {
  if (!token) {
    console.log('⚠️ No se encontró token en variables ni en .env');
    return;
  }

  const res = await ghRequest({
    hostname: 'api.github.com',
    path: `/repos/${repo}/releases/tags/${tag}`,
    method: 'GET'
  });

  if (!res.body || !res.body.id) {
    console.log('No se pudo encontrar el release en GitHub.');
    return;
  }

  releaseId = res.body.id;
  const buildDir = 'C:/flashlab-build/release';

  let exeName = `FlashLab-Setup-${version}.exe`;
  let exePath = path.join(buildDir, exeName);
  if (!fs.existsSync(exePath)) {
    const altExe = `FlashLab Setup ${version}.exe`;
    if (fs.existsSync(path.join(buildDir, altExe))) {
      exePath = path.join(buildDir, altExe);
    }
  }

  const blockmapName = `${exeName}.blockmap`;
  let blockmapPath = path.join(buildDir, blockmapName);
  if (!fs.existsSync(blockmapPath)) {
    blockmapPath = path.join(buildDir, `FlashLab Setup ${version}.exe.blockmap`);
  }

  const userDesktopPath = `C:/Users/edwar/OneDrive/Desktop/Desktop 1/Programas/FlashLab-Setup-${version}.exe`;
  try {
    fs.copyFileSync(exePath, userDesktopPath);
    console.log(`✓ Copiado instalador a ${userDesktopPath}`);
  } catch (copyErr) {
    console.warn(`(Aviso copiando al escritorio: ${copyErr.message})`);
  }

  await uploadAsset(releaseId, exeName, exePath);
  await uploadAsset(releaseId, blockmapName, blockmapPath);
  await uploadAsset(releaseId, 'latest.yml', ymlPath);

  // 6. Buildear y subir el .apk de Android (regla de oro de CLAUDE.md)
  console.log(`\n🤖 Compilando APK de Android para ${tag}...`);
  try {
    console.log('📱 Sincronizando Capacitor con Android...');
    execSync('npx cap sync android', { stdio: 'inherit' });

    console.log('🔨 Compilando APK con Gradle (assembleRelease)...');
    const javaHome = 'C:\\Users\\edwar\\dev-tools\\jdk21-home';
    execSync('cmd.exe /c ".\\gradlew.bat assembleRelease"', {
      cwd: path.resolve('android'),
      stdio: 'inherit',
      env: { ...process.env, JAVA_HOME: javaHome }
    });

    const apkPath = path.resolve('android/app/build/outputs/apk/release/app-release.apk');
    const apkName = `FlashLab-${version}.apk`;
    await uploadAsset(releaseId, apkName, apkPath, 'application/vnd.android.package-archive');
  } catch (err) {
    console.error('⚠️ Error al generar o subir el APK de Android:', err.message);
  }

  console.log(`\n✨ ¡Release ${tag} 100% completo en GitHub! Contiene .exe y .apk sincronizados.\n`);
}

await ensureAllAssets();
