#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

PY_TARGETS=(
  "slrr_campaigns"
  "scripts/authorize_user.py"
  "scripts/check_config.py"
  "tests/live"
)

echo "[1/9] ruff check"
.venv/bin/ruff check \
  --select F,E,W,B,ERA,ARG,T20,BLE,PIE,SIM,RET,UP,RUF \
  "${PY_TARGETS[@]}"

echo "[2/9] ruff format --check"
.venv/bin/ruff format --check "${PY_TARGETS[@]}"

echo "[3/9] mypy --strict"
.venv/bin/mypy --strict "${PY_TARGETS[@]}"

echo "[4/9] vulture --min-confidence 60"
.venv/bin/vulture \
  slrr_campaigns \
  scripts/authorize_user.py \
  scripts/check_config.py \
  --min-confidence 60 \
  --ignore-decorators "@app.*"

echo "[5/9] deptry"
.venv/bin/deptry .

echo "[6/9] banned-pattern, stub-body, and emoji scan"
.venv/bin/python - <<'PY'
from __future__ import annotations

import ast
import re
import subprocess
import sys
from pathlib import Path

emoji_re = re.compile(
    "["
    "\U0001f1e0-\U0001f1ff"
    "\U0001f300-\U0001f5ff"
    "\U0001f600-\U0001f64f"
    "\U0001f680-\U0001f6ff"
    "\U0001f700-\U0001f77f"
    "\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff"
    "\U0001f900-\U0001f9ff"
    "\U0001fa00-\U0001fa6f"
    "\U0001fa70-\U0001faff"
    "\u2600-\u26ff"
    "\u2700-\u27bf"
    "\ufe0f"
    "\u200d"
    "]+",
)

root = Path.cwd()
words = [
    "T" + "ODO",
    "F" + "IXME",
    "X" + "XX",
    "H" + "ACK",
    "NotImplemented" + "Error",
    "m" + "ock",
    "f" + "ake",
    "d" + "ummy",
    "l" + "orem",
    "place" + "holder",
]
word_re = re.compile(r"\b(?:" + "|".join(words) + r")\b", re.IGNORECASE)
domain_re = re.compile(r"example" + r"\.com", re.IGNORECASE)

scan_files: list[Path] = [
    *sorted((root / "slrr_campaigns").glob("*.py")),
    root / "scripts" / "authorize_user.py",
    root / "scripts" / "check_config.py",
    *sorted((root / "tests" / "live").glob("*.py")),
    root / "Dockerfile.campaigns",
    root / "config" / "campaigns.yaml",
    root / "setup.sh",
]

failures: list[str] = []

for path in scan_files:
    if not path.is_file():
        failures.append(f"Missing expected file for scan: {path}")
        continue
    text = path.read_text(encoding="utf-8")
    rel = path.relative_to(root)
    for lineno, line in enumerate(text.splitlines(), start=1):
        m_word = word_re.search(line)
        if m_word:
            failures.append(f"{rel}:{lineno}: banned token '{m_word.group(0)}'")
        if domain_re.search(line):
            failures.append(f"{rel}:{lineno}: banned domain")
        m_emoji = emoji_re.search(line)
        if m_emoji:
            cp = ord(m_emoji.group(0)[0])
            failures.append(f"{rel}:{lineno}: emoji code point U+{cp:04X}")

    if path.suffix == ".py":
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                body = list(node.body)
                if (
                    body
                    and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)
                ):
                    body = body[1:]
                if len(body) == 1 and (
                    isinstance(body[0], ast.Pass)
                    or (
                        isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and body[0].value.value is Ellipsis
                    )
                ):
                    failures.append(
                        f"{rel}:{node.lineno}: empty pass/ellipsis body on '{node.name}'",
                    )

# Also scan check.sh excluding only the concatenated token definitions above.
check_sh = root / "check.sh"
for lineno, line in enumerate(check_sh.read_text(encoding="utf-8").splitlines(), start=1):
    if "+" in line and ('"' in line or "'" in line):
        continue
    m_word = word_re.search(line)
    if m_word:
        failures.append(f"check.sh:{lineno}: banned token '{m_word.group(0)}'")
    if domain_re.search(line):
        failures.append(f"check.sh:{lineno}: banned domain")
    m_emoji = emoji_re.search(line)
    if m_emoji:
        cp = ord(m_emoji.group(0)[0])
        failures.append(f"check.sh:{lineno}: emoji code point U+{cp:04X}")

# Scan every line added by this build to apps-script-chat-bot.
base_ref = "ff40004"
verify_proc = subprocess.run(
    ["git", "rev-parse", "--verify", "--quiet", base_ref],
    check=False,
    capture_output=True,
    text=True,
)
if verify_proc.returncode != 0:
    root_proc = subprocess.run(
        ["git", "rev-list", "--max-parents=0", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    base_ref = root_proc.stdout.splitlines()[0].strip()
diff_proc = subprocess.run(
    ["git", "diff", base_ref, "--", "apps-script-chat-bot"],
    check=True,
    capture_output=True,
    text=True,
)
cur_file = ""
for raw_line in diff_proc.stdout.splitlines():
    if raw_line.startswith("+++ b/"):
        cur_file = raw_line[6:]
        continue
    if raw_line.startswith("+") and not raw_line.startswith("+++"):
        added = raw_line[1:]
        m_word = word_re.search(added)
        if m_word:
            failures.append(f"{cur_file} (added line): banned token '{m_word.group(0)}'")
        if domain_re.search(added):
            failures.append(f"{cur_file} (added line): banned domain")
        m_emoji = emoji_re.search(added)
        if m_emoji:
            cp = ord(m_emoji.group(0)[0])
            failures.append(f"{cur_file} (added line): emoji code point U+{cp:04X}")

if failures:
    for item in failures:
        sys.stderr.write(f"SCAN FAIL: {item}\n")
    raise SystemExit(1)
print("Banned-pattern, stub-body, and emoji scan passed with 0 findings.")
PY

echo "[7/9] scripts/check_config.py"
.venv/bin/python -m scripts.check_config

echo "[8/9] shellcheck"
.venv/bin/shellcheck setup.sh check.sh

echo "[9/9] Apps Script ESLint and unit suite"
ESLINT_BIN="${ROOT}/.local/eslint/node_modules/.bin/eslint"
if [[ ! -x "${ESLINT_BIN}" ]]; then
  echo "Missing ${ESLINT_BIN}; install eslint in .local/eslint first." >&2
  exit 1
fi

.venv/bin/python - <<'PY'
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path.cwd()
eslint_bin = root / ".local" / "eslint" / "node_modules" / ".bin" / "eslint"
gs_files = sorted((root / "apps-script-chat-bot").glob("*.gs"))
touched = {"CampaignHandoff.gs", "Bot.gs", "Relay.gs"}

combined_lines: list[str] = []
ranges: list[tuple[int, int, str]] = []
cursor = 1
for gs in gs_files:
    lines = gs.read_text(encoding="utf-8").splitlines()
    start = cursor
    end = cursor + len(lines) - 1
    ranges.append((start, end, gs.name))
    combined_lines.extend(lines)
    cursor = end + 1

with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=True) as tmp:
    tmp.write("\n".join(combined_lines) + "\n")
    tmp.flush()
    proc = subprocess.run(
        [
            str(eslint_bin),
            "--no-eslintrc",
            "--parser-options=ecmaVersion:2022",
            "--rule",
            "no-unused-vars: error",
            "--rule",
            "no-unreachable: error",
            "--format",
            "json",
            tmp.name,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    report = json.loads(proc.stdout or "[]")

hits: list[str] = []
for entry in report:
    for msg in entry.get("messages") or []:
        ln = int(msg.get("line") or 0)
        for start, end, fname in ranges:
            if start <= ln <= end and fname in touched:
                local_ln = ln - start + 1
                hits.append(f"apps-script-chat-bot/{fname}:{local_ln}: {msg.get('ruleId')} {msg.get('message')}")
if hits:
    for h in hits:
        sys.stderr.write(f"ESLINT FAIL: {h}\n")
    raise SystemExit(1)
print("Apps Script ESLint passed with 0 findings.")
PY

node apps-script-chat-bot/test/run_tests.js >/dev/null
echo "ALL CHECKS PASSED (0 findings)."
