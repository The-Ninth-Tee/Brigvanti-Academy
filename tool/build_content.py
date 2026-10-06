"""Update the Brigvanti content file from the master workbook.

Usage:
    python tools/build_content.py <workbook.xlsx> [content/brigvanti-content.js]
    python tools/build_content.py <workbook.xlsx> --lang nl

--lang nl writes content/brigvanti-content.nl.js. It starts from the English
content file, so run the English build first. It takes item texts from the
tab Scan Item Bank NL, competence names, level descriptions and proof from
Competency Matrix NL, and domain names from Domains NL. IDs, keys, levels and
competences must match the English file exactly. Roles and activities stay
English in this file, because saved progress refers to them; the app translates
them on screen from content/brigvanti-strings.nl.js.

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
                  r"assessment items|next set of items|as an AI|here is the rewritten|here are the|"
                  r"would you like|would you prefer|shall I|let me know if|should we refine|"
                  r"fully processed|successfully processed|to prep", re.I)
LEVEL_LABEL = re.compile(r"\bL[1-4]\b")
LEAK_NL = re.compile(r"hier zijn de|hieronder volgen|volgende batch|laat me weten|wil je dat ik|"
                     r"vertaalde items|als AI-model|ik heb de", re.I)


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


def matrix_rows(wb, sheet):
    out = {}
    for r in wb[sheet].iter_rows(min_row=2, values_only=True):
        if r[0] and re.fullmatch(r"D\d+\.\d+", str(r[0]).strip()):
            out[str(r[0]).strip()] = r
    return out


def build_nl(xlsx, en_path):
    out_path = en_path.with_name(en_path.name.replace(".js", ".nl.js"))
    data = read_content(en_path)
    wb = openpyxl.load_workbook(xlsx, read_only=True)
    errors, warns = [], []

    # Items: Dutch texts, everything else must equal the English file.
    ws = wb["Scan Item Bank NL"]
    rows = ws.iter_rows(values_only=True)
    header = [clean(h) for h in next(rows)]
    missing = [c for c in COLS if c not in header]
    if missing:
        sys.exit(f"Missing columns in Scan Item Bank NL: {missing}")
    ix = {c: header.index(c) for c in COLS}
    en_bank = read_bank(xlsx)
    nl = {}
    for r in rows:
        iid = clean(r[ix["item_id"]])
        if iid:
            nl[iid] = {c: clean(r[ix[c]]) for c in COLS}
    texts = ("claim (I can...)", "stem", "option_A", "option_B", "option_C", "option_D", "rationale")
    for it in data["items"]:
        iid, g = it["i"], nl.get(it["i"])
        if not g:
            errors.append(f"{iid}: no row in Scan Item Bank NL"); continue
        for c in texts:
            if not g[c]:
                errors.append(f"{iid}: {c} is empty in Dutch")
            elif en_bank.get(iid) and g[c] == en_bank[iid][c]:
                errors.append(f"{iid}: {c} is still the English text")
            if LEAK.search(g[c]) or LEAK_NL.search(g[c]):
                errors.append(f"{iid}: {c} looks like leaked chat text")
            if LEVEL_LABEL.search(g[c]):
                errors.append(f"{iid}: {c} shows a level label. Learners never see level numbers.")
        if g["key"] not in ("A", "B", "C", "D") or "ABCD".index(g["key"]) != it["k"]:
            errors.append(f"{iid}: Dutch key '{g['key']}' differs from the English file")
        if g["competence_id"] != it["c"] or g["form"] != it["f"]:
            errors.append(f"{iid}: competence or form differs from the English file")
        it.update({"cl": g["claim (I can...)"], "s": g["stem"],
                   "o": [g["option_A"], g["option_B"], g["option_C"], g["option_D"]],
                   "w": g["rationale"]})

    # Competences: name, four level descriptions, proof.
    mat = matrix_rows(wb, "Competency Matrix NL")
    for c in data["comps"]:
        m = mat.get(c["id"])
        if not m:
            errors.append(f"{c['id']}: not in Competency Matrix NL"); continue
        name, ld, pf = clean(m[1]), [clean(x) for x in m[5:9]], clean(m[9])
        if not name or not pf:
            errors.append(f"{c['id']}: name or proof is empty in Competency Matrix NL")
        new_ld = []
        for lv, (en_txt, nl_txt) in enumerate(zip(c["ld"], ld), 1):
            if not en_txt:
                new_ld.append("")          # level below the floor stays empty
            elif not nl_txt or nl_txt in ("—", "-"):
                errors.append(f"{c['id']}: level {lv} description is empty in Dutch")
                new_ld.append(en_txt)
            else:
                new_ld.append(nl_txt)
        c.update({"n": name, "ld": new_ld, "pf": pf})

    # Domains: name without the bracketed note, as in the English file.
    for r in wb["Domains NL"].iter_rows(min_row=2, values_only=True):
        if r[0] and str(r[0]).strip().isdigit() and r[1]:
            d = "D" + str(r[0]).strip()
            if d in data["doms"]:
                data["doms"][d] = re.sub(r"\s*\([^)]*\)\s*$", "", clean(r[1]))
    for d, v in data["doms"].items():
        if v == read_content(en_path)["doms"][d]:
            warns.append(f"{d}: domain name is still English")

    # Roles and activities stay English in the data; the app translates them on screen from brigvanti-strings.nl.js.
    if errors:
        print("Nothing written. Fix these first:")
        for e in errors:
            print("  " + e)
        sys.exit(1)
    data["lang"] = "nl"
    data["version"] = datetime.now().strftime("%Y-%m-%d-%H%M")
    write_content(out_path, data)
    print(f"Wrote {out_path}. {len(data['items'])} items, {len(data['comps'])} competences. Version {data['version']}.")
    for w in warns:
        print("  Note: " + w)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    allow_key = "--allow-key-change" in sys.argv
    lang = "nl" if "--lang" in sys.argv and "nl" in sys.argv else "en"
    args = [a for a in args if a != "nl"]
    if not args:
        sys.exit(__doc__)
    xlsx = Path(args[0])
    path = Path(args[1]) if len(args) > 1 else Path("content/brigvanti-content.js")
    if lang == "nl":
        return build_nl(xlsx, path)
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
        for c in ("claim (I can...)", "stem", "option_A", "option_B", "option_C", "option_D", "rationale"):
            m = LEVEL_LABEL.search(g[c])
            if m:
                errors.append(f"{iid}: {c} shows the level label '{m.group(0)}'. Learners never see level numbers.")
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
