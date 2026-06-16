"""Download one Thorsten-Voice clip as the German F5 reference.

The HF mirror Thorsten-Voice/TV-44kHz-Full ships parquet shards rather
than the GitHub README's claimed LJSpeech layout, so we stream the
22.10 neutral split with `datasets`, filter for a clean declarative
sentence in a target duration band, and write a (wav, txt) pair that
F5-TTS can use as its German reference voice.

Prerequisites on the pod:

    pip install datasets soundfile huggingface_hub

Usage:

    python app/voice/pod/get_thorsten_ref.py            # default: candidate #5
    python app/voice/pod/get_thorsten_ref.py --index 12 # try another voice line
    python app/voice/pod/get_thorsten_ref.py --out-dir /workspace --name ref_de
"""

from __future__ import annotations

import argparse
from pathlib import Path

REPO = "Thorsten-Voice/TV-44kHz-Full"
SPLIT_DIR = "TV-2022.10-Neutral"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", type=int, default=5,
                    help="which matching candidate to use (default: 5)")
    ap.add_argument("--out-dir", default="/workspace",
                    help="where to write <name>.wav + <name>.txt")
    ap.add_argument("--name", default="ref_de",
                    help="basename for the output pair (default: ref_de)")
    ap.add_argument("--min-seconds", type=float, default=6.0)
    ap.add_argument("--max-seconds", type=float, default=10.0)
    args = ap.parse_args()

    # imported lazily so --help is fast and ImportError surfaces with context
    import io
    import soundfile as sf
    from datasets import Audio, load_dataset

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    ds = load_dataset(REPO, data_dir=SPLIT_DIR, split="train", streaming=True)
    # `datasets` decodes audio columns via torchcodec by default, which on
    # this pod fails to load (libnvrtc.so.13 missing under the cu124 driver
    # combo). decode=False ships the raw encoded bytes from parquet so we
    # can hand them to libsndfile-backed soundfile and skip torchcodec.
    ds = ds.cast_column("audio", Audio(decode=False))

    matches = 0
    for row in ds:
        text = (row.get("text") or "").strip()
        dur = row.get("durationSeconds") or 0.0
        if not (
            text.endswith(".")
            and not any(c in text for c in '?!"„"')
            and args.min_seconds <= dur <= args.max_seconds
        ):
            continue
        if matches < 3:
            print(f"  candidate #{matches}: {dur:.2f}s - {text}")
        if matches == args.index:
            audio_bytes = row["audio"]["bytes"]
            data, sample_rate = sf.read(io.BytesIO(audio_bytes))
            wav_path = out_dir / f"{args.name}.wav"
            txt_path = out_dir / f"{args.name}.txt"
            sf.write(wav_path, data, sample_rate)
            txt_path.write_text(text + "\n", encoding="utf-8")
            print(f"\nUsing #{args.index}: {row.get('id', '?')}")
            print(f"  {dur:.2f}s @ {sample_rate} Hz")
            print(f"  {text}")
            print(f"\nSaved {wav_path} + {txt_path}")
            return
        matches += 1

    raise SystemExit(
        f"only {matches} candidates matched - try a wider duration range or lower --index"
    )


if __name__ == "__main__":
    main()
