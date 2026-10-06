#!/usr/bin/env python3
"""Aplica los enganches de Terminal Celular en los servidores existentes.

Es idempotente: si el enganche ya está presente, no lo vuelve a insertar.
Uso: patch.py <WTS_DIR> <COFFE_DIR>
"""
import sys
import pathlib


def patch(path: pathlib.Path, steps):
    src = path.read_text()
    original = src
    for check, apply in steps:
        if check in src:
            continue
        src = apply(src)
    if src != original:
        path.write_text(src)
        print(f"  patched {path}")
    else:
        print(f"  ok      {path}")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    wts_dir = pathlib.Path(sys.argv[1])
    coffe_dir = pathlib.Path(sys.argv[2])

    server_ts = wts_dir / "server" / "src" / "server.ts"

    def add_import(s):
        marker = "import { attachTerminal } from './terminal.js'"
        return s.replace(
            marker,
            marker + "\nimport { handleAppRequest, isMobileClient } from './opencode-app.js'",
            1,
        )

    def add_hook(s):
        marker = "  // --- Terminal page ---"
        hook = (
            "  // --- Terminal Celular (app movil opencode) ---\n"
            "  if (handleAppRequest(req, res, url, path)) return\n\n"
        )
        return s.replace(marker, hook + marker, 1)

    def add_redirect(s):
        marker = "  if (path === '/terminal' || path === '/terminal/') {\n"
        redirect = (
            "    if (isMobileClient(req)) { res.writeHead(302, { Location: '/app' }); res.end(); return }\n"
        )
        return s.replace(marker, marker + redirect, 1)

    patch(
        server_ts,
        [
            ("from './opencode-app.js'", add_import),
            ("handleAppRequest(req, res, url, path)", add_hook),
            ("Location: '/app'", add_redirect),
        ],
    )

    coffecode_js = coffe_dir / "server.js"

    def add_proxy(s):
        marker = "      urlPath.startsWith('/gastometro') ||\n"
        return s.replace(
            marker,
            marker
            + "      urlPath.startsWith('/app') ||\n"
            + "      urlPath.startsWith('/oc') ||\n",
            1,
        )

    patch(coffecode_js, [("urlPath.startsWith('/oc')", add_proxy)])


if __name__ == "__main__":
    main()
