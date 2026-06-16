"""Fetch the community German F5-TTS checkpoint to the network volume.

Pulls `model_420000.safetensors` (latest iteration) and `vocab.txt` from
`aihpi/F5-TTS-German` and stages them as `/workspace/f5_de/model.safetensors`
+ `/workspace/f5_de/vocab.txt` - the paths voice_pod.py expects by default.

Usage:

    source /workspace/venv/bin/activate
    pip install -q huggingface_hub
    python /workspace/download_f5_de.py            # default: 420k checkpoint
    python /workspace/download_f5_de.py --step 365 # try an earlier iter

Re-running is safe - hf_hub_download caches and only refetches if the
remote LFS hash changed.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO = "aihpi/F5-TTS-German"
AVAILABLE_STEPS = (295, 365, 420)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--step", type=int, default=420, choices=AVAILABLE_STEPS,
        help="checkpoint iteration in thousands (default: 420 = latest)",
    )
    ap.add_argument(
        "--out-dir", default="/workspace/f5_de",
        help="where to stage model.safetensors + vocab.txt",
    )
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ckpt_remote = f"F5TTS_Base/model_{args.step}000.safetensors"
    print(f"fetching {REPO}/{ckpt_remote} (~1.35 GB)...")
    ckpt_src = hf_hub_download(
        repo_id=REPO, filename=ckpt_remote, local_dir=str(out_dir / "_cache"),
    )
    vocab_src = hf_hub_download(
        repo_id=REPO, filename="vocab.txt", local_dir=str(out_dir / "_cache"),
    )

    ckpt_dst = out_dir / "model.safetensors"
    vocab_dst = out_dir / "vocab.txt"
    shutil.copy(ckpt_src, ckpt_dst)
    shutil.copy(vocab_src, vocab_dst)

    print(f"\nstaged:")
    print(f"  {ckpt_dst}  ({ckpt_dst.stat().st_size / 1e9:.2f} GB)")
    print(f"  {vocab_dst} ({vocab_dst.stat().st_size} bytes)")
    print("\nvoice_pod.py picks these up automatically via its default paths.")


if __name__ == "__main__":
    main()
