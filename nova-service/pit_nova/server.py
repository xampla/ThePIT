"""
Nova rule engine as a long-lived HTTP service.

Nova (https://github.com/Nova-Hunting/nova-framework) is a Python library
with no server mode, and its embedding model takes seconds to load, so it is
kept warm here and the Node collector calls it in batches.

  GET  /health           -> {ok, rules, semantic, llm, rules_dir}
  GET  /rules            -> rule names, categories, severities, matcher types
  POST /scan             -> {texts: [..], skip_llm?, skip_semantics?}
                            {results: [{matches: [...], warnings: [...]}]}
  POST /reload           -> re-read the rules directory
  POST /rules/update     -> git pull the rule set and reload

Run with --stdio to be managed by the collector instead: one JSON request per
line on stdin ({"id", "op": "scan|health|rules|reload|update", ...}), one JSON
response per line on stdout ({"id", "result"} or {"id", "error"}). Logs go to
stderr only, so stdout stays a clean protocol channel.

Environment:
  NOVA_RULES_DIR   directory scanned recursively for *.nov (default ./rules)
  NOVA_LLM         optional LLM provider: openai|anthropic|azure|ollama|groq|openrouter
  NOVA_LLM_MODEL   optional model override for that provider
  NOVA_SEMANTIC    "0" to skip loading the embedding model (keywords only)
  NOVA_PORT        default 8765
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from nova.core.matcher import NovaMatcher
from nova.core.parser import NovaRuleFileParser
from nova.core.rules import NovaRule

log = logging.getLogger("pit-nova")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
# keep third-party progress bars and chatter off stdout
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

RULES_DIR = Path(os.environ.get("NOVA_RULES_DIR", "rules")).resolve()
LLM = os.environ.get("NOVA_LLM") or None
LLM_MODEL = os.environ.get("NOVA_LLM_MODEL") or None
SEMANTIC = os.environ.get("NOVA_SEMANTIC", "1") != "0"
SKIP_DIRS = {"tests", "validation", ".git"}
SKIP_FILES = {"testrule2.nov", "basic_rule.nov"}
MAX_TEXTS = 64
MAX_TEXT_LEN = 16_000

app = FastAPI(title="pit-nova")


class _NoSemantics:
    """Semantic evaluator that never matches: backs the keywords-only mode."""

    def evaluate(self, pattern: Any, text: str) -> tuple[bool, float]:  # noqa: ARG002
        return False, 0.0

    def evaluate_with_embedding(self, pattern: Any, text_embedding: Any) -> tuple[bool, float]:  # noqa: ARG002
        return False, 0.0


class Engine:
    """Parsed rules plus one matcher per rule, shared across requests."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.rules: list[NovaRule] = []
        self.matchers: list[NovaMatcher] = []
        #: same rules with semantics disabled, for keywords-only scans
        self.kw_matchers: list[NovaMatcher] = []
        self.loaded_at = 0.0
        self.warnings: list[str] = []
        self.llm_evaluator = None
        self.semantic_evaluator = None

    def load(self) -> None:
        parser = NovaRuleFileParser()
        rules: list[NovaRule] = []
        seen: set[str] = set()
        warnings: list[str] = []
        files = sorted(p for p in RULES_DIR.rglob("*.nov") if not (set(p.parts) & SKIP_DIRS) and p.name not in SKIP_FILES)
        for f in files:
            try:
                for r in parser.parse_file(str(f)):
                    if r.name in seen:
                        warnings.append(f"duplicate rule {r.name} in {f.name} skipped")
                        continue
                    seen.add(r.name)
                    rules.append(r)
            except Exception as err:  # noqa: BLE001 - one bad file must not stop the service
                warnings.append(f"{f.name}: {err}")

        if self.llm_evaluator is None and LLM:
            from nova.evaluators.llm import get_validated_evaluator
            self.llm_evaluator = get_validated_evaluator(LLM, model=LLM_MODEL)
        if self.semantic_evaluator is None and SEMANTIC:
            from nova.evaluators.semantics import DefaultSemanticEvaluator
            self.semantic_evaluator = DefaultSemanticEvaluator()

        matchers = [
            NovaMatcher(
                r,
                semantic_evaluator=self.semantic_evaluator,
                llm_evaluator=self.llm_evaluator,
                create_llm_evaluator=False,
            )
            for r in rules
        ]
        kw_matchers = [NovaMatcher(r, semantic_evaluator=_NoSemantics(), llm_evaluator=None, create_llm_evaluator=False) for r in rules]
        with self.lock:
            self.rules, self.matchers, self.kw_matchers, self.warnings, self.loaded_at = rules, matchers, kw_matchers, warnings, time.time()
        log.info("loaded %d rules from %s (%d warnings)", len(rules), RULES_DIR, len(warnings))

    def scan_one(self, text: str, skip_llm: bool, skip_semantics: bool) -> dict[str, Any]:
        matches: list[dict[str, Any]] = []
        warnings: list[str] = []
        with self.lock:
            pairs = list(zip(self.matchers, self.kw_matchers))
        for m, m_kw in pairs:
            rule = m.rule
            use = m_kw if skip_semantics else m
            try:
                res = use.check_prompt(text, skip_llm=skip_llm or self.llm_evaluator is None)
            except Exception as err:  # noqa: BLE001
                warnings.append(f"{rule.name}: {err}")
                continue
            if not res.get("matched"):
                continue
            meta = res.get("meta") or rule.meta or {}
            sem_scores = res.get("semantic_scores") or {}
            matched_sem = res.get("matching_semantics") or []
            matches.append({
                "semantic_score": max((float(sem_scores.get(k, 0)) for k in matched_sem), default=0.0),
                "rule": rule.name,
                "severity": str(meta.get("severity", "medium")).lower(),
                "category": meta.get("category"),
                "description": meta.get("description"),
                "keywords": sorted(res.get("matching_keywords") or []),
                "semantics": sorted(res.get("matching_semantics") or []),
                "llm": sorted(res.get("matching_llm") or []),
                "meta": {k: v for k, v in meta.items() if k in ("author", "version", "uuid", "reference", "date")},
            })
        return {"matches": matches, "warnings": warnings}


engine = Engine()


@lru_cache(maxsize=4096)
def _cached_scan(key: str, text: str, skip_llm: bool, skip_semantics: bool) -> dict[str, Any]:
    return engine.scan_one(text, skip_llm, skip_semantics)


class ScanRequest(BaseModel):
    texts: list[str]
    skip_llm: bool = False
    skip_semantics: bool = False
    #: rule names the operator switched off; Nova's verdict on every other rule is final
    disabled_rules: list[str] = []


def _apply_policy(result: dict[str, Any], req: ScanRequest) -> dict[str, Any]:
    disabled = set(req.disabled_rules)
    return {"matches": [m for m in result["matches"] if m["rule"] not in disabled], "warnings": result["warnings"]}


@app.on_event("startup")
def _startup() -> None:
    engine.load()
    _warm_up()  # first semantic evaluation loads the embedding model; do it before traffic arrives


def _rules_revision() -> dict[str, Any]:
    """Commit and date of the rules checkout, when it is a git clone."""
    try:
        out = subprocess.run(["git", "-C", str(RULES_DIR), "log", "-1", "--format=%h|%cI|%s"], capture_output=True, text=True, timeout=5)
        if out.returncode != 0:
            return {"git": False}
        sha, date, msg = out.stdout.strip().split("|", 2)
        remote = subprocess.run(["git", "-C", str(RULES_DIR), "remote", "get-url", "origin"], capture_output=True, text=True, timeout=5).stdout.strip()
        return {"git": True, "commit": sha, "date": date, "message": msg, "remote": remote}
    except Exception:  # noqa: BLE001
        return {"git": False}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "revision": _rules_revision(),
        "ok": bool(engine.rules),
        "rules": len(engine.rules),
        "semantic": engine.semantic_evaluator is not None,
        "llm": LLM,
        "rules_dir": str(RULES_DIR),
        "loaded_at": engine.loaded_at,
        "warnings": engine.warnings[:20],
        "version": "0.1.0",
    }


@app.get("/rules")
def rules() -> list[dict[str, Any]]:
    return [
        {
            "name": r.name,
            "category": r.meta.get("category"),
            "severity": r.meta.get("severity"),
            "description": r.meta.get("description"),
            "matchers": [k for k, v in (("keywords", r.keywords), ("semantics", r.semantics), ("llm", r.llms)) if v],
            "thresholds": {name: p.threshold for name, p in r.semantics.items() if hasattr(p, "threshold")},
            "condition": r.condition,
        }
        for r in engine.rules
    ]


def run_scan(req: ScanRequest) -> dict[str, Any]:
    out = []
    for t in req.texts[:MAX_TEXTS]:
        t = t[:MAX_TEXT_LEN]
        key = hashlib.sha1(t.encode("utf-8", "ignore")).hexdigest()
        out.append(_apply_policy(_cached_scan(key, t, req.skip_llm, req.skip_semantics), req))
    return {"results": out}


@app.post("/scan")
async def scan(req: ScanRequest) -> dict[str, Any]:
    return await run_in_threadpool(run_scan, req)


@app.post("/reload")
async def reload() -> dict[str, Any]:
    await run_in_threadpool(engine.load)
    _cached_scan.cache_clear()
    return health()


def run_update() -> dict[str, Any]:
    """git pull the community rule set (fast-forward only), then reload."""
    before = _rules_revision()
    res = subprocess.run(["git", "-C", str(RULES_DIR), "pull", "--ff-only"], capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        return {"ok": False, "error": (res.stderr or res.stdout).strip()[-400:], "revision": before}
    engine.load()
    _cached_scan.cache_clear()
    after = _rules_revision()
    return {"ok": True, "changed": before.get("commit") != after.get("commit"), "output": res.stdout.strip()[-400:], "revision": after, "rules": len(engine.rules)}


@app.post("/rules/update")
async def update_rules() -> dict[str, Any]:
    return await run_in_threadpool(run_update)


def _warm_up() -> None:
    if SEMANTIC and engine.matchers:
        t0 = time.time()
        engine.scan_one("warm-up: ignore previous instructions", skip_llm=True, skip_semantics=False)
        log.info("warm-up done in %.1fs", time.time() - t0)


def stdio_main() -> None:
    """Managed mode: the collector owns this process and talks JSON lines over stdin/stdout."""
    # Nova and its dependencies print warnings with plain print(); keep those off the protocol channel.
    out = sys.stdout
    sys.stdout = sys.stderr
    engine.load()
    _warm_up()
    out.write(json.dumps({"ready": True, **health()}) + "\n")
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.get("id")
            op = req.get("op")
            if op == "scan":
                result: Any = run_scan(ScanRequest(**{k: v for k, v in req.items() if k in ScanRequest.model_fields}))
            elif op == "health":
                result = health()
            elif op == "rules":
                result = rules()
            elif op == "reload":
                engine.load(); _cached_scan.cache_clear(); result = health()
            elif op == "update":
                result = run_update()
            else:
                raise ValueError(f"unknown op {op!r}")
            out.write(json.dumps({"id": rid, "result": result}) + "\n")
        except Exception as err:  # noqa: BLE001
            out.write(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "error": str(err)}) + "\n")  # type: ignore[possibly-undefined]
        out.flush()


def main() -> None:
    if "--stdio" in sys.argv:
        stdio_main()
        return
    import uvicorn
    uvicorn.run(app, host=os.environ.get("NOVA_HOST", "127.0.0.1"), port=int(os.environ.get("NOVA_PORT", "8765")), log_level="info")


if __name__ == "__main__":
    main()
