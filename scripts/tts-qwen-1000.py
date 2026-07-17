"""
Generate the 1000-sentence Qwen3-TTS eval-audio batch (issue #30, second scale-up).

Reads the validated 1000 sentences (every one confirmed by scripts/tts-sentence-check.ts
to produce a correct intent + a real libdedx number — see scripts/generate-1000-sentences.mjs)
and synthesizes each with a deterministically round-robin-assigned voice profile from an
expanded pool (docs/tts-eval-audio.md §7.7 recommended growing the 30-profile pool before
scaling 10x further, to avoid each voice repeating ~33 times).

Resumable: writes the manifest after every clip and skips any <id>.wav that already exists
on disk, so a dropped connection mid-run (this project has hit that once already) costs only
the time since the last completed clip, not the whole batch.

Usage: python scripts/tts-qwen-1000.py <sentences.json> <out_dir>
"""
import json
import sys
import time
from pathlib import Path

import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

# VoiceDesign profiles: (tag, instruct) — accent + age/gender + emotion + pace in one string.
# Includes the 24 from the 100-sentence batch (docs/tts-eval-audio.md §7.5) plus ~23 more for
# less repetition at 10x the scale (each now used ~11x across 1000 clips instead of ~33x on a
# 30-profile pool). Deliberately spans native and L2-English accents — the "3 human speakers,
# one shared accent profile" gap flagged in docs/voice-pipeline-feasibility.md.
VOICE_DESIGN_PROFILES = [
    ("us-female-calm", "American English, young adult female voice, calm and measured, unhurried pace."),
    ("us-male-excited", "American English, young adult male voice, excited and enthusiastic, fast pace."),
    ("british-rp-elderly-male", "British English, Received Pronunciation, elderly male voice, formal and deliberate, slow pace."),
    ("british-female-tired", "British English, middle-aged female voice, sounding tired and a little bored, slow pace."),
    ("scottish-male-confident", "Scottish-accented English, middle-aged male voice, confident and brisk pace."),
    ("irish-female-cheerful", "Irish-accented English, young adult female voice, cheerful and warm, medium pace."),
    ("australian-male-casual", "Australian-accented English, young adult male voice, casual and relaxed, medium pace."),
    ("nz-female-curious", "New Zealand-accented English, young adult female voice, curious and inquisitive tone, medium pace."),
    ("south-african-male-serious", "South African-accented English, middle-aged male voice, serious and formal, measured pace."),
    ("indian-female-brisk", "Indian-accented English, young adult female voice, brisk and businesslike, fast pace."),
    ("nigerian-male-warm", "Nigerian-accented English, middle-aged male voice, warm and confident, medium pace."),
    ("kenyan-female-formal", "Kenyan-accented English, adult female voice, formal and precise, measured pace."),
    ("singaporean-male-hurried", "Singaporean-accented English, young adult male voice, hurried and slightly stressed, fast pace."),
    ("jamaican-female-relaxed", "Jamaican-accented English, young adult female voice, relaxed and easygoing, slow pace."),
    ("canadian-male-neutral", "Canadian English, adult male voice, neutral and clear, medium pace."),
    ("german-accented-male-precise", "German-accented English, middle-aged male voice, precise and formal, measured pace."),
    ("french-accented-female-elegant", "French-accented English, adult female voice, elegant and articulate, medium pace."),
    ("japanese-accented-male-polite", "Japanese-accented English, adult male voice, polite and soft-spoken, slow pace."),
    ("russian-accented-female-flat", "Russian-accented English, adult female voice, flat unemotional tone, measured pace."),
    ("spanish-accented-male-animated", "Spanish-accented English, young adult male voice, animated and energetic, fast pace."),
    ("us-teen-nervous", "American English, teenage female voice, nervous and hesitant, slightly halting pace."),
    ("british-male-skeptical", "British English, adult male voice, skeptical and dry, measured pace."),
    ("us-elderly-female-sleepy", "American English, elderly female voice, sleepy and soft, slow pace."),
    ("australian-female-stressed", "Australian-accented English, adult female voice, stressed and rushed, fast pace."),
    ("us-male-formal-slow", "American English, adult male voice, very formal and deliberate, slow pace."),
    ("british-female-excited-fast", "British English, young adult female voice, excited and talkative, fast pace."),
    ("welsh-male-warm", "Welsh-accented English, middle-aged male voice, warm and friendly, medium pace."),
    ("scottish-female-brisk", "Scottish-accented English, young adult female voice, brisk and no-nonsense, fast pace."),
    ("irish-male-sleepy", "Irish-accented English, adult male voice, sleepy and low-energy, slow pace."),
    ("australian-female-cheerful", "Australian-accented English, young adult female voice, cheerful and upbeat, medium pace."),
    ("south-african-female-curious", "South African-accented English, young adult female voice, curious and inquisitive, medium pace."),
    ("indian-male-confident", "Indian-accented English, middle-aged male voice, confident and assertive, medium pace."),
    ("nigerian-female-hurried", "Nigerian-accented English, young adult female voice, hurried and slightly anxious, fast pace."),
    ("kenyan-male-relaxed", "Kenyan-accented English, adult male voice, relaxed and unhurried, slow pace."),
    ("filipino-female-warm", "Filipino-accented English, young adult female voice, warm and polite, medium pace."),
    ("singaporean-female-formal", "Singaporean-accented English, adult female voice, formal and precise, measured pace."),
    ("jamaican-male-animated", "Jamaican-accented English, young adult male voice, animated and energetic, fast pace."),
    ("canadian-female-nervous", "Canadian English, young adult female voice, nervous and hesitant, slightly halting pace."),
    ("german-accented-female-brisk", "German-accented English, young adult female voice, brisk and businesslike, fast pace."),
    ("french-accented-male-skeptical", "French-accented English, adult male voice, skeptical and dry, measured pace."),
    ("japanese-accented-female-cheerful", "Japanese-accented English, young adult female voice, cheerful and polite, medium pace."),
    ("chinese-accented-male-formal", "Chinese-accented English, middle-aged male voice, formal and precise, measured pace."),
    ("korean-accented-female-curious", "Korean-accented English, young adult female voice, curious and soft-spoken, medium pace."),
    ("italian-accented-male-animated", "Italian-accented English, adult male voice, animated and expressive, fast pace."),
    ("swedish-accented-female-calm", "Swedish-accented English, adult female voice, calm and even, measured pace."),
    ("polish-accented-male-precise", "Polish-accented English, middle-aged male voice, precise and formal, measured pace."),
    ("dutch-accented-female-relaxed", "Dutch-accented English, adult female voice, relaxed and matter-of-fact, medium pace."),
]

CUSTOM_VOICE_PROFILES = [
    ("custom-ryan-happy", "Ryan", "Very happy and upbeat."),
    ("custom-ryan-calm", "Ryan", "Calm, matter-of-fact delivery."),
    ("custom-aiden-curious", "Aiden", "Curious, asking as if genuinely wondering."),
    ("custom-aiden-tired", "Aiden", "Sounding tired, low energy."),
    ("custom-vivian-en", "Vivian", "Speaking English with her natural accent, cheerful tone."),
    ("custom-sohee-en", "Sohee", "Speaking English with her natural accent, warm and gentle tone."),
    ("custom-dylan-formal", "Dylan", "Formal and businesslike delivery."),
    ("custom-eric-hurried", "Eric", "Hurried, slightly rushed delivery."),
    ("custom-serena-warm", "Serena", "Warm and reassuring tone."),
    ("custom-onoAnna-en", "Ono_Anna", "Speaking English with her natural accent, cheerful and polite."),
]

VOICE_POOL = VOICE_DESIGN_PROFILES + CUSTOM_VOICE_PROFILES


def synthesize(vd_model, cv_model, tag, rest, text):
    if len(rest) == 1:
        (instruct,) = rest
        wavs, sr = vd_model.generate_voice_design(text=text, language="English", instruct=instruct)
        return wavs, sr, {"engine": "VoiceDesign", "profile": tag, "instruct": instruct}
    speaker, instruct = rest
    wavs, sr = cv_model.generate_custom_voice(text=text, language="English", speaker=speaker, instruct=instruct)
    return wavs, sr, {"engine": "CustomVoice", "profile": tag, "speaker": speaker, "instruct": instruct}


def main():
    # Python fully block-buffers stdout when it isn't a TTY (e.g. redirected to sbatch's
    # %x-%j.out) — progress prints sit in an internal buffer and don't appear until it
    # fills (~4-8 KB) or the process exits, even though the work itself is happening in
    # real time. stderr is unbuffered by default, which is why the model's own warnings
    # already show up live in %x-%j.err while this script's own progress line doesn't.
    # Force line buffering so every print() below is visible immediately for monitoring.
    sys.stdout.reconfigure(line_buffering=True)

    sentences_path, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    sentences = json.loads(Path(sentences_path).read_text())

    # Global position of each sentence in the full 1000, by id — used below to keep voice-profile
    # assignment stable across a resume (a plain sentences.index(item) per clip would be O(n) and
    # rely on full-dict equality; this is a one-time O(n) build then O(1) lookups).
    global_index_by_id = {s["id"]: i for i, s in enumerate(sentences)}

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
    for i, item in enumerate(remaining):
        sid, text = item["id"], item["text"]
        # Index into the pool by *global* position (over the full 1000, not the resumed
        # remainder) so profile assignment doesn't shift on a resume.
        global_idx = global_index_by_id[sid]
        tag, *rest = VOICE_POOL[global_idx % len(VOICE_POOL)]

        t0 = time.time()
        wavs, sr, voice_info = synthesize(vd_model, cv_model, tag, rest, text)
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
                **voice_info,
            }
        )
        manifest_path.write_text(json.dumps({"voicePool": [p[0] for p in VOICE_POOL], "clips": manifest}, indent=2))

        elapsed = time.time() - t_start
        rate = elapsed / (i + 1)
        eta_min = rate * (len(remaining) - i - 1) / 60
        print(
            f"  [{len(done_ids) + i + 1}/{len(sentences)}] {sid} ({tag}) gen={gen_s:.1f}s "
            f"dur={dur_s:.1f}s  avg={rate:.1f}s/clip  eta={eta_min:.0f}min"
        )

    total = time.time() - t_start
    print(f"\nDone: {len(remaining)} new clips in {total:.1f}s ({total / len(remaining):.2f}s/clip avg)")
    print(f"manifest now has {len(manifest)} total clips at {manifest_path}")


if __name__ == "__main__":
    main()
