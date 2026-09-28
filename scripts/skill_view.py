#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

ROLE_NAMES = {"EXPLORER","RESEARCHER","WORKER","INTEGRATOR","TESTER","REVIEWER","CAPABILITY_BOOTSTRAP"}
SCOPE_RE = re.compile(r"^#{1,6}\s+\[(SHARED|CODEX|HARNESS|ROLE:([A-Z_]+))\]\s*$", re.I)

def split_frontmatter(lines: list[str]):
    if not lines or lines[0].strip() != "---": return [], lines
    for i in range(1, min(len(lines), 200)):
        if lines[i].strip() == "---": return lines[:i+1], lines[i+1:]
    return [], lines

def parse_sections(lines: list[str]):
    preamble: list[str] = []
    sections: list[tuple[str,list[str]]] = []
    current_scope = None
    current: list[str] = []
    found = False
    for line in lines:
        m = SCOPE_RE.match(line.strip())
        if m:
            found = True
            if current_scope is None:
                preamble.extend(current)
            else:
                sections.append((current_scope, current))
            current_scope = m.group(1).upper()
            current = [line]
        else:
            current.append(line)
    if current_scope is None:
        preamble.extend(current)
    else:
        sections.append((current_scope, current))
    return found, preamble, sections

def select(text: str, target: str, role: str | None):
    lines = text.splitlines(keepends=True)
    front, body = split_frontmatter(lines)
    scoped, preamble, sections = parse_sections(body)
    if not scoped:
        if target == "codex":
            return "".join(front) + ("\n" if front else "") + "[LEGACY HARNESS SKILL: execution body intentionally omitted from Codex view]\n"
        return text
    wanted = {"SHARED"}
    if target == "codex": wanted.add("CODEX")
    else:
        wanted.add("HARNESS")
        if role: wanted.add(f"ROLE:{role}")
    chunks = ["".join(front)] if front else []
    # Preamble may contain title/summary but not execution-scoped body.
    if preamble:
        chunks.append("".join(preamble))
    for scope, content in sections:
        if scope in wanted:
            chunks.append("".join(content))
    return "".join(chunks)

def main():
    ap = argparse.ArgumentParser(description="Extract a role-scoped view from cross-runtime-skill/v1 Markdown without exposing unrelated sections.")
    ap.add_argument("--file", required=True)
    ap.add_argument("--target", choices=["codex","harness"], required=True)
    ap.add_argument("--role", help="Harness role when --target=harness")
    ap.add_argument("--json", action="store_true", help="Return JSON with selected text and basic metadata")
    ns = ap.parse_args()
    path = Path(ns.file).expanduser().resolve()
    if not path.is_file(): raise SystemExit(f"Skill file not found: {path}")
    data = path.read_bytes()
    if len(data) > 512*1024: raise SystemExit("Skill file exceeds 512 KiB")
    text = data.decode("utf-8")
    role = ns.role.upper() if ns.role else None
    if role and role not in ROLE_NAMES: raise SystemExit(f"Unsupported role: {role}")
    selected = select(text, ns.target, role)
    if ns.json:
        import hashlib
        print(json.dumps({"path":str(path),"target":ns.target,"role":role,"sha256":hashlib.sha256(data).hexdigest(),"selectedText":selected}, ensure_ascii=False))
    else:
        sys.stdout.write(selected)

if __name__ == "__main__": main()
