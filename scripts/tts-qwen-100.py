"""
Generate the 100-sentence Qwen3-TTS eval-audio batch (issue #30 scale-up).

Reads the validated 100 sentences (scripts/.tmp-100-final.json — every one confirmed by
scripts/tts-sentence-check.ts to produce a correct intent + a real libdedx number) and
synthesizes each with a deterministically round-robin-assigned voice profile spanning a
pool of accents/ages/genders/emotions/paces (VoiceDesign, free-text `instruct`) plus a
handful of CustomVoice presets, so the 100 clips together exercise a wide spread of voice
style — not just wording variety.

Usage: python scripts/tts-qwen-100.py <sentences.json> <out_dir> [--limit N]
"""
import json
import sys
import time
from pathlib import Path

import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

SAMPLE_RATE = 24000

# VoiceDesign profiles: (tag, instruct). Each is a free-text description covering
# accent + age + gender + emotional tone + pace — the four axes the task asked for.
# Deliberately spans native and L2-English accents: the project's own eval docs flag
# "3 human speakers, one shared accent profile" as an untested gap (docs/voice-pipeline
# -feasibility.md); this pool is partly aimed at that gap, not just cosmetic variety.
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
]

# CustomVoice presets (fixed timbre) + an instruct string layered on top for emotion —
# a different generation path than VoiceDesign, adding preset-vs-designed variety too.
CUSTOM_VOICE_PROFILES = [
    ("custom-ryan-happy", "Ryan", "Very happy and upbeat."),
    ("custom-ryan-calm", "Ryan", "Calm, matter-of-fact delivery."),
    ("custom-aiden-curious", "Aiden", "Curious, asking as if genuinely wondering."),
    ("custom-aiden-tired", "Aiden", "Sounding tired, low energy."),
    ("custom-vivian-en", "Vivian", "Speaking English with her natural accent, cheerful tone."),
    ("custom-sohee-en", "Sohee", "Speaking English with her natural accent, warm and gentle tone."),
]

# Round-robin pool: mostly VoiceDesign (full accent freedom), a fraction CustomVoice.
VOICE_POOL = VOICE_DESIGN_PROFILES + CUSTOM_VOICE_PROFILES


def main():
    args = sys.argv[1:]
    limit = None
    if "--limit" in args:
        i = args.index("--limit")
        limit = int(args[i + 1])
        del args[i : i + 2]
    sentences_path, out_dir = args[0], Path(args[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    sentences = json.loads(Path(sentences_path).read_text())
    if limit:
        sentences = sentences[:limit]

    print(f"cuda available: {torch.cuda.is_available()}")
    vd_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0", dtype=torch.bfloat16
    )
    cv_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", device_map="cuda:0", dtype=torch.bfloat16
    )

    manifest = []
    t_start = time.time()
    for i, item in enumerate(sentences):
        sid, text = item["id"], item["text"]
        tag, *rest = VOICE_POOL[i % len(VOICE_POOL)]

        t0 = time.time()
        if len(rest) == 1:
            (instruct,) = rest
            wavs, sr = vd_model.generate_voice_design(text=text, language="English", instruct=instruct)
            voice_info = {"engine": "VoiceDesign", "profile": tag, "instruct": instruct}
        else:
            speaker, instruct = rest
            wavs, sr = cv_model.generate_custom_voice(
                text=text, language="English", speaker=speaker, instruct=instruct
            )
            voice_info = {
                "engine": "CustomVoice",
                "profile": tag,
                "speaker": speaker,
                "instruct": instruct,
            }
        gen_s = time.time() - t0
        dur_s = len(wavs[0]) / sr

        out_path = out_dir / f"{sid}.wav"
        sf.write(str(out_path), wavs[0], sr, subtype="PCM_16")

        manifest.append({"id": sid, "text": text, "gen_s": round(gen_s, 2), "dur_s": round(dur_s, 2), **voice_info})
        print(f"  [{i + 1}/{len(sentences)}] {sid} ({tag}) gen={gen_s:.1f}s dur={dur_s:.1f}s")

    total = time.time() - t_start
    print(f"\nTotal: {len(manifest)} clips in {total:.1f}s ({total / len(manifest):.2f}s/clip avg)")
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps({"voicePool": [p[0] for p in VOICE_POOL], "clips": manifest}, indent=2))
    print(f"wrote {manifest_path}")


if __name__ == "__main__":
    main()
