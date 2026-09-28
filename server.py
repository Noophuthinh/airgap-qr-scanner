"""
Local HTTPS Server for hosting the Mobile Web Scanner and optional VirusTotal proxy.
Generates a self-signed SSL certificate automatically to enable camera access (getUserMedia)
on mobile browsers over local Wi-Fi.
"""
import os
import sys
import ssl
import json
import socket
import datetime
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, HTTPServer
import threading

DEFAULT_VT_API_KEY = os.environ.get("VT_API_KEY", "")

def get_local_ip() -> str:
    """Detects the primary LAN IP address of this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't need to actually reach 8.8.8.8, just picks the default outbound interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def ensure_ssl_cert(cert_dir: str) -> tuple[str, str]:
    """Generates a self-signed certificate if one doesn't exist."""
    os.makedirs(cert_dir, exist_ok=True)
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")

    if os.path.exists(cert_file) and os.path.exists(key_file):
        return cert_file, key_file

    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "QRTransferAirGap"),
    ])
    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.datetime.now(datetime.timezone.utc)
    ).not_valid_after(
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)
    ).sign(key, hashes.SHA256())

    with open(key_file, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    return cert_file, key_file

class QRTransferHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        # Enable CORS
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-apikey")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # Handle VirusTotal Hash Check Proxy
        if self.path.startswith("/api/vt/check_hash"):
            self.handle_vt_check_hash()
            return
        super().do_GET()

    def do_POST(self):
        # Handle VirusTotal File Upload Proxy
        if self.path.startswith("/api/vt/upload"):
            self.handle_vt_upload()
            return
        self.send_error(404, "Endpoint not found")

    def handle_vt_check_hash(self):
        from urllib.parse import urlparse, parse_qs
        query = parse_qs(urlparse(self.path).query)
        file_hash = query.get("hash", [None])[0]
        api_key = self.headers.get("x-apikey") or query.get("key", [None])[0] or DEFAULT_VT_API_KEY

        if not file_hash or not api_key:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing hash or api key"}).encode("utf-8"))
            return

        vt_url = f"https://www.virustotal.com/api/v3/files/{file_hash}"
        req = urllib.request.Request(vt_url, headers={"x-apikey": api_key})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_vt_upload(self):
        api_key = self.headers.get("x-apikey") or DEFAULT_VT_API_KEY
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if not api_key:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Missing x-apikey header"}).encode("utf-8"))
            return

        content_type = self.headers.get("Content-Type", "application/octet-stream")
        vt_url = "https://www.virustotal.com/api/v3/files"
        req = urllib.request.Request(vt_url, data=body, headers={
            "x-apikey": api_key,
            "Content-Type": content_type
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

class ScannerWebServer:
    def __init__(self, web_dir: str, port: int = 8443):
        self.web_dir = web_dir
        self.port = port
        self.local_ip = get_local_ip()
        self.httpd = None
        self.thread = None

    def start(self):
        # Place certs in a writable directory
        app_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        cert_dir = os.path.join(app_dir, "certs")
        cert_file, key_file = ensure_ssl_cert(cert_dir)

        def handler_factory(*args, **kwargs):
            return QRTransferHandler(*args, directory=self.web_dir, **kwargs)

        self.httpd = HTTPServer(("0.0.0.0", self.port), handler_factory)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        self.httpd.socket = context.wrap_socket(self.httpd.socket, server_side=True)

        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def get_url(self) -> str:
        return f"https://{self.local_ip}:{self.port}"

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
