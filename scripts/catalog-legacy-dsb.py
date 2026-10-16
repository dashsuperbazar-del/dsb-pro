#!/usr/bin/env python3
"""Read-only lexical inventory of the user-confirmed old DSB source; never executes it."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess

COMMIT = "62e3c30e9ff573ccfaabe06ad6f49759b37a37be"
FILES = ("index.html", "shop.html", "sw.js", "shop-sw.js", "manifest.json", "shop-manifest.json")


class Controls(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.pending = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag not in ("input", "select", "textarea", "button", "a", "label", "option"):
            return
        # Public UI metadata only: omit URLs, inline code and all script contents.
        row = {"tag": tag, "line": self.getpos()[0]}
        for key in ("id", "name", "type", "for", "placeholder", "value", "min", "max", "step", "inputmode", "aria-label", "required", "disabled", "checked", "selected"):
            if key in values:
                row[key] = values[key] if values[key] is not None else True
        row["events"] = sorted(key for key in values if key.startswith("on"))
        self.rows.append(row)
        if tag != "input":
            self.pending.append((tag, row, []))

    def handle_data(self, data):
        for _, _, chunks in self.pending:
            chunks.append(data)

    def handle_endtag(self, tag):
        for i in range(len(self.pending) - 1, -1, -1):
            name, row, chunks = self.pending[i]
            if name == tag:
                text = " ".join(" ".join(chunks).split())
                if text:
                    row["text"] = text[:240]
                del self.pending[i]
                break


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()


def catalog(source):
    if git(source, "rev-parse", "HEAD") != COMMIT:
        raise ValueError("Source HEAD differs from the user-confirmed commit; review the new baseline explicitly")
    if git(source, "status", "--porcelain", "--", *FILES):
        raise ValueError("Source files have local changes; refusing to label them as the confirmed revision")
    result = {"source_repository": "dashsuperbazar-del/DSB", "commit": COMMIT,
              "tree": git(source, "rev-parse", "HEAD^{tree}"),
              "scope": "Lexical source catalog, not runtime reachability, business correctness or visual acceptance", "files": {}}
    for name in FILES:
        data = (source / name).read_bytes()
        text = data.decode("utf-8")
        lines = text.splitlines()
        entry = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                 "git_blob": git(source, "rev-parse", f"HEAD:{name}"), "lines": len(lines)}
        entry["functions"] = [{"name": m.group(1), "line": text.count("\n", 0, m.start()) + 1}
                              for m in re.finditer(r"(?m)^\s*(?:async\s+)?function\s+([\w$]+)\s*\(", text)]
        entry["keyboard_lines"] = [{"line": i, "source": line.strip()[:400]}
                                   for i, line in enumerate(lines, 1)
                                   if re.search(r"(?:\b(?:e|ev|event)\.(?:key|keyCode)\b|ctrlKey|altKey|metaKey|addEventListener\(['\"]key)", line)]
        if name.endswith(".html"):
            parser = Controls()
            parser.feed(text)
            entry["static_controls"] = parser.rows
            entry["pages_and_modals"] = [{"id": m.group(1), "line": text.count("\n", 0, m.start()) + 1}
                                        for m in re.finditer(r'\bid="((?:page-|modal-)[^"\n]+)"', text)]
            # Also finds event attributes in template strings, which HTMLParser treats as script data.
            entry["inline_handler_names"] = sorted(set(re.findall(r'\bon\w+=["\']\s*([A-Za-z_$][\w$]*)\s*\(', text)))
        result["files"][name] = entry
    return result


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("source", type=Path, help="Read-only checkout of the confirmed old DSB repository")
    args.add_argument("output", type=Path)
    options = args.parse_args()
    result = catalog(options.source.resolve())
    options.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({name: {"functions": len(f["functions"]), "static_controls": len(f.get("static_controls", []))}
                      for name, f in result["files"].items()}))
