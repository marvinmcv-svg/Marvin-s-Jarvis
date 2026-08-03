#!/usr/bin/env python3
"""Build a 3D knowledge-galaxy graph from markdown notes.

Standard library only (no pip installs). Scans ./notes for every .md file and
writes ./viewer/graph-data.js containing:

    const GRAPH = {nodes: [...], links: [...]};

Each node carries a numeric `id` equal to its position in the `nodes` array
(later features look nodes up by index). Each node also has a `label` (from the
filename, dashes/underscores -> spaces), its folder as `group`, the relative
`path`, and a ~700-character prose `excerpt`.

Two notes are linked when:
  * one note's body mentions the other's title, or
  * one note contains a [[wikilink]] to the other, or
  * they share a [[wikilink]] target (co-citation).

Run:  python3 build.py
"""

import json
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
NOTES_DIR = BASE / "notes"
OUT_FILE = BASE / "viewer" / "graph-data.js"
EXCERPT_LEN = 700

WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


def title_from_filename(filename):
    """Daily-Opening-Checklist.md -> 'Daily Opening Checklist'."""
    stem = Path(filename).stem
    return stem.replace("-", " ").replace("_", " ").strip()


def normalize(s):
    """Case- and separator-insensitive key for matching titles."""
    return re.sub(r"[-_\s]+", " ", str(s)).strip().lower()


def strip_markdown(text):
    """Reduce markdown to readable prose (for excerpts + mention matching)."""
    # Drop YAML frontmatter.
    text = re.sub(r"\A---\s*\n.*?\n---\s*\n", " ", text, count=1, flags=re.DOTALL)
    # Drop fenced + inline code.
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]*`", " ", text)
    # Drop images; keep link text.
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    # Strip heading / blockquote / list markers.
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s{0,3}>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s{0,3}[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s{0,3}\d+\.\s+", "", text, flags=re.MULTILINE)
    # Drop emphasis markers.
    text = re.sub(r"[*_~]+", "", text)
    # Resolve [[wikilinks]] to readable text (alias, or target with dashes->spaces).
    text = WIKILINK_RE.sub(
        lambda m: (m.group(2) or m.group(1)).replace("-", " ").replace("_", " "),
        text,
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text


def make_excerpt(text, length=EXCERPT_LEN):
    prose = strip_markdown(text)
    if len(prose) <= length:
        return prose
    cut = prose[:length]
    space = cut.rfind(" ")
    if space > length * 0.6:
        cut = cut[:space]
    return cut.rstrip(" ,.;:") + "\u2026"


def extract_wikilink_targets(text):
    return [m.group(1).strip() for m in WIKILINK_RE.finditer(text)]


def scan_nodes():
    md_files = sorted(NOTES_DIR.rglob("*.md"))
    nodes = []
    for idx, fpath in enumerate(md_files):
        rel = fpath.relative_to(NOTES_DIR)
        raw = fpath.read_text(encoding="utf-8", errors="replace")
        label = title_from_filename(fpath.name)
        parent = rel.parent
        group = parent.name if str(parent) != "." else "Notes"
        title_norm = normalize(label)
        wiki_targets = {normalize(t) for t in extract_wikilink_targets(raw)}
        prose_lower = strip_markdown(raw).lower()
        nodes.append({
            "id": idx,
            "label": label,
            "group": group,
            "path": str(rel).replace(os.sep, "/"),
            "excerpt": make_excerpt(raw),
            # private helpers (not serialized):
            "_title_norm": title_norm,
            "_wiki_set": wiki_targets,
            "_prose": prose_lower,
        })
    return nodes


def build_links(nodes):
    links = set()

    def add(a, b):
        if a == b:
            return
        lo, hi = (a, b) if a < b else (b, a)
        links.add((lo, hi))

    for a in nodes:
        a_prose = a["_prose"]
        a_wiki = a["_wiki_set"]
        for b in nodes:
            if a["id"] == b["id"]:
                continue
            b_title = b["_title_norm"]
            if not b_title:
                continue
            # 1) plain-text mention of b's title in a's body.
            pattern = r"\b" + re.escape(b_title) + r"\b"
            if re.search(pattern, a_prose):
                add(a["id"], b["id"])
                continue
            # 2) direct [[wikilink]] from a to b.
            if b_title in a_wiki:
                add(a["id"], b["id"])

    # 3) co-citation: two notes share at least one [[wikilink]] target.
    for i in range(len(nodes)):
        aw = nodes[i]["_wiki_set"]
        if not aw:
            continue
        for j in range(i + 1, len(nodes)):
            if aw & nodes[j]["_wiki_set"]:
                add(nodes[i]["id"], nodes[j]["id"])

    return [{"source": s, "target": t} for (s, t) in sorted(links)]


def main():
    if not NOTES_DIR.exists():
        raise SystemExit("Notes directory not found: %s" % NOTES_DIR)
    nodes = scan_nodes()
    links = build_links(nodes)

    clean_nodes = [
        {
            "id": n["id"],
            "label": n["label"],
            "group": n["group"],
            "path": n["path"],
            "excerpt": n["excerpt"],
        }
        for n in nodes
    ]

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"nodes": clean_nodes, "links": links}
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    # `const GRAPH` keeps the data addressable as a global; the window
    # assignment makes it reliably reachable from an ES module viewer.
    OUT_FILE.write_text(
        "const GRAPH = " + body + ";\n"
        'if (typeof window !== "undefined") { window.GRAPH = GRAPH; }\n',
        encoding="utf-8",
    )

    groups = {}
    for n in clean_nodes:
        groups[n["group"]] = groups.get(n["group"], 0) + 1
    print("Wrote %s" % OUT_FILE)
    print("  nodes: %d   links: %d" % (len(clean_nodes), len(links)))
    print("  groups: %s" % groups)


if __name__ == "__main__":
    main()
