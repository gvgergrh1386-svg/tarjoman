#!/usr/bin/env python3
"""Measure TRANSLATION QUALITY — the one thing the other 429 checks do not.

WHY THIS EXISTS
───────────────
Every prompt decision in this project's history was made by eye: the v8 tweet
rewrite, retiring «خخخ», raising the thinking floor to `low`, temperature 0.3.
Each was probably right, and not one of them was measured. So the question
that matters most here — "did that change make translations better or worse?"
— had no answer, and a silent regression in the date engine or the anime
credit labels could ship without anything going red.

This runs the SHIPPED pipeline over a curated corpus and scores two things
that are deliberately kept apart:

  CONTRACT   binary, machine-checkable promises: every ⟦n⟧ token survives,
             @mentions are untouched, a Gregorian date returns with its Jalali
             equivalent, ED in a staff list is «کارگردان قسمت», the output is
             actually Persian. These regress silently and need no judge.

  FLUENCY    (--judge) a second model reads the same outputs and rates natural
             Persian, register and freedom from calques, 1-5.

Keeping them separate is the point: you can prove a prompt change improved
style WITHOUT it quietly breaking an entity rule, because the two numbers move
independently.

Scorecards are written to dev/eval/_runs/ so two runs can be diffed — which is
what makes this an instrument rather than a report.

USAGE
  set GEMINI_KEY=AIza...
  python dev/eval/run_eval.py
  python dev/eval/run_eval.py --model gemini-3.5-flash-lite
  python dev/eval/run_eval.py --judge
  python dev/eval/run_eval.py --compare _runs/a.json _runs/b.json

The key is never written to disk and never appears in a scorecard.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "dev" / "e2e"))
sys.path.insert(0, str(ROOT / "dev"))
import cdp  # noqa: E402
from run_harness import QuietHandler, find_chrome, free_port  # noqa: E402

RUNS = HERE / "_runs"

JUDGE_PROMPT = """You are a senior Persian (Farsi) editor grading machine translation.

For each item you receive the SOURCE and a Persian TRANSLATION. Score the
translation on three axes, each 1-5:

  fluency  5 = reads as though written in Persian by a native speaker
           3 = understandable but visibly translated
           1 = broken or unreadable
  register 5 = tone matches the source exactly (formal stays formal, a joke
               stays a joke, sarcasm stays sarcasm)
           1 = tone destroyed
  fidelity 5 = meaning complete and exact
           1 = meaning changed, added or lost

Judge ONLY these. Do not reward or punish the presence of Latin names, @handles,
hashtags or ⟦n⟧ placeholders — those are required by the system and are checked
separately.

Return ONLY a JSON array, one object per item, in the order given:
[{"id": "...", "fluency": 5, "register": 4, "fidelity": 5, "note": "short reason"}]
"""


def serve(root: Path):
    port = free_port()
    handler = functools.partial(QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def collect_eval(ws, url: str, budget: float):
    """Drive the eval page and return its console output.

    A generous budget: this makes REAL API calls, one per corpus item, and a
    thinking model on a busy free tier is not fast. A run that is still working
    must not be killed and reported as a failure.
    """
    target = ws.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    session = ws.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    ws.call("Runtime.enable", {}, session=session)
    ws.call("Page.enable", {}, session=session)
    ws.call("Page.navigate", {"url": url}, session=session)

    lines: list[str] = []
    data = None
    summary = None
    deadline = time.time() + budget
    ws.sock.settimeout(1.0)
    while time.time() < deadline and summary is None:
        try:
            raw = ws.recv()
        except (TimeoutError, OSError):
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if msg.get("method") != "Runtime.consoleAPICalled" or msg.get("sessionId") != session:
            continue
        for arg in msg["params"].get("args", []):
            text = arg.get("value")
            if not isinstance(text, str) or not text.startswith("GXT-EVAL"):
                continue
            if text.startswith("GXT-EVAL-DATA "):
                try:
                    data = json.loads(text[len("GXT-EVAL-DATA "):])
                except ValueError:
                    pass
            elif text.startswith("GXT-EVAL SUMMARY"):
                summary = text
            else:
                lines.append(text)
                print(f"  {text}")
    ws.sock.settimeout(30.0)
    try:
        ws.call("Target.closeTarget", {"targetId": target})
    except Exception:  # noqa: BLE001
        pass
    return lines, data, summary


def judge(key: str, model: str, corpus: dict, outputs: dict) -> dict | None:
    """Ask a model to rate fluency/register/fidelity of what came back.

    Deliberately a DIFFERENT call from the translation, with the source beside
    the output: a model asked to grade its own work in the same breath grades
    the continuation it already committed to, not the text.
    """
    items = [
        {"id": item["id"], "source": item["text"], "translation": outputs.get(item["id"], "")}
        for item in corpus["items"]
        if outputs.get(item["id"])
    ]
    if not items:
        return None
    body = {
        "systemInstruction": {"parts": [{"text": JUDGE_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": json.dumps(items, ensure_ascii=False)}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 4096},
    }
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent"
    )
    request = urllib.request.Request(  # noqa: S310
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"  judge unavailable: {exc}")
        return None
    try:
        text = payload["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return None
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < 0:
        return None
    try:
        scored = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return {entry.get("id"): entry for entry in scored if isinstance(entry, dict)}


def compare(a_path: Path, b_path: Path) -> int:
    """Diff two scorecards item by item — the reason this tool exists."""
    a = json.loads(a_path.read_text(encoding="utf-8"))
    b = json.loads(b_path.read_text(encoding="utf-8"))
    print(f"A  {a_path.name}  {a['model']}  contract {a['passed']}/{a['total']}")
    print(f"B  {b_path.name}  {b['model']}  contract {b['passed']}/{b['total']}")
    print("-" * 66)
    ids = sorted(set(a.get("perItem", {})) | set(b.get("perItem", {})))
    regressions, fixes = [], []
    for item_id in ids:
        pa = a.get("perItem", {}).get(item_id)
        pb = b.get("perItem", {}).get(item_id)
        if pa == pb:
            continue
        if pa and not pb:
            regressions.append(item_id)
        elif pb and not pa:
            fixes.append(item_id)
    for item_id in fixes:
        print(f"  FIXED       {item_id}")
    for item_id in regressions:
        print(f"  REGRESSED   {item_id}")
    if not fixes and not regressions:
        print("  contract identical")
    ja, jb = a.get("judge"), b.get("judge")
    if ja and jb:
        def mean(scores, axis):
            vals = [s.get(axis, 0) for s in scores.values() if isinstance(s, dict)]
            return sum(vals) / len(vals) if vals else 0
        print("-" * 66)
        for axis in ("fluency", "register", "fidelity"):
            print(f"  {axis:9} A {mean(ja, axis):.2f}   B {mean(jb, axis):.2f}")
    return 1 if regressions else 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="gemini-3.6-flash")
    ap.add_argument("--judge", action="store_true", help="also score fluency with a judge model")
    ap.add_argument("--judge-model", default="gemini-3.6-flash")
    ap.add_argument("--only", default="", help="one item id, or one kind (tweet/generic/subtitle)")
    ap.add_argument("--label", default="", help="name for the scorecard file")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"))
    ap.add_argument("--budget", type=float, default=600.0)
    args = ap.parse_args()

    if args.compare:
        return compare(Path(args.compare[0]), Path(args.compare[1]))

    key = os.environ.get("GEMINI_KEY") or os.environ.get("GXT_KEY") or ""
    if not key:
        print("No API key. Set GEMINI_KEY first:")
        print("    set GEMINI_KEY=AIza...")
        return 2

    chrome = find_chrome()
    if not chrome:
        print("Chrome not found")
        return 2

    corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    server, port = serve(ROOT)
    profile = Path(tempfile.mkdtemp(prefix="gxt-eval-"))
    debug_port = free_port()
    proc = subprocess.Popen(
        [str(chrome), f"--user-data-dir={profile}", f"--remote-debugging-port={debug_port}",
         "--headless=new", "--no-first-run", "--no-default-browser-check",
         "--disable-background-networking", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws = None
    deadline = time.time() + 30
    while time.time() < deadline and ws is None:
        try:
            ws = cdp.WS(cdp.browser_ws(debug_port))
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    if ws is None:
        print("no DevTools endpoint")
        proc.terminate()
        return 1

    print(f"model: {args.model}   items: {len(corpus['items'])}")
    print("-" * 66)
    try:
        url = (
            f"http://127.0.0.1:{port}/dev/eval/eval.html"
            f"?key={key}&model={args.model}&only={args.only}&t={int(time.time())}"
        )
        lines, data, summary = collect_eval(ws, url, budget=args.budget)
    finally:
        ws.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    if not data:
        print("no result — the run produced nothing (key rejected? offline?)")
        return 1

    per_item = {}
    for line in lines:
        if line.startswith("GXT-EVAL PASS "):
            per_item[line[len("GXT-EVAL PASS "):].strip()] = True
        elif line.startswith("GXT-EVAL FAIL "):
            per_item[line[len("GXT-EVAL FAIL "):].split(" :: ")[0].strip()] = False

    scorecard = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": args.model,
        "passed": data["passed"],
        "total": data["total"],
        "perItem": per_item,
        "outputs": data.get("outputs", {}),
        "failures": data.get("failures", []),
    }

    print("-" * 66)
    print(f"CONTRACT  {data['passed']}/{data['total']}")

    if args.judge:
        print("judging fluency…")
        scores = judge(key, args.judge_model, corpus, data.get("outputs", {}))
        if scores:
            scorecard["judge"] = scores
            for axis in ("fluency", "register", "fidelity"):
                vals = [s.get(axis, 0) for s in scores.values() if isinstance(s, dict)]
                if vals:
                    print(f"{axis.upper():9} {sum(vals) / len(vals):.2f} / 5")
            worst = sorted(
                (s for s in scores.values() if isinstance(s, dict)),
                key=lambda s: s.get("fluency", 5) + s.get("register", 5),
            )[:3]
            for entry in worst:
                print(f"  weakest: {entry.get('id')} — {entry.get('note', '')}")

    RUNS.mkdir(parents=True, exist_ok=True)
    label = args.label or f"{args.model}-{time.strftime('%Y%m%d-%H%M%S')}"
    path = RUNS / f"{label}.json"
    path.write_text(json.dumps(scorecard, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"scorecard: {path}")
    print("compare two runs:  python dev/eval/run_eval.py --compare <A.json> <B.json>")
    return 0 if data["passed"] == data["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
