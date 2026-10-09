#!/usr/bin/env python3
"""Aplica los enganches de Terminal Celular en los servidores existentes.

Es idempotente: si el enganche ya está presente, no lo vuelve a insertar.
Falla con error si un marcador esperado no existe (para no dar "ok" en falso).
Uso: patch.py <WTS_DIR> <COFFE_DIR>
"""
import re
import sys
import pathlib


class MarkerNotFound(Exception):
    pass


def must_replace(s: str, marker: str, replacement: str, count: int = 1) -> str:
    if marker not in s:
        raise MarkerNotFound(f"marcador no encontrado: {marker!r}")
    return s.replace(marker, replacement, count)


def patch(path: pathlib.Path, steps):
    src = path.read_text()
    original = src
    for check, apply in steps:
        if check and check in src:
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
    app_import = "import { handleAppRequest, isMobileClient } from './opencode-app.js'"

    def add_import(s):
        for anchor in (
            "import { attachTerminal } from './terminal.js'",
            "import { attachTerminal, closeAllTerminals } from './terminal.js'",
        ):
            if anchor in s:
                return must_replace(s, anchor, anchor + "\n" + app_import, 1)
        raise MarkerNotFound("no se encontró el import de './terminal.js'")

    def add_hook(s):
        marker = "  // --- Terminal page ---"
        hook = (
            "  // --- Terminal Celular (app movil opencode) ---\n"
            "  if (handleAppRequest(req, res, url, path)) return\n\n"
        )
        return must_replace(s, marker, hook + marker, 1)

    def add_redirect(s):
        marker = "  if (path === '/terminal' || path === '/terminal/') {\n"
        redirect = (
            "    if (isMobileClient(req)) { res.writeHead(302, { Location: '/app' }); res.end(); return }\n"
        )
        return must_replace(s, marker, marker + redirect, 1)

    try:
        patch(
            server_ts,
            [
                ("from './opencode-app.js'", add_import),
                ("handleAppRequest(req, res, url, path)", add_hook),
                ("Location: '/app'", add_redirect),
            ],
        )
    except MarkerNotFound as e:
        sys.exit(f"ERROR en {server_ts}: {e}")

    coffecode_js = coffe_dir / "server.js"

    # Elimina cualquier variante previa de las líneas /app y /oc (amplia o
    # exacta, incluso duplicadas) y deja UNA pareja canónica. Idempotente.
    def normalize_proxy(s):
        for pat in (
            r"^ *urlPath === '/app' \|\| urlPath\.startsWith\('/app/'\) \|\|\n",
            r"^ *urlPath === '/oc' \|\| urlPath\.startsWith\('/oc/'\) \|\|\n",
            r"^ *urlPath\.startsWith\('/app'\) \|\|\n",
            r"^ *urlPath\.startsWith\('/oc'\) \|\|\n",
        ):
            s = re.sub(pat, "", s, flags=re.M)
        marker = "      urlPath.startsWith('/gastometro') ||\n"
        if marker not in s:
            raise MarkerNotFound("no se encontró el marcador de gastometro en coffecode server.js")
        canonical = (
            "      urlPath === '/app' || urlPath.startsWith('/app/') ||\n"
            "      urlPath === '/oc' || urlPath.startsWith('/oc/') ||\n"
        )
        return s.replace(marker, marker + canonical, 1)

    try:
        # check vacío → siempre se ejecuta (normalize_proxy ya es idempotente).
        patch(coffecode_js, [("", normalize_proxy)])
    except MarkerNotFound as e:
        sys.exit(f"ERROR en {coffecode_js}: {e}")


if __name__ == "__main__":
    main()
