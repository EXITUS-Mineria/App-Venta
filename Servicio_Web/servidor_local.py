"""Abre la página en tu equipo (http://localhost:8080) sin caché: siempre se ve la última versión."""
import http.server, os, socketserver, webbrowser

PUERTO = 8080
CARPETA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sitio")


class SinCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=CARPETA, **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PUERTO), SinCache) as srv:
    url = f"http://localhost:{PUERTO}"
    print(f"Venta de Cartera en {url}  (deja esta ventana abierta; Ctrl+C para cerrar)")
    webbrowser.open(url)
    srv.serve_forever()
