/*
 * issue #136 goal 3, Approach B — thin JNI bridge over vendored APTG/libdedx
 * (../../../../vendor/libdedx). Deliberately calls only the one-off "wrapper" functions in
 * dedx_wrappers.h (dedx_get_stp_table / dedx_get_csda_range_table / dedx_fill_*) rather than the
 * workspace-based core API in dedx.h — those already handle allocate/load/free internally per
 * call, so this bridge needs no workspace lifecycle management, matching the same flat,
 * one-shot-per-call shape src/lib/wasm/loader.ts's Emscripten export list already uses (see
 * docs/wasm.md) — same contract, different host.
 */
#include <jni.h>
#include <stdlib.h>

#include "dedx.h"
#include "dedx_elements.h"
#include "dedx_wrappers.h"

JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetMinEnergy(
    JNIEnv *env, jobject thiz, jint program, jint ion) {
  (void)env;
  (void)thiz;
  return dedx_get_min_energy(program, ion);
}

JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetMaxEnergy(
    JNIEnv *env, jobject thiz, jint program, jint ion) {
  (void)env;
  (void)thiz;
  return dedx_get_max_energy(program, ion);
}

JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetDensity(
    JNIEnv *env, jobject thiz, jint material) {
  (void)env;
  (void)thiz;
  int err = 0;
  float density = dedx_get_density(material, &err);
  return err == 0 ? density : -1.0f;
}

JNIEXPORT jint JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetNucleonNumber(
    JNIEnv *env, jobject thiz, jint ion) {
  (void)env;
  (void)thiz;
  int err = 0;
  int a = dedx_get_nucleon_number(ion, &err);
  return err == 0 ? a : -1;
}

JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetAtomMass(
    JNIEnv *env, jobject thiz, jint ion) {
  (void)env;
  (void)thiz;
  int err = 0;
  float mass = dedx_get_atom_mass(ion, &err);
  return err == 0 ? mass : -1.0f;
}

/** Returns NaN if the (program, ion, material) combination fails to load. */
JNIEXPORT jfloat JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetStp(
    JNIEnv *env, jobject thiz, jint program, jint ion, jint material, jfloat energyMevPerNucl) {
  (void)env;
  (void)thiz;
  float energy = energyMevPerNucl;
  float stp = 0.0f;
  int rc = dedx_get_stp_table(program, ion, material, 1, &energy, &stp);
  return rc == 0 ? stp : (jfloat)(0.0 / 0.0);
}

/** Returns NaN if the (program, ion, material) combination fails to load. */
JNIEXPORT jdouble JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetCsdaRange(
    JNIEnv *env, jobject thiz, jint program, jint ion, jint material, jfloat energyMevPerNucl) {
  (void)env;
  (void)thiz;
  float energy = energyMevPerNucl;
  double range = 0.0;
  int rc = dedx_get_csda_range_table(program, ion, material, 1, &energy, &range);
  return rc == 0 ? range : (jdouble)(0.0 / 0.0);
}

JNIEXPORT jstring JNICALL
Java_com_aidedx_fullapp_compute_LibdedxBridge_nativeGetVersionString(JNIEnv *env, jobject thiz) {
  (void)thiz;
  return (*env)->NewStringUTF(env, dedx_get_version_string());
}
