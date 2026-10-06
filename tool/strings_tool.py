#!/usr/bin/env python3
"""
strings_tool.py - Dutch translation of the app texts (menus, buttons, messages).

Workbook: Brigvanti-UI-Strings.xlsx, tab 'Strings'. Columns: id, screen, type, EN, NL, notes, status.
The English text is the key. The app shows the NL text wherever the EN text appears.

Commands
  python tools/strings_tool.py sync
      Reads the English texts from index.html and adds new ones to the workbook. Existing rows
      are never changed. Rows whose English no longer appears in the app get status 'unused'.
      Needs Node.js once:  npm install acorn acorn-walk   (run inside the tools folder)

  python tools/strings_tool.py export [--batch 60] [--ids S001,S002]
      Copies the next rows without Dutch to the clipboard and to gemini_batch_ui.txt.

  python tools/strings_tool.py merge [reply.txt]
      Reads Gemini's reply (clipboard by default) and writes the Dutch into column NL of a new
      dated copy of the workbook. Status becomes 'translated'.

  python tools/strings_tool.py build
      Writes content/brigvanti-strings.nl.js from every row with Dutch text. Rows with status
      'hold' or 'unused' are left out, so the app shows the English there.

Global option: --file "path/to/Brigvanti-UI-Strings.xlsx"
Requires: pip install openpyxl
"""
import argparse, datetime as dt, glob, json, os, re, subprocess, sys
try:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill
except ImportError:
    sys.exit("openpyxl is missing. Install it with:  pip install openpyxl")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PREFIX = "Brigvanti-UI-Strings"
SHEET = "Strings"
HEAD = ["id", "screen", "type", "EN", "NL", "notes", "status"]
C = {h: i + 1 for i, h in enumerate(HEAD)}
YELLOW = PatternFill(fill_type="solid", fgColor="FFFFFF00")
PH = re.compile(r"\{\d+\}")
TAG = re.compile(r"</?(?:b|strong|i|em)>|<br>")
SCREEN = [(r"^vAccess|signIn|analyticsBar|bar$", "Sign in"), (r"^vStart|modes|AMB|vRoute|both|modeLbl", "Setup"),
          (r"^v(Scan|Claim|Prove|DomDone|Ops)|opts", "Scan"), (r"^vStand|doms|tabs", "Your profile"),
          (r"^v(Practice|Rep)|head|box2|hint|arts|skill$", "Practice"), (r"^v(Rung|GrowScreen)|ru|state|rungArts|COND", "Level up"),
          (r"^vProgress|rows$|badge|BADGE|^[dfn]$", "Your progress"), (r"^vLegal|LEGAL", "Privacy and legal"),
          (r"^vPortfolio|entries|cards|compare|html", "Portfolio"), (r"^vAccount|nameRow|secRows|delRows|doDelete", "Account"),
          (r"toast|err|Err|fail|Fail|send|reset|Reset", "Messages"), (r"TITLE|crumb", "Titles"),
          (r"COND|rung|Rung", "Level up"), (r"Q[0-9A-Z_]*$|quiz|Quiz|intake|Intake", "Setup"),
          (r"aimWord|EX|example|hint", "Practice"), (r"render|leaving|Leaving", "General")]


def screen_of(ctx):
    for pat, name in SCREEN:
        if any(re.search(pat, c.strip()) for c in ctx.split(",")):
            return name
    return "General"


def find_workbook(path=None):
    if path:
        return path
    pool = [p for p in glob.glob(os.path.join(ROOT, PREFIX + "*.xlsx")) + glob.glob(os.path.join(HERE, PREFIX + "*.xlsx"))
            if not os.path.basename(p).startswith("~$")]
    if not pool:
        sys.exit(f"No {PREFIX}*.xlsx found. Use --file.")
    return max(pool, key=os.path.getmtime)


def new_name(wbp):
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    base = re.sub(r"_\d{8}-\d{4}(?:-\d+)?$", "", os.path.splitext(os.path.basename(wbp))[0])
    out, n = os.path.join(os.path.dirname(wbp), f"{base}_{stamp}.xlsx"), 2
    while os.path.exists(out):
        out, n = os.path.join(os.path.dirname(wbp), f"{base}_{stamp}-{n}.xlsx"), n + 1
    return out


def clean(v):
    return "" if v is None else str(v).strip()


def notes_for(en, typ):
    n = []
    if PH.search(en):
        n.append("Keep " + " ".join(sorted(set(PH.findall(en)))) + ". Each is filled in by the app.")
    if TAG.search(en):
        n.append("Keep the tags " + " ".join(sorted(set(TAG.findall(en)))) + ".")
    if typ.startswith("attr:placeholder"):
        n.append("Hint text inside an input field.")
    if typ.startswith("attr:aria"):
        n.append("Read aloud by screen readers.")
    return " ".join(n)


# ---------------------------------------------------------------- extraction
def postprocess(raw):
    """Turn extractor output into final keys: strip block placeholders at the edges, split plurals."""
    out = {}
    for x in raw:
        k = x["key"]
        k = re.sub(r"^\{\d+\}(?=<|[A-Z])", "", k)              # leading block such as {0}Everything...
        k = re.sub(r"(?<=>)\{\d+\}$", "", k)                    # trailing block such as <b>Label</b>{0}
        k = re.sub(r"^[·•★↑→]\s*", "", k.strip())               # the app keeps a leading symbol itself
        m = re.fullmatch(r"<(b|strong|i|em)>([^<]*)</\1>", k)   # a single bold label becomes plain text
        if m:
            k = m.group(2)
        if k in ("Taal / Language", "Nederlands", "English"):   # language switch, shown in both languages
            continue
        keys = [k]
        pl = re.search(r"(?<=[a-z])\{(\d+)\}", k) if x.get("plural") else None   # word{1}: the app adds 's'
        if pl:
            keys = [k[:pl.start()] + k[pl.end():], k[:pl.start()] + "s" + k[pl.end():]]
        for kk in keys:
            i, mp = 0, {}
            def ren(m):
                nonlocal i
                if m.group(1) not in mp:
                    mp[m.group(1)] = i; i += 1
                return "{%d}" % mp[m.group(1)]
            kk = re.sub(r"\{(\d+)\}", ren, kk).strip()
            if not re.search(r"[A-Za-z]{2,}", PH.sub("", TAG.sub("", kk))):
                continue
            e = out.setdefault(kk, {"key": kk, "ctx": set(), "kind": x["kind"], "line": x["line"]})
            e["ctx"].update(c.strip() for c in x["ctx"].split(","))
            if pl:
                e["kind"] = "plural"
    return list(out.values())


def extract(index_html):
    html = open(index_html, encoding="utf-8").read()
    main = max(re.findall(r"<script>(.*?)</script>", html, re.S), key=len)
    tmp_js, tmp_json = os.path.join(HERE, "_main.js"), os.path.join(HERE, "_strings.json")
    open(tmp_js, "w", encoding="utf-8").write(main)
    try:
        subprocess.run(["node", os.path.join(HERE, "extract_strings.js"), tmp_js, tmp_json], check=True, cwd=HERE)
        raw = json.load(open(tmp_json, encoding="utf-8"))
    finally:
        for f in (tmp_js, tmp_json):
            if os.path.exists(f):
                os.remove(f)
    return postprocess(raw)


def content_rows():
    """Roles, topics and activity names. They stay English in the data and are translated on screen."""
    p = os.path.join(ROOT, "content", "brigvanti-content.js")
    t = open(p, encoding="utf-8").read().strip()
    d = json.loads(t[t.index("=") + 1:].rstrip(";"))
    rows = [(r["r"], "Roles", "content:role") for r in d["roles"]]
    rows += [(t, "Topics", "content:topic") for t in dict.fromkeys(a["t"] for a in d["acts"])]
    rows += [(a["a"], "Activities", "content:activity") for a in d["acts"]]
    return rows


def cmd_sync(a):
    items = extract(os.path.join(ROOT, "index.html"))
    found = [(e["key"], screen_of(", ".join(sorted(e["ctx"]))), e["kind"]) for e in sorted(items, key=lambda e: e["line"])]
    found += content_rows()
    path = a.file or (find_workbook() if glob.glob(os.path.join(ROOT, PREFIX + "*.xlsx")) else None)
    if path:
        wb = openpyxl.load_workbook(path); ws = wb[SHEET]
    else:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = SHEET; ws.append(HEAD)
        for c in ws[1]:
            c.font = Font(bold=True)
        for col, w in zip("ABCDEFG", (8, 16, 16, 60, 60, 40, 12)):
            ws.column_dimensions[col].width = w
        ws.freeze_panes = "A2"
    have = {clean(ws.cell(r, C["EN"]).value): r for r in range(2, ws.max_row + 1) if clean(ws.cell(r, C["EN"]).value)}
    nxt = max([int(clean(ws.cell(r, 1).value)[1:]) for r in range(2, ws.max_row + 1) if clean(ws.cell(r, 1).value)[1:].isdigit()] or [0]) + 1
    added, current = 0, set()
    for en, scr, typ in found:
        current.add(en)
        if en in have:
            continue
        ws.append([f"S{nxt:03d}", scr, typ, en, "", notes_for(en, typ), "new"])
        for c in ws[ws.max_row]:
            c.alignment = Alignment(wrap_text=True, vertical="top")
        have[en] = ws.max_row; nxt += 1; added += 1
    unused = 0
    for en, r in have.items():
        if en not in current and clean(ws.cell(r, C["status"]).value) != "unused":
            ws.cell(r, C["status"]).value = "unused"; unused += 1
    out = path and new_name(path) or os.path.join(ROOT, PREFIX + ".xlsx")
    wb.save(out)
    print(f"{len(found)} texts found in the app. Added {added} new rows. Marked {unused} rows unused.\nSaved {os.path.basename(out)}")


# ---------------------------------------------------------------- round trip
def to_clipboard(text):
    try:
        import tkinter
        t = tkinter.Tk(); t.withdraw(); t.clipboard_clear(); t.clipboard_append(text); t.update(); t.destroy(); return True
    except Exception:
        return False


def from_clipboard():
    try:
        import tkinter
        t = tkinter.Tk(); t.withdraw(); s = t.clipboard_get(); t.destroy(); return s
    except Exception:
        sys.exit("Could not read the clipboard. Save Gemini's reply to a .txt file and pass its name instead.")


def rows_of(ws):
    for r in range(2, ws.max_row + 1):
        if clean(ws.cell(r, 1).value):
            yield r


def cmd_export(a):
    wbp = find_workbook(a.file); ws = openpyxl.load_workbook(wbp)[SHEET]
    want = {x.strip() for x in a.ids.split(",")} if a.ids else None
    sel = []
    for r in rows_of(ws):
        rid, st = clean(ws.cell(r, 1).value), clean(ws.cell(r, C["status"]).value)
        if want is not None:
            if rid in want: sel.append(r)
        elif not clean(ws.cell(r, C["NL"]).value) and st != "unused":
            sel.append(r)
    sel = sel[: a.batch]
    if not sel:
        print("Nothing to export."); return
    lines = []
    for r in sel:
        note = clean(ws.cell(r, C["notes"]).value)
        lines.append(f"{clean(ws.cell(r,1).value)} [{clean(ws.cell(r, C['screen']).value)}, {clean(ws.cell(r, C['type']).value)}]"
                     + (f" ({note})" if note else "") + f"\nEN: {clean(ws.cell(r, C['EN']).value)}")
    text = f"Translate these {len(sel)} app texts into Dutch.\n\n" + "\n\n".join(lines) + "\n"
    open(os.path.join(ROOT, "gemini_batch_ui.txt"), "w", encoding="utf-8").write(text)
    print(f"Workbook: {os.path.basename(wbp)}\nExported {len(sel)} texts to gemini_batch_ui.txt"
          + (" and copied to the clipboard." if to_clipboard(text) else "."))


def check(en, nl):
    w = []
    if sorted(PH.findall(en)) != sorted(PH.findall(nl)):
        w.append("placeholders differ from English")
    if sorted(TAG.findall(en)) != sorted(TAG.findall(nl)):
        w.append("tags differ from English")
    if re.search(r"[—–]|\s-\s", nl):
        w.append("dash as punctuation")
    if re.search(r"\b(u|uw)\b", nl, re.I):
        w.append("formal 'u' or 'uw'")
    if re.search(r"\b(hij|zij|hem|haar)\b", nl, re.I):
        w.append("hij/zij/hem/haar: check it does not refer to AI")
    if re.search(r"\bL[1-4]\b", nl):
        w.append("level label L1 to L4")
    if len(en) <= 25 and len(nl) > max(30, len(en) * 1.6):
        w.append(f"much longer than the English ({len(nl)} vs {len(en)} characters); check it fits a button")
    return w


def cmd_merge(a):
    text = open(a.source, encoding="utf-8").read() if a.source else from_clipboard()
    got = {}
    for m in re.finditer(r"^\s*\**(S\d{3,})\**\s*[:\]]?.*?$\s*^\s*NL:\s*(.+)$", text, re.M):
        got[m.group(1)] = m.group(2).strip()
    for m in re.finditer(r"^\s*(S\d{3,})\s*:\s*(?!\[)(.+)$", text, re.M):
        got.setdefault(m.group(1), m.group(2).strip())
    if not got:
        sys.exit("No texts found. Every line must look like 'S001: Nederlandse tekst'.")
    wbp = find_workbook(a.file); wb = openpyxl.load_workbook(wbp); ws = wb[SHEET]
    by = {clean(ws.cell(r, 1).value): r for r in rows_of(ws)}
    rep, written, skipped = [], 0, 0
    for rid, nl in got.items():
        r = by.get(rid)
        if not r:
            skipped += 1; rep.append(f"SKIPPED  {rid}: id not in the workbook"); continue
        en = clean(ws.cell(r, C["EN"]).value)
        if nl == en and re.search(r"[a-z]{3,} [a-z]{3,}", en):
            skipped += 1; rep.append(f"SKIPPED  {rid}: still the English text"); continue
        ws.cell(r, C["NL"]).value = nl; ws.cell(r, C["NL"]).fill = YELLOW
        ws.cell(r, C["status"]).value = "translated"; written += 1
        w = check(en, nl)
        rep.append(f"OK       {rid}: {nl}" + (f"\n         WARNING: {'; '.join(w)}" if w else ""))
    if written:
        out = new_name(wbp); wb.save(out)
        print(f"Written: {written} | skipped: {skipped}\nNew workbook: {os.path.basename(out)}\n")
    else:
        print("Nothing written.\n")
    print("\n".join(rep))


def cmd_build(a):
    wbp = find_workbook(a.file); ws = openpyxl.load_workbook(wbp, read_only=True)[SHEET]
    d, errs, todo = {}, [], 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        rid, en, nl, st = clean(row[0]), clean(row[C["EN"] - 1]), clean(row[C["NL"] - 1]), clean(row[C["status"] - 1])
        if st in ("unused", "hold"):
            continue
        if not nl:
            todo += 1; continue
        w = [x for x in check(en, nl) if x.startswith(("placeholders", "tags"))]
        if w:
            errs.append(f"{rid}: {'; '.join(w)}"); continue
        d[en] = nl
    if errs:
        print("Nothing written. Fix these first:\n  " + "\n  ".join(errs)); sys.exit(1)
    out = os.path.join(ROOT, "content", "brigvanti-strings.nl.js")
    open(out, "w", encoding="utf-8").write("window.BRIG_STRINGS = " + json.dumps(d, ensure_ascii=False, indent=0) + ";\n")
    print(f"Workbook: {os.path.basename(wbp)}\nWrote {out} with {len(d)} texts. Still without Dutch: {todo}.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    fp = argparse.ArgumentParser(add_help=False); fp.add_argument("--file")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sync", parents=[fp])
    e = sub.add_parser("export", parents=[fp]); e.add_argument("--batch", type=int, default=60); e.add_argument("--ids")
    m = sub.add_parser("merge", parents=[fp]); m.add_argument("source", nargs="?")
    sub.add_parser("build", parents=[fp])
    a = p.parse_args()
    {"sync": cmd_sync, "export": cmd_export, "merge": cmd_merge, "build": cmd_build}[a.cmd](a)


if __name__ == "__main__":
    main()
