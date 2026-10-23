"""リッチメニュー用のダミー画像(2500x843)を生成する。標準ライブラリのみ。
左半分=マイページ(濃色) / 右半分=ヘルプ(淡色)。企業ごとに色を変えて区別する。
"""
import os
import struct
import zlib

W, H = 2500, 843
OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "img")

COLORS = {
    "default": ((90, 90, 90), (150, 150, 150)),
    "acme": ((200, 50, 50), (240, 130, 130)),
    "globex": ((40, 90, 200), (120, 160, 240)),
}


def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make(path, left, right):
    row_l = bytes(left) * (W // 2)
    row_r = bytes(right) * (W - W // 2)
    row = b"\x00" + row_l + row_r
    raw = row * H
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


os.makedirs(OUT, exist_ok=True)
for name, (l, r) in COLORS.items():
    make(os.path.join(OUT, f"richmenu_{name}.png"), l, r)
    print("generated", name)
