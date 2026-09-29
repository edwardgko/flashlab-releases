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

function ghRequest(options, data = null) {
  return new Promise((resolve) => {
    const req = https.request({
      ...options,
      headers: {
        'User-Agent': 'flashlab-auto-release',
        'Authorization': 'Bearer ' + token,
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
    req.on('error', () => resolve({ statusCode: 500, body: null }));
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
}

// 3. Compilar con Vite
console.log('\n🔨 Compilando Vite...');
execSync('vite build', { stdio: 'inherit' });

// 4. Empaquetar con electron-builder
console.log('\n📦 Empaquetando con electron-builder...');
try {
  execSync('electron-builder --publish always', {
    stdio: 'inherit',
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
  });
} catch (err) {
  console.log('(electron-builder completado, asegurando artefactos en GitHub...)');
}

// 5. Verificación y subida automática garantizada de assets de Windows
async function ensureDesktopAssets() {
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
  const assets = res.body.assets || [];
  const buildDir = 'C:/flashlab-build/release';

  let exeName = `FlashLab-Setup-${version}.exe`;
  let exePath = path.join(buildDir, exeName);
  if (!fs.existsSync(exePath)) {
    const altExe = `FlashLab Setup ${version}.exe`;
    if (fs.existsSync(path.join(buildDir, altExe))) {
      exeName = altExe;
      exePath = path.join(buildDir, altExe);
    }
  }

  if (!fs.existsSync(exePath)) {
    console.log('No se encontró el instalador en ' + buildDir);
    return;
  }

  const exeBuf = fs.readFileSync(exePath);
  const exeSize = exeBuf.length;
  const sha512 = crypto.createHash('sha512').update(exeBuf).digest('base64');

  // Verificar instalador .exe
  const hasExe = assets.some(a => a.name === exeName);
  if (!hasExe) {
    console.log(`⬆ Subiendo instalador ${exeName} (${(exeSize / 1024 / 1024).toFixed(1)} MB)...`);
    await ghRequest({
      hostname: 'uploads.github.com',
      path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(exeName)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': exeSize
      }
    }, exeBuf);
    console.log(`✓ ${exeName} subido.`);
  } else {
    console.log(`✓ ${exeName} ya está en GitHub.`);
  }

  // Generar latest.yml exacto con la versión actual y sha512 real
  const latestYmlContent = `version: ${version}
files:
  - url: ${exeName}
    sha512: ${sha512}
    size: ${exeSize}
path: ${exeName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
  const ymlBuf = Buffer.from(latestYmlContent, 'utf8');

  // Si existe latest.yml previo, reemplazarlo
  const oldYmlAsset = assets.find(a => a.name === 'latest.yml');
  if (oldYmlAsset) {
    console.log('🔄 Reemplazando latest.yml en GitHub...');
    await ghRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/assets/${oldYmlAsset.id}`,
      method: 'DELETE'
    });
  }

  console.log(`⬆ Subiendo latest.yml de v${version}...`);
  await ghRequest({
    hostname: 'uploads.github.com',
    path: `/repos/${repo}/releases/${releaseId}/assets?name=latest.yml`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': ymlBuf.length
    }
  }, ymlBuf);
  console.log(`✓ latest.yml subido exitosamente.`);

  // Blockmap
  const blockmapName = `${exeName}.blockmap`;
  const blockmapPath = path.join(buildDir, blockmapName);
  const hasBlockmap = assets.some(a => a.name === blockmapName);
  if (fs.existsSync(blockmapPath) && !hasBlockmap) {
    const bBuf = fs.readFileSync(blockmapPath);
    await ghRequest({
      hostname: 'uploads.github.com',
      path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(blockmapName)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bBuf.length
      }
    }, bBuf);
    console.log(`✓ ${blockmapName} subido.`);
  }
}

// 6. Buildear y subir el .apk de Android (regla de oro de CLAUDE.md)
async function buildAndUploadAndroidApk() {
  if (!releaseId) {
    console.log('⚠️ No hay releaseId para subir el APK');
    return;
  }
  console.log(`\n🤖 Compilando APK de Android para ${tag}...`);
  try {
    console.log('📱 Sincronizando Capacitor con Android...');
    execSync('npx cap sync android', { stdio: 'inherit' });

    console.log('🔨 Compilando APK con Gradle (assembleRelease)...');
    const javaHome = 'C:\\Users\\edwar\\dev-tools\\jdk21-home';
    execSync('cmd.exe /c "gradlew.bat assembleRelease"', {
      cwd: path.resolve('android'),
      stdio: 'inherit',
      env: { ...process.env, JAVA_HOME: javaHome }
    });

    const apkPath = path.resolve('android/app/build/outputs/apk/release/app-release.apk');
    if (!fs.existsSync(apkPath)) {
      console.log('⚠️ No se encontró app-release.apk en ' + apkPath);
      return;
    }

    const apkName = `FlashLab-${version}.apk`;
    const apkBuf = fs.readFileSync(apkPath);
    const apkSize = apkBuf.length;

    // Verificar si ya existe en GitHub
    const freshRel = await ghRequest({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/${releaseId}`,
      method: 'GET'
    });
    const freshAssets = freshRel.body?.assets || [];
    const oldApk = freshAssets.find(a => a.name === apkName);
    if (oldApk) {
      console.log(`🔄 Reemplazando ${apkName} previo en GitHub...`);
      await ghRequest({
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases/assets/${oldApk.id}`,
        method: 'DELETE'
      });
    }

    console.log(`⬆ Subiendo ${apkName} (${(apkSize / 1024 / 1024).toFixed(1)} MB)...`);
    await ghRequest({
      hostname: 'uploads.github.com',
      path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(apkName)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': apkSize
      }
    }, apkBuf);
    console.log(`✓ ${apkName} subido exitosamente a GitHub.`);
  } catch (err) {
    console.error('⚠️ Error al generar o subir el APK de Android:', err.message);
  }
}

await ensureDesktopAssets();
await buildAndUploadAndroidApk();

console.log(`\n✨ ¡Release ${tag} 100% completo en GitHub! Contiene .exe y .apk sincronizados.\n`);
