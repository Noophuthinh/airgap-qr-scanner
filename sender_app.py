"""
Air-Gap Optical File Transmitter (Windows Sender App)
Splits files into zlib-compressed QRF1 packets and transmits them via dynamic QR animation.
Features high-speed single/multi-grid QR display and built-in HTTPS mobile scanner server.
"""

import os
import sys
import json
import time
import math
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import qrcode
import qrcode.base
from PIL import Image, ImageTk

# Defensive patch for qrcode bug where all-zero data blocks raise ValueError: glog(0)
_orig_poly_mod = qrcode.base.Polynomial.__mod__
def _safe_poly_mod(self, other):
    if not any(self.num):
        return qrcode.base.Polynomial([0] * (len(other) - 1), 0)
    while self.num and self.num[0] == 0:
        self.num.pop(0)
    if not self.num or len(self) < len(other):
        return self
    return _orig_poly_mod(self, other)
qrcode.base.Polynomial.__mod__ = _safe_poly_mod

from protocol import PacketProtocol, make_droplet_packet
from server import ScannerWebServer, get_local_ip

def get_app_dir():
    return os.path.dirname(os.path.abspath(sys.argv[0]))

def load_config():
    cfg_path = os.path.join(get_app_dir(), "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"public_scanner_url": ""}

def save_config(cfg):
    cfg_path = os.path.join(get_app_dir(), "config.json")
    try:
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass

class AirGapSenderGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Air-Gap Optical File Transmitter")
        self.root.geometry("980x750")
        self.root.minsize(850, 650)
        self.root.configure(bg="#0b0f19")

        # Application state
        self.current_file_path = None
        self.file_info = None
        self.packets = []
        self.qr_cache = {}  # idx -> PIL Image (JIT / prefetch cache)
        self.is_transmitting = False
        self.current_frame_idx = 0
        self.loop_count = 1
        self.fps = 14
        self.grid_mode = "1x1"  # "1x1", "1x2", or "2x2"
        self._chunk_after = None
        self._prep_token = 0
        self._prep_state = None
        self.showing_connect_qr = False
        self.config = load_config()
        self.public_scanner_url = self.config.get("public_scanner_url", "")

        # Start Built-in HTTPS Web Server for mobile scanner
        if getattr(sys, "frozen", False):
            base_dir = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.argv[0])))
        else:
            base_dir = os.path.dirname(os.path.abspath(__file__))
        web_dir = os.path.join(base_dir, "web_scanner")
        self.server = ScannerWebServer(web_dir=web_dir, port=8443)
        try:
            self.server.start()
            self.server_url = self.server.get_url()
        except Exception as e:
            self.server_url = f"Error: {e}"

        self._init_ui()

        # 1. Setup Drag & Drop into GUI window
        try:
            import windnd
            windnd.hook_dropfiles(self.root, func=self._on_drop_files)
        except Exception as e:
            print("windnd hook warning:", e)

        # 2. Check if a file was dragged directly onto the .exe icon (passed via sys.argv)
        initial_file = None
        if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
            initial_file = os.path.abspath(sys.argv[1])

        if initial_file:
            self.current_file_path = initial_file
            # Process and prepare the dropped file automatically after GUI loads
            self.root.after(300, self._process_and_prepare_file)
        else:
            self._show_welcome_screen()

    def _init_ui(self):
        # Configure Styles
        self.style = ttk.Style()
        self.style.theme_use("clam")

        # Main Layout
        self.left_panel = tk.Frame(self.root, bg="#151c2c", width=340, padx=16, pady=16)
        self.left_panel.pack(side=tk.LEFT, fill=tk.Y, padx=(10, 5), pady=10)
        self.left_panel.pack_propagate(False)

        self.right_panel = tk.Frame(self.root, bg="#0b0f19", padx=16, pady=16)
        self.right_panel.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=(5, 10), pady=10)

        # Left Panel: File Selection & Controls
        header_lbl = tk.Label(
            self.left_panel, text="📡 Air-Gap Sender", font=("Segoe UI", 16, "bold"),
            fg="#00f0ff", bg="#151c2c"
        )
        header_lbl.pack(anchor="w", pady=(0, 10))

        # Top Action Buttons: Select File (50%) + Start Transmission (50%)
        top_btn_frame = tk.Frame(self.left_panel, bg="#151c2c")
        top_btn_frame.pack(fill=tk.X, pady=(0, 10))

        self.btn_browse = tk.Button(
            top_btn_frame, text="📁 Chọn Tệp...", font=("Segoe UI", 10, "bold"),
            bg="#0072ff", fg="white", activebackground="#0056c6", activeforeground="white",
            relief="flat", cursor="hand2", padx=6, pady=8, command=self._on_browse_file
        )
        self.btn_browse.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 3))

        self.btn_start = tk.Button(
            top_btn_frame, text="▶️ Bắt Đầu Quét", font=("Segoe UI", 10, "bold"),
            bg="#00e676", fg="#0b0f19", activebackground="#00b85c", activeforeground="#0b0f19",
            disabledforeground="#55657e",
            relief="flat", cursor="hand2", padx=6, pady=8, state=tk.DISABLED,
            command=self._toggle_transmission
        )
        self.btn_start.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=(3, 0))

        # File Info Card
        self.info_frame = tk.LabelFrame(
            self.left_panel, text="Thông Tin Tệp", font=("Segoe UI", 10, "bold"),
            fg="#8e9bb3", bg="#151c2c", padx=10, pady=10
        )
        self.info_frame.pack(fill=tk.X, pady=(0, 15))

        self.lbl_file_name = tk.Label(
            self.info_frame, text="Tệp: (Chưa chọn)", font=("Segoe UI", 9),
            fg="#f0f4fc", bg="#151c2c", anchor="w", wraplength=280
        )
        self.lbl_file_name.pack(fill=tk.X, pady=2)

        self.lbl_orig_size = tk.Label(
            self.info_frame, text="Kích thước gốc: 0 KB", font=("Segoe UI", 9),
            fg="#8e9bb3", bg="#151c2c", anchor="w"
        )
        self.lbl_orig_size.pack(fill=tk.X, pady=2)

        self.lbl_comp_size = tk.Label(
            self.info_frame, text="Sau khi nén (zlib): 0 KB", font=("Segoe UI", 9),
            fg="#00e676", bg="#151c2c", anchor="w"
        )
        self.lbl_comp_size.pack(fill=tk.X, pady=2)

        self.lbl_chunks_count = tk.Label(
            self.info_frame, text="Số mảnh QR: 0", font=("Segoe UI", 9),
            fg="#ffb800", bg="#151c2c", anchor="w"
        )
        self.lbl_chunks_count.pack(fill=tk.X, pady=2)

        self.lbl_md5 = tk.Label(
            self.info_frame, text="MD5: -", font=("Segoe UI", 8),
            fg="#00f0ff", bg="#151c2c", anchor="w", wraplength=280
        )
        self.lbl_md5.pack(fill=tk.X, pady=2)

        # Transmission Settings
        settings_frame = tk.LabelFrame(
            self.left_panel, text="Cài Đặt Truyền Quang Học", font=("Segoe UI", 10, "bold"),
            fg="#8e9bb3", bg="#151c2c", padx=10, pady=10
        )
        settings_frame.pack(fill=tk.X, pady=(0, 15))

        # Speed Presets Buttons
        preset_lbl = tk.Label(
            settings_frame, text="⚡ Cấu hình tốc độ nhanh:", fg="#ffb800", bg="#151c2c",
            font=("Segoe UI", 8, "bold")
        )
        preset_lbl.pack(anchor="w", pady=(0, 4))
        preset_box = tk.Frame(settings_frame, bg="#151c2c")
        preset_box.pack(fill=tk.X, pady=(0, 8))

        self.btn_preset_std = tk.Button(
            preset_box, text="🐢 Chuẩn\n~6 KB/s", font=("Segoe UI", 7),
            bg="#232f48", fg="#f0f4fc", relief="flat", cursor="hand2", padx=1, pady=3,
            command=lambda: self._apply_preset(800, 10)
        )
        self.btn_preset_std.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 2))

        self.btn_preset_fast = tk.Button(
            preset_box, text="🚀 Nhanh\n~12 KB/s", font=("Segoe UI", 7, "bold"),
            bg="#0072ff", fg="white", relief="flat", cursor="hand2", padx=1, pady=3,
            command=lambda: self._apply_preset(1100, 14)
        )
        self.btn_preset_fast.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=1)

        self.btn_preset_turbo = tk.Button(
            preset_box, text="⚡ Siêu tốc\n~20 KB/s", font=("Segoe UI", 7, "bold"),
            bg="#232f48", fg="#ffb800", relief="flat", cursor="hand2", padx=1, pady=3,
            command=lambda: self._apply_preset(1400, 18)
        )
        self.btn_preset_turbo.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=1)

        self.btn_preset_max = tk.Button(
            preset_box, text="🏎️ Thần tốc\n~28 KB/s", font=("Segoe UI", 7, "bold"),
            bg="#232f48", fg="#00e676", relief="flat", cursor="hand2", padx=1, pady=3,
            command=lambda: self._apply_preset(1650, 20)
        )
        self.btn_preset_max.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(2, 0))

        # FPS Slider
        fps_box = tk.Frame(settings_frame, bg="#151c2c")
        fps_box.pack(fill=tk.X, pady=4)
        self.lbl_fps = tk.Label(fps_box, text=f"Tốc độ phát: {self.fps} FPS", fg="#f0f4fc", bg="#151c2c", font=("Segoe UI", 9))
        self.lbl_fps.pack(side=tk.LEFT)
        self.slider_fps = tk.Scale(
            settings_frame, from_=2, to=30, orient=tk.HORIZONTAL,
            bg="#151c2c", fg="white", highlightthickness=0,
            command=self._on_fps_change
        )
        self.slider_fps.set(self.fps)
        self.slider_fps.pack(fill=tk.X, pady=(0, 8))

        # Chunk Size Slider
        chunk_box = tk.Frame(settings_frame, bg="#151c2c")
        chunk_box.pack(fill=tk.X, pady=4)
        self.lbl_chunk_size = tk.Label(chunk_box, text="Kích thước mảnh: 1100 bytes", fg="#f0f4fc", bg="#151c2c", font=("Segoe UI", 9))
        self.lbl_chunk_size.pack(side=tk.LEFT)
        self.slider_chunk = tk.Scale(
            settings_frame, from_=300, to=2000, resolution=50, orient=tk.HORIZONTAL,
            bg="#151c2c", fg="white", highlightthickness=0,
            command=self._on_chunk_change
        )
        self.slider_chunk.set(1100)
        self.slider_chunk.pack(fill=tk.X, pady=(0, 4))

        btn_auto_chunk = tk.Button(
            settings_frame, text="⚡ Tự động tối ưu số mảnh (Auto)", font=("Segoe UI", 8, "bold"),
            bg="#232f48", fg="#ffb800", relief="flat", cursor="hand2",
            command=self._on_auto_optimize_chunks
        )
        btn_auto_chunk.pack(fill=tk.X, pady=(0, 8))

        # Grid Mode Option (1x1 vs 2x2)
        grid_box = tk.Frame(settings_frame, bg="#151c2c")
        grid_box.pack(fill=tk.X, pady=4)
        tk.Label(grid_box, text="Chế độ quét:", fg="#f0f4fc", bg="#151c2c", font=("Segoe UI", 9)).pack(side=tk.LEFT)
        self.mode_var = tk.StringVar(value="1x1 (1 mã - Rõ nét nhất)")
        self.combo_mode = ttk.Combobox(
            grid_box, textvariable=self.mode_var, values=[
                "1x1 (1 mã - Rõ nét nhất)",
                "1x2 (2 mã song song - Cực nhanh & dễ đọc)",
                "2x2 (4 mã lưới - 4x tốc độ)"
            ],
            state="readonly", width=24
        )
        self.combo_mode.pack(side=tk.RIGHT)
        self.combo_mode.bind("<<ComboboxSelected>>", self._on_mode_change)

        # Cloud / Render URL Setting
        url_frame = tk.LabelFrame(
            self.left_panel, text="Địa Chỉ Web Scanner (Render/Cloud)", font=("Segoe UI", 9, "bold"),
            fg="#8e9bb3", bg="#151c2c", padx=8, pady=6
        )
        url_frame.pack(fill=tk.X, pady=(0, 10))

        self.entry_public_url = tk.Entry(
            url_frame, font=("Segoe UI", 9), bg="#0b0f19", fg="#00f0ff", insertbackground="white"
        )
        self.entry_public_url.pack(fill=tk.X, pady=(0, 4))
        if self.public_scanner_url:
            self.entry_public_url.insert(0, self.public_scanner_url)

        btn_save_url = tk.Button(
            url_frame, text="💾 Lưu URL Render", font=("Segoe UI", 8, "bold"),
            bg="#232f48", fg="#00e676", relief="flat", cursor="hand2",
            command=self._on_save_public_url
        )
        btn_save_url.pack(fill=tk.X)

        # Mobile Web Scanner Connect Button

        self.btn_connect_qr = tk.Button(
            self.left_panel, text="📱 Quét mã mở Web Scanner", font=("Segoe UI", 10),
            bg="#232f48", fg="#f0f4fc", activebackground="#2d3d5e", activeforeground="white",
            relief="flat", cursor="hand2", padx=10, pady=8,
            command=self._show_connect_qr_screen
        )
        self.btn_connect_qr.pack(fill=tk.X, pady=(0, 10))

        # Server Status Footer
        server_lbl = tk.Label(
            self.left_panel, text=f"🌐 Server di động: {self.server_url}",
            font=("Segoe UI", 8), fg="#00f0ff", bg="#151c2c", wraplength=280, justify=tk.LEFT
        )
        server_lbl.pack(side=tk.BOTTOM, fill=tk.X)

        # Right Panel: Display Canvas & Progress
        self.right_header = tk.Frame(self.right_panel, bg="#0b0f19")
        self.right_header.pack(fill=tk.X, pady=(0, 10))

        self.lbl_status = tk.Label(
            self.right_header, text="Sẵn sàng truyền dữ liệu", font=("Segoe UI", 13, "bold"),
            fg="#f0f4fc", bg="#0b0f19"
        )
        self.lbl_status.pack(side=tk.LEFT)

        self.lbl_loop = tk.Label(
            self.right_header, text="", font=("Segoe UI", 11),
            fg="#ffb800", bg="#0b0f19"
        )
        self.lbl_loop.pack(side=tk.RIGHT)

        # Canvas for displaying QR codes
        self.canvas_frame = tk.Frame(self.right_panel, bg="#151c2c", bd=2, relief="groove")
        self.canvas_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 10))

        self.canvas = tk.Canvas(self.canvas_frame, bg="#ffffff", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        # Progress bar
        self.progress_var = tk.DoubleVar(value=0.0)
        self.progress_bar = ttk.Progressbar(
            self.right_panel, variable=self.progress_var, maximum=100.0, mode="determinate"
        )
        self.progress_bar.pack(fill=tk.X, pady=(0, 4))

        self.lbl_progress_text = tk.Label(
            self.right_panel, text="Mảnh: 0/0 (0%)", font=("Segoe UI", 10),
            fg="#8e9bb3", bg="#0b0f19"
        )
        self.lbl_progress_text.pack(anchor="w")

    def _show_welcome_screen(self):
        """Shows instructions and connect QR when app launches."""
        self._show_connect_qr_screen()

    def _on_save_public_url(self):
        url = self.entry_public_url.get().strip()
        self.public_scanner_url = url
        self.config["public_scanner_url"] = url
        save_config(self.config)
        self._show_connect_qr_screen()
        messagebox.showinfo("Đã lưu", f"Đã cập nhật địa chỉ Web Scanner:\n{url if url else self.server_url}")

    def _show_connect_qr_screen(self):
        """Displays the QR code pointing to the mobile web scanner URL (Cloud or Local)."""
        self.is_transmitting = False
        self.btn_start.config(text="▶️ Bắt Đầu Quét", bg="#00e676")
        self.lbl_status.config(text="Dùng điện thoại quét mã mở Web Scanner", fg="#00f0ff")
        self.lbl_loop.config(text="")

        target_url = self.public_scanner_url.strip() if self.public_scanner_url.strip() else self.server_url

        qr = qrcode.QRCode(box_size=10, border=3)
        qr.add_data(target_url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#000000", back_color="#ffffff")

        self._render_image_on_canvas(img)
        self.lbl_progress_text.config(text=f"Địa chỉ truy cập trên điện thoại: {target_url}")

    def _on_browse_file(self):
        file_path = filedialog.askopenfilename()
        if not file_path:
            return
        self.current_file_path = file_path
        self._process_and_prepare_file()

    def _on_drop_files(self, files):
        """Callback for windnd drag and drop event."""
        if not files:
            return
        target = files[0]
        if isinstance(target, bytes):
            try:
                target = target.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    target = target.decode("mbcs")
                except Exception:
                    target = target.decode("gbk", errors="ignore")

        if os.path.isfile(target):
            self.current_file_path = os.path.abspath(target)
            self._process_and_prepare_file()
            # If user drops a file, we can also auto start or let them click
            self.root.lift()

    def _on_fps_change(self, val):
        self.fps = int(val)
        self.lbl_fps.config(text=f"Tốc độ phát: {self.fps} FPS")

    def _on_chunk_change(self, val):
        self.lbl_chunk_size.config(text=f"Kích thước mảnh: {int(val)} bytes")
        if self.current_file_path:
            # Debounce: only rebuild once the slider stops moving (prevents UI freezes)
            if self._chunk_after:
                self.root.after_cancel(self._chunk_after)
            self._chunk_after = self.root.after(500, self._process_and_prepare_file)

    def _apply_preset(self, chunk_size: int, fps: int):
        self.slider_fps.set(fps)
        self.slider_chunk.set(chunk_size)

    def _on_auto_optimize_chunks(self):
        """Pick a chunk size giving roughly 25-30 data frames (sweet spot for high-speed phone scanning)."""
        if not self.file_info:
            return
        optimal = max(600, min(1500, int(self.file_info["compressed_size"] / 25)))
        optimal = (optimal // 50) * 50
        self.slider_chunk.set(optimal)  # triggers the debounced rebuild

    def _on_mode_change(self, event=None):
        selected = self.mode_var.get()
        if "2x2" in selected or "4 mã" in selected:
            self.grid_mode = "2x2"
        elif "1x2" in selected or "2 mã" in selected:
            self.grid_mode = "1x2"
        else:
            self.grid_mode = "1x1"
        if not self.is_transmitting and self.packets:
            self._display_current_frame()

    @staticmethod
    def _make_qr_image(text: str) -> Image.Image:
        """Fast QR -> 8-bit image (1 pixel per module, 4-module quiet zone)."""
        qr = qrcode.QRCode(
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            border=0,
            box_size=1,
            mask_pattern=2,
        )
        qr.add_data(text)
        qr.make(fit=True)
        matrix = qr.get_matrix()
        quiet = 4
        n = len(matrix) + 2 * quiet
        white = b"\xff" * n
        rows = [white] * quiet
        for r in matrix:
            rows.append(b"\xff" * quiet + bytes(0 if c else 255 for c in r) + b"\xff" * quiet)
        rows += [white] * quiet
        return Image.frombytes("L", (n, n), b"".join(rows))

    def _process_and_prepare_file(self):
        """Prepares packets instantly and starts non-blocking streaming + prefetch."""
        self._chunk_after = None
        if not self.current_file_path:
            return
        self._prep_token += 1
        token = self._prep_token
        self.is_transmitting = False
        self.packets = []
        self.qr_cache = {}
        self.btn_start.config(text="▶️ Bắt Đầu Quét", bg="#00e676", state=tk.DISABLED)
        self.lbl_status.config(text="Đang nạp file...", fg="#ffb800")

        chunk_size = int(self.slider_chunk.get())
        path = self.current_file_path

        def worker():
            try:
                # 1. Prepare packets in memory (fast: ~0.05 - 0.2s)
                info = PacketProtocol.prepare_file(path, chunk_size=chunk_size)
                if token != self._prep_token:
                    return
                packets = info["packets"]
                if not packets:
                    return

                # 2. Render frame 0 immediately
                img0 = self._make_qr_image(packets[0])
                if token != self._prep_token:
                    return

                def on_ready():
                    if token != self._prep_token:
                        return
                    self.packets = packets
                    self.file_info = info
                    self.qr_cache = {0: img0}
                    self.lbl_file_name.config(text=f"Tệp: {info['file_name']}")
                    self.lbl_orig_size.config(text=f"Kích thước gốc: {self._format_bytes(info['orig_size'])}")
                    ratio = (1 - info["compressed_size"] / max(1, info["orig_size"])) * 100
                    note = "nén zlib" if info["compressed"] else "không nén (dữ liệu đã nén sẵn)"
                    self.lbl_comp_size.config(
                        text=f"Dữ liệu gửi: {self._format_bytes(info['compressed_size'])} ({note}, {ratio:+.1f}%)"
                    )
                    self.lbl_chunks_count.config(
                        text=f"Mảnh gốc: {info['total_chunks']} | Tổng khung: {len(packets)}"
                    )
                    self.lbl_md5.config(text=f"MD5: {info['orig_md5']}")
                    self.btn_start.config(state=tk.NORMAL)
                    self.lbl_status.config(text="Đã sẵn sàng. Nhấn Bắt Đầu để truyền!", fg="#00e676")
                    self.current_frame_idx = 0
                    self.loop_count = 1
                    self._display_current_frame()

                    # 3. Background prefetcher with 6ms sleep so GUI stays at 120 FPS buttery smooth
                    def prefetch_loop():
                        for i in range(1, len(packets)):
                            if token != self._prep_token:
                                return
                            if i not in self.qr_cache:
                                img = self._make_qr_image(packets[i])
                                self.qr_cache[i] = img
                            time.sleep(0.006)

                    threading.Thread(target=prefetch_loop, daemon=True).start()

                self.root.after(0, on_ready)

            except Exception as e:
                def on_error(err=str(e)):
                    if token != self._prep_token:
                        return
                    messagebox.showerror("Lỗi", f"Không thể xử lý file: {err}")
                    self.lbl_status.config(text="Lỗi xử lý file", fg="#ff3860")
                self.root.after(0, on_error)

        threading.Thread(target=worker, daemon=True).start()

    def _toggle_transmission(self):
        if not self.is_transmitting:
            if not self.packets:
                return
            self.is_transmitting = True
            self.btn_start.config(text="⏹️ TẠM DỪNG", bg="#ff3860")
            self.lbl_status.config(text=f"Đang phát luồng dữ liệu... ({self.grid_mode})", fg="#00f0ff")
            self._transmission_tick()
        else:
            self.is_transmitting = False
            self.btn_start.config(text="▶️ TIẾP TỤC", bg="#00e676")
            self.lbl_status.config(text="Đã tạm dừng", fg="#ffb800")

    def _frames_per_view(self):
        return {"1x1": 1, "1x2": 2, "2x2": 4}[self.grid_mode]

    def _ensure_packet(self, idx: int):
        """Generates fresh Luby Transform droplets on demand so the fountain stream is truly infinite."""
        if not self.file_info or not self.packets:
            return
        blocks = self.file_info.get("blocks")
        if not blocks:
            return
        file_id = self.file_info["file_id"]
        k = self.file_info["total_chunks"]
        size = self.file_info["chunk_size"]
        meta_pkt = self.file_info.get("meta_packet")

        while idx >= len(self.packets):
            next_idx = len(self.packets)
            # Inject metadata packet periodically so newly connecting scanners catch it immediately
            if next_idx % 25 == 0 and meta_pkt:
                self.packets.append(meta_pkt)
            else:
                # Droplet index (subtracting injected meta frames)
                droplet_idx = next_idx - (next_idx // 25)
                pkt = make_droplet_packet(file_id, blocks, k, size, droplet_idx)
                self.packets.append(pkt)

    def _get_frame_image(self, idx: int) -> Image.Image:
        """Retrieves from cache or renders just-in-time from the infinite fountain stream."""
        if not self.packets:
            return None
        self._ensure_packet(idx)
        img = self.qr_cache.get(idx)
        if img is None:
            img = self._make_qr_image(self.packets[idx])
            self.qr_cache[idx] = img
            # Bounded LRU memory cache
            if len(self.qr_cache) > 160:
                self.qr_cache.pop(next(iter(self.qr_cache)))
        return img

    def _transmission_tick(self):
        if not self.is_transmitting:
            return
        self._display_current_frame()
        self.current_frame_idx += self._frames_per_view()
        self.root.after(max(10, int(1000 / self.fps)), self._transmission_tick)

    def _display_current_frame(self):
        if not self.packets or not self.file_info:
            return
        k = self.file_info["total_chunks"]
        count = self._frames_per_view()
        idx = self.current_frame_idx
        imgs = [self._get_frame_image(idx + i) for i in range(count)]
        self._draw_frames(imgs)

        if idx < k:
            pct = min(100, int(((idx + 1) / max(1, k)) * 100))
            self.progress_var.set(pct)
            self.lbl_progress_text.config(
                text=f"Mảnh gốc: {idx + 1}/{k} ({pct}%) | {count} mã/lần | Đang phát tuần tự"
            )
            self.lbl_loop.config(text="Giai đoạn 1: Mảnh gốc")
        else:
            self.progress_var.set(100)
            droplet_num = idx - k + 1
            self.lbl_progress_text.config(
                text=f"🌊 Suối Fountain Code: Giọt #{droplet_num} | {count} mã/lần | Đang phát vô tận"
            )
            self.lbl_loop.config(text=f"Giai đoạn 2: Giọt sửa sai #{droplet_num}")

    def _draw_frames(self, images):
        """Compose 1/2/4 QR images on the canvas using crisp integer scaling."""
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        if cw < 50 or ch < 50:
            cw, ch = 560, 560
        cols, rows = {1: (1, 1), 2: (2, 1), 4: (2, 2)}[len(images)]
        cell_w, cell_h = cw // cols, ch // rows
        board = Image.new("L", (cw, ch), 255)
        for i, img in enumerate(images):
            avail = min(cell_w, cell_h) - 8
            scale = avail // img.width
            if scale >= 1:
                side = img.width * scale
            else:
                side = max(32, avail)
            scaled = img.resize((side, side), Image.Resampling.NEAREST)
            x = (i % cols) * cell_w + (cell_w - side) // 2
            y = (i // cols) * cell_h + (cell_h - side) // 2
            board.paste(scaled, (x, y))
        self.current_tk_image = ImageTk.PhotoImage(board)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.current_tk_image)

    def _render_image_on_canvas(self, pil_img):
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        if canvas_w < 50 or canvas_h < 50:
            canvas_w, canvas_h = 500, 500

        # Fit image while maintaining aspect ratio
        img_copy = pil_img.copy()
        img_copy.thumbnail((canvas_w - 20, canvas_h - 20), Image.Resampling.NEAREST)

        self.current_tk_image = ImageTk.PhotoImage(img_copy)
        self.canvas.delete("all")
        self.canvas.create_image(
            canvas_w // 2, canvas_h // 2, anchor=tk.CENTER, image=self.current_tk_image
        )

    def _format_bytes(self, bytes_val):
        if bytes_val == 0:
            return "0 Bytes"
        units = ["Bytes", "KB", "MB", "GB"]
        i = int(math.floor(math.log(bytes_val, 1024)))
        s = round(bytes_val / math.pow(1024, i), 2)
        return f"{s} {units[i]}"

    def on_closing(self):
        self.is_transmitting = False
        try:
            self.server.stop()
        except Exception:
            pass
        self.root.destroy()
        sys.exit(0)

def main():
    root = tk.Tk()
    app = AirGapSenderGUI(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()

if __name__ == "__main__":
    main()
