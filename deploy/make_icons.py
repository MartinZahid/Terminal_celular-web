#!/usr/bin/env python3
"""Genera los iconos PNG de la PWA (sin dependencias)."""
import struct
import zlib
import pathlib
import math

BG = (13, 17, 23)
FG = (124, 252, 90)


def png(w, h, rows):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for (r, g, b, a) in rows[y]:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def dist_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, maskable):
    radius = 0.0 if maskable else 0.22
    t = 0.085
    rows = []
    for y in range(size):
        row = []
        py = (y + 0.5) / size
        for x in range(size):
            px = (x + 0.5) / size
            # fondo: rectángulo redondeado
            inside = True
            if radius > 0:
                qx = abs(px - 0.5) - (0.5 - radius)
                qy = abs(py - 0.5) - (0.5 - radius)
                if qx > 0 and qy > 0:
                    inside = qx * qx + qy * qy <= radius * radius
            if not inside:
                row.append((0, 0, 0, 0))
                continue
            col = BG
            d1 = dist_seg(px, py, 0.30, 0.27, 0.54, 0.50)
            d2 = dist_seg(px, py, 0.54, 0.50, 0.30, 0.73)
            under = 0.57 <= px <= 0.80 and 0.71 <= py <= 0.79
            if d1 < t / 2 or d2 < t / 2 or under:
                col = FG
            row.append((col[0], col[1], col[2], 255))
        rows.append(row)
    return rows


def main():
    out = pathlib.Path(__file__).resolve().parent.parent / "app" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size, maskable, name in [
        (192, False, "icon-192.png"),
        (512, False, "icon-512.png"),
        (512, True, "icon-maskable-512.png"),
    ]:
        (out / name).write_bytes(png(size, size, render(size, maskable)))
        print("wrote", out / name)


if __name__ == "__main__":
    main()
