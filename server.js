// Lokal HTTPS-server til test på mobilen (kamera kræver HTTPS).
// Kør:  node server.js   – og åbn den viste https://-adresse på telefonen.
// Første gang skal du acceptere browserens advarsel om selvsigneret certifikat.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8443;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

function handler(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Ikke fundet'); return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    // Cross-origin isolation: lader YOLO (onnxruntime) køre på flere CPU-tråde
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  });
  fs.createReadStream(file).pipe(res);
}

function lanIPs() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const certFile = path.join(ROOT, 'certs', 'cert.pem');
const keyFile = path.join(ROOT, 'certs', 'key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  require('https').createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler)
    .listen(PORT, () => {
      console.log('RaceTrackstar kører på:');
      console.log(`  https://localhost:${PORT}`);
      for (const ip of lanIPs()) console.log(`  https://${ip}:${PORT}   <- brug denne på telefonen (samme wifi)`);
      console.log('Acceptér certifikat-advarslen i browseren første gang.');
    });
} else {
  console.log('Ingen certifikater i certs/ – starter HTTP (kamera virker KUN på http://localhost).');
  require('http').createServer(handler).listen(8080, () => {
    console.log('  http://localhost:8080');
  });
}
