"""Update the Brigvanti content file from the master workbook.

Usage:
    python tools/build_content.py <workbook.xlsx> [content/brigvanti-content.js]

Reads the Scan Item Bank tab. Every row with status AUTHORED replaces the
texts of the matching item in the content file. Competences, activities,
roles and domain names in the content file are left as they are.

The script refuses to write when an item ID is missing, a field is empty,
or an answer key, level or competence differs from the current file. Pass
--allow-key-change to accept key changes on purpose.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import openpyxl

PREFIX = "window.BRIG_CONTENT = "
SHEET = "Scan Item Bank"
COLS = ["item_id", "competence_id", "level", "form", "claim (I can...)", "stem",
        "option_A", "option_B", "option_C", "option_D", "key", "rationale", "status"]
# Phrases a text generator uses when talking to its operator. They never belong in learner text.
LEAK = re.compile(r"next batch|I have successfully|you would like me to|could you specify|"
                  r"assessment items|next set of items|as an AI|here is the rewritten|here are the", re.I)


def read_content(path):
    text = path.read_text(encoding="utf-8").strip()
    if not text.startswith(PREFIX):
        sys.exit(f"{path} does not start with '{PREFIX}'")
    return json.loads(text[len(PREFIX):].rstrip(";"))


def write_content(path, data):
    path.write_text(PREFIX + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")


def clean(v):
    return " ".join(str(v).split()) if v is not None else ""


def read_bank(xlsx):
    ws = openpyxl.load_workbook(xlsx, read_only=True)[SHEET]
    rows = ws.iter_rows(values_only=True)
    header = [clean(h) for h in next(rows)]
    missing = [c for c in COLS if c not in header]
    if missing:
        sys.exit(f"Missing columns in {SHEET}: {missing}")
    ix = {c: header.index(c) for c in COLS}
    bank = {}
    for r in rows:
        if clean(r[ix["status"]]) != "AUTHORED":
            continue
        g = {c: clean(r[ix[c]]) for c in COLS}
        bank[g["item_id"]] = g
    return bank


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    allow_key = "--allow-key-change" in sys.argv
    if not args:
        sys.exit(__doc__)
    xlsx = Path(args[0])
    path = Path(args[1]) if len(args) > 1 else Path("content/brigvanti-content.js")
    data = read_content(path)
    bank = read_bank(xlsx)
    items = {it["i"]: it for it in data["items"]}

    errors, changed, keychg = [], 0, []
    for iid in sorted(set(items) - set(bank)):
        errors.append(f"{iid}: in the app but not AUTHORED in the workbook")
    for iid in sorted(set(bank) - set(items)):
        errors.append(f"{iid}: AUTHORED in the workbook but not in the app")

    for iid, g in bank.items():
        it = items.get(iid)
        if not it:
            continue
        for c in COLS:
            if not g[c]:
                errors.append(f"{iid}: {c} is empty")
        if g["key"] not in "ABCD" or len(g["key"]) != 1:
            errors.append(f"{iid}: key '{g['key']}' is not A to D")
            continue
        if g["competence_id"] != it["c"]:
            errors.append(f"{iid}: competence {g['competence_id']} differs from {it['c']}")
        if g["level"][:2] != f"L{it['l']}":
            errors.append(f"{iid}: level {g['level']} differs from L{it['l']}")
        if g["form"] != it["f"]:
            errors.append(f"{iid}: form {g['form']} differs from {it['f']}")
        for c in ("claim (I can...)", "stem", "rationale"):
            m = LEAK.search(g[c])
            if m:
                errors.append(f"{iid}: {c} looks like leaked chat text near '{m.group(0)}'")
        k = "ABCD".index(g["key"])
        if k != it["k"]:
            keychg.append(iid)
        new = {
            "cl": g["claim (I can...)"],
            "s": g["stem"],
            "o": [g["option_A"], g["option_B"], g["option_C"], g["option_D"]],
            "k": k,
            "w": g["rationale"],
        }
        if any(it[f] != new[f] for f in new):
            changed += 1
        it.update(new)

    if keychg and not allow_key:
        errors.append(f"Answer key changed for {len(keychg)} items: {', '.join(keychg[:10])}. "
                      "Past results on these items would no longer be valid. "
                      "Rerun with --allow-key-change if this is intended.")
    if errors:
        print("Nothing written. Fix these first:")
        for e in errors:
            print("  " + e)
        sys.exit(1)

    data["version"] = datetime.now().strftime("%Y-%m-%d-%H%M")
    write_content(path, data)
    print(f"Wrote {path}. {changed} of {len(items)} items changed. Version {data['version']}.")
    if keychg:
        print(f"Key changes accepted: {', '.join(keychg)}")


if __name__ == "__main__":
    main()
