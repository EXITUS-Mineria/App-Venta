// Servidor estático mínimo para Railway (sin dependencias).
// Sirve la carpeta sitio/. Railway define la variable PORT.
const http = require("http");
const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "sitio");
const PUERTO = process.env.PORT || 8080;
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8",
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let archivo = path.normalize(path.join(RAIZ, url));
  if (!archivo.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
  if (url === "/" || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    archivo = path.join(RAIZ, "index.html");
  }
  const ext = path.extname(archivo);
  res.writeHead(200, {
    "Content-Type": TIPOS[ext] || "application/octet-stream",
    // los módulos y la configuración cambian: que el navegador siempre pregunte
    "Cache-Control": ext === ".html" || ext === ".json" || ext === ".js" ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  });
  fs.createReadStream(archivo).pipe(res);
}).listen(PUERTO, () => console.log(`Venta de Cartera web en el puerto ${PUERTO}`));
