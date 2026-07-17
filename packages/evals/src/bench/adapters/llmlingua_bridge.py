#!/usr/bin/env python3
"""LLMLingua-2 bridge for the cycgraph compression benchmark.

Line-delimited JSON server: reads one request per stdin line,
    {"context": "<text>", "target_tokens": <int>}
writes one response per stdout line,
    {"compressed": "<text>"}   or   {"error": "<message>"}

The model loads ONCE per process (it is ~2GB; per-call loading would
dominate benchmark wall-clock). The Node adapter keeps this process alive
for the whole run. EOF on stdin ends the process.

Requires: pip install llmlingua  (npm run bench:setup-llmlingua)
First run downloads microsoft/llmlingua-2-xlm-roberta-large-meetingbank.

Intentionally minimal: default LLMLingua-2 settings, no tuning — the
benchmark compares out-of-the-box behavior on both sides.
"""

import json
import sys


def detect_device() -> str:
    """llmlingua defaults to CUDA; pick what this machine actually has."""
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    from llmlingua import PromptCompressor

    compressor = PromptCompressor(
        model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
        use_llmlingua2=True,
        device_map=detect_device(),
    )
    # Signal readiness so the adapter can distinguish "loading" from "hung".
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            result = compressor.compress_prompt(
                payload["context"],
                target_token=int(payload["target_tokens"]),
                force_tokens=["\n"],
            )
            print(json.dumps({"compressed": result["compressed_prompt"]}), flush=True)
        except Exception as exc:  # noqa: BLE001 — report, keep serving
            print(json.dumps({"error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
