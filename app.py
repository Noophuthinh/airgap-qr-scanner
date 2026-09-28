"""
Flask server for deploying Web Scanner & VirusTotal proxy to Render (or any cloud host).
"""
import os
import requests
from flask import Flask, send_from_directory, request, jsonify

app = Flask(__name__, static_folder="web_scanner")

DEFAULT_VT_API_KEY = os.environ.get("VT_API_KEY", "")

@app.route("/")
def index():
    return send_from_directory("web_scanner", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("web_scanner", filename)

@app.route("/api/vt/check_hash", methods=["GET"])
def check_hash():
    file_hash = request.args.get("hash")
    api_key = request.headers.get("x-apikey") or request.args.get("key") or DEFAULT_VT_API_KEY

    if not file_hash or not api_key:
        return jsonify({"error": "Missing file hash or API key"}), 400

    vt_url = f"https://www.virustotal.com/api/v3/files/{file_hash}"
    try:
        resp = requests.get(vt_url, headers={"x-apikey": api_key}, timeout=15)
        return (resp.content, resp.status_code, {"Content-Type": "application/json"})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/vt/upload", methods=["POST"])
def upload_file():
    api_key = request.headers.get("x-apikey") or DEFAULT_VT_API_KEY
    if not api_key:
        return jsonify({"error": "Missing x-apikey"}), 400

    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file_obj = request.files["file"]
    vt_url = "https://www.virustotal.com/api/v3/files"
    try:
        files = {"file": (file_obj.filename, file_obj.stream, file_obj.content_type)}
        resp = requests.post(vt_url, headers={"x-apikey": api_key}, files=files, timeout=45)
        return (resp.content, resp.status_code, {"Content-Type": "application/json"})
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
