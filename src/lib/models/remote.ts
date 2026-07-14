/**
 * Base URL for the Cyfronet S3 mirror of on-device model weights — see
 * docs/model-hosting-cyfronet.md. transformers.js resolves every file at
 * `<remoteHost><repo>/resolve/<revision>/<file>`, and the mirror's object
 * keys are laid out to match that path exactly, so pointing `env.remoteHost`
 * here is a drop-in replacement for the default huggingface.co host — no
 * other transformers.js config changes needed.
 *
 * Hardcoded rather than build-time config: there's exactly one bucket, and
 * wiring an env-driven switch is out of scope until a second host is needed.
 */
export const MODEL_MIRROR_HOST = "https://aidedx-models.s3p.cloud.cyfronet.pl/";
