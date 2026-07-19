"""
Generate a 1000-sentence Polish eval-audio batch via Qwen3-TTS — a deliberately EXPERIMENTAL,
unsupported-language attempt, for the user's own side-by-side comparison against the real
Polish voices in scripts/tts-piper-1000.py.

Qwen3-TTS's own documented language support is 10 languages (Chinese, English, Japanese,
Korean, German, French, Russian, Portuguese, Spanish, Italian) — Polish is not among them,
confirmed before writing this script rather than assumed. This script tries anyway, in two
steps per clip: first an explicit `language="Polish"` (the literal untested case), and if the
model rejects or errors on that, a `language="Auto"` retry (letting the model's own language
auto-detection read the Polish text directly, per Qwen3-TTS's own documented auto-adaptive
mode) — recording which path actually produced each clip's audio, and giving up on a clip
(recording an error, not crashing the batch) only if both fail.

Because the *output* language is what's being tested here — not accent-on-English the way
tts-qwen-1000.py's own profiles describe — every persona below is framed as a Polish-speaking
voice (age/gender/tone/pace only), not "X-accented English"; an accent dimension doesn't mean
anything for a question this script doesn't yet know the answer to (can Qwen produce
intelligible Polish at all).

Resumable + atomic manifest checkpoint, same conventions as tts-piper-1000.py and (this same
session) the fix applied to scripts/asr-transcribe-manifest.mjs.

Usage: python scripts/tts-qwen-1000-pl.py <sentences.json> <out_dir>
"""

import json
import os
import sys
import time
from pathlib import Path

import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

# VoiceDesign profiles: (tag, instruct) — age/gender + emotion + pace, no accent dimension
# (see module doc comment for why). A smaller pool than tts-qwen-1000.py's 47 — this is an
# experimental side-comparison, not the main 1000-clip event, so profile-repetition rate
# matters less than getting a real Athena run of this comparison at all.
VOICE_DESIGN_PROFILES = [
    ("pl-female-calm", "Polish, young adult female voice, calm and measured, unhurried pace."),
    ("pl-male-excited", "Polish, young adult male voice, excited and enthusiastic, fast pace."),
    ("pl-elderly-male-formal", "Polish, elderly male voice, formal and deliberate, slow pace."),
    ("pl-female-tired", "Polish, middle-aged female voice, sounding tired and a little bored, slow pace."),
    ("pl-male-confident", "Polish, middle-aged male voice, confident and brisk pace."),
    ("pl-female-cheerful", "Polish, young adult female voice, cheerful and warm, medium pace."),
    ("pl-male-casual", "Polish, young adult male voice, casual and relaxed, medium pace."),
    ("pl-female-curious", "Polish, young adult female voice, curious and inquisitive tone, medium pace."),
    ("pl-male-serious", "Polish, middle-aged male voice, serious and formal, measured pace."),
    ("pl-female-brisk", "Polish, young adult female voice, brisk and businesslike, fast pace."),
    ("pl-male-warm", "Polish, middle-aged male voice, warm and confident, medium pace."),
    ("pl-female-formal", "Polish, adult female voice, formal and precise, measured pace."),
    ("pl-male-hurried", "Polish, young adult male voice, hurried and slightly stressed, fast pace."),
    ("pl-female-relaxed", "Polish, young adult female voice, relaxed and easygoing, slow pace."),
    ("pl-male-neutral", "Polish, adult male voice, neutral and clear, medium pace."),
    ("pl-female-elegant", "Polish, adult female voice, elegant and articulate, medium pace."),
    ("pl-male-skeptical", "Polish, adult male voice, skeptical and dry, measured pace."),
    ("pl-elderly-female-sleepy", "Polish, elderly female voice, sleepy and soft, slow pace."),
    ("pl-teen-nervous", "Polish, teenage female voice, nervous and hesitant, slightly halting pace."),
    ("pl-female-stressed", "Polish, adult female voice, stressed and rushed, fast pace."),
]

# Same three surviving CustomVoice presets as tts-qwen-1000.py (issue #83/#92 kept only the
# ones that never showed up in a "worst 10" list) — untested whether a fixed English-trained
# speaker embedding can produce Polish output at all via `language`; kept in purely for the
# comparison data point, not because it's expected to work better than VoiceDesign. Tuples are
# (tag, speaker, instruct) — 3 elements, same arity as tts-qwen-1000.py's own — so
# `synthesize_one`'s `len(rest) == 1` check actually distinguishes these from the 2-element
# VoiceDesign entries above (a 2-element `(tag, speaker)` here collapsed `rest` to length 1,
# indistinguishable from VoiceDesign, so every "custom-*" clip silently went through
# `generate_voice_design` with the bare name as `instruct` instead of `generate_custom_voice`
# — caught by inspecting the completed run's manifest, see docs/tts-eval-1000-pl.md).
CUSTOM_VOICE_PROFILES = [
    ("custom-ryan", "Ryan", "Very happy and upbeat."),
    ("custom-aiden", "Aiden", "Curious, asking as if genuinely wondering."),
    ("custom-eric", "Eric", "Hurried, slightly rushed delivery."),
]

VOICE_POOL = VOICE_DESIGN_PROFILES + CUSTOM_VOICE_PROFILES


def stable_hash(s: str) -> int:
    """Deterministic 32-bit FNV-1a hash — same helper as tts-qwen-1000.py's own copy."""
    h = 2166136261
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def synthesize_one(vd_model, cv_model, tag, rest, text, lang):
    """One synthesis attempt at a given `lang` value ("Polish" or "Auto"). May raise."""
    if len(rest) == 1:
        (instruct,) = rest
        wavs, sr = vd_model.generate_voice_design(text=text, language=lang, instruct=instruct)
        return wavs, sr, {"engine": "VoiceDesign", "profile": tag, "instruct": instruct}
    speaker, instruct = rest
    wavs, sr = cv_model.generate_custom_voice(text=text, language=lang, speaker=speaker, instruct=instruct)
    return wavs, sr, {"engine": "CustomVoice", "profile": tag, "speaker": speaker, "instruct": instruct}


def synthesize(vd_model, cv_model, tag, rest, text):
    """Try language="Polish" first (the literal untested case); fall back to "Auto" (the
    model's own documented language auto-detection, reading the Polish text directly) if that
    raises. Records which path actually worked so the comparison data distinguishes them."""
    try:
        wavs, sr, info = synthesize_one(vd_model, cv_model, tag, rest, text, "Polish")
        return wavs, sr, {**info, "langMode": "Polish"}
    except Exception as e:
        first_err = str(e)
    wavs, sr, info = synthesize_one(vd_model, cv_model, tag, rest, text, "Auto")
    return wavs, sr, {**info, "langMode": "Auto", "polishModeError": first_err}


def main():
    # See tts-qwen-1000.py's identical comment: stdout is fully block-buffered when not a TTY.
    sys.stdout.reconfigure(line_buffering=True)

    sentences_path, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    sentences = json.loads(Path(sentences_path).read_text())

    manifest_path = out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())["clips"] if manifest_path.exists() else []
    done_ids = {c["id"] for c in manifest}
    remaining = [s for s in sentences if s["id"] not in done_ids]
    print(f"{len(done_ids)} already done, {len(remaining)} remaining of {len(sentences)}")
    if not remaining:
        print("nothing to do")
        return

    print(f"cuda available: {torch.cuda.is_available()}")
    vd_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0", dtype=torch.bfloat16
    )
    cv_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", device_map="cuda:0", dtype=torch.bfloat16
    )

    t_start = time.time()
    n_failed = 0
    for i, item in enumerate(remaining):
        sid, text = item["id"], item["text"]
        seed = stable_hash(sid)
        tag, *rest = VOICE_POOL[seed % len(VOICE_POOL)]

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

        t0 = time.time()
        try:
            wavs, sr, voice_info = synthesize(vd_model, cv_model, tag, rest, text)
        except Exception as e:
            # Both "Polish" and "Auto" failed for this clip — record and move on rather than
            # losing the rest of the batch to one bad clip (genuinely unknown territory, so
            # some failure rate here is expected, not a bug to chase).
            n_failed += 1
            manifest.append(
                {
                    "id": sid,
                    "text": text,
                    "quantity": item.get("quantity"),
                    "multi": item.get("multi"),
                    "slotTruth": item.get("slotTruth"),
                    "seed": seed,
                    "profile": tag,
                    "error": str(e),
                }
            )
            tmp_path = manifest_path.with_suffix(".json.tmp")
            tmp_path.write_text(json.dumps({"voicePool": [p[0] for p in VOICE_POOL], "clips": manifest}, indent=2))
            os.replace(tmp_path, manifest_path)
            print(f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({tag}) FAILED: {e}")
            continue
        gen_s = time.time() - t0
        dur_s = len(wavs[0]) / sr

        sf.write(str(out_dir / f"{sid}.wav"), wavs[0], sr, subtype="PCM_16")

        manifest.append(
            {
                "id": sid,
                "text": text,
                "quantity": item.get("quantity"),
                "multi": item.get("multi"),
                "slotTruth": item.get("slotTruth"),
                "gen_s": round(gen_s, 2),
                "dur_s": round(dur_s, 2),
                "seed": seed,
                **voice_info,
            }
        )
        # Atomic checkpoint — see tts-piper-1000.py's identical comment.
        tmp_path = manifest_path.with_suffix(".json.tmp")
        tmp_path.write_text(json.dumps({"voicePool": [p[0] for p in VOICE_POOL], "clips": manifest}, indent=2))
        os.replace(tmp_path, manifest_path)

        elapsed = time.time() - t_start
        rate = elapsed / (i + 1)
        eta_min = rate * (len(remaining) - i - 1) / 60
        print(
            f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({tag}, {voice_info['langMode']}) "
            f"gen={gen_s:.1f}s dur={dur_s:.1f}s  avg={rate:.1f}s/clip  eta={eta_min:.0f}min"
        )

    total = time.time() - t_start
    print(f"\nDone: {len(remaining)} attempted in {total:.1f}s, {n_failed} failed entirely")
    print(f"manifest now has {len(manifest)} total clips at {manifest_path}")


if __name__ == "__main__":
    main()
