/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Single-orb WebGL renderer adapted from V3Code's galaxy orb shader.
 *
 * This is intentionally not the batched list renderer: the voice surface owns one hero
 * orb and releases the animation loop whenever it is hidden. Callers must retain a
 * non-WebGL fallback because GPU acceleration can be disabled by the user or platform.
 */

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;

void main() {
	vUV = aUV;
	gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const SHARED_GALAXY_SHADER = String.raw`
float h1(float value) {
	return fract(sin(value * 127.1) * 43758.5453123);
}

vec4 starfield(vec3 n, float t) {
	float lon = atan(n.z, n.x);
	float lat = asin(clamp(n.y, -1.0, 1.0));
  // its own galaxy — band tilt/undulation/width, star density, pocket hues
  float v1 = fract(uPhase * 7.13);
  float v2 = fract(uPhase * 3.71);
  float v3 = fract(uPhase * 5.37);

  // Galaxy archetype: each orb is one of four different skies.
  // 0 spiral (milky-way band) \xb7 1 emission nebula (vivid cloud, few stars)
  // 2 galactic core (warm blazing bulge) \xb7 3 deep field (sparse, crystalline)
  float at = uArch >= 0.0 ? uArch : floor(fract(uPhase * 9.73) * 4.0);
  float isNeb = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);

  // galactic plane: density concentrates in a band around a tilted equator.
  // lon frequencies MUST be integers: lon wraps at plus/minus pi, and a non-integer
  // frequency doesn't tile across that seam — it stamps a hard crease that
  // tumbles into view as the sphere spins.
  float gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
           + 0.12 * sin(lon * 3.0 + t * 0.1);
  float band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = mix(band, max(band, 0.8), isNeb); // nebula: cloud fills the whole sky
  band *= 1.0 - 0.85 * isDeep; // deep field: nearly empty void

  // nebula: two octaves of warped wisps, glowing pockets along the band
  float n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  float n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  float neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  // dark dust lanes carved through the bright band
  float lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  float galaxy = band * neb * (1.0 - lane * (0.55 + 0.35 * v2));
  float w0g = clamp(galaxy, 0.0, 1.0); // ensure the band registers in alpha
  galaxy = w0g;
  // Milky-Way dust: mostly cool blue-white star haze, the palette only as a
  // faint cast — real galaxies are desaturated except the warm core
  // per-orb color identity: how strongly (and with which accents) the dust is
  // tinted varies orb to orb — some stay silver-blue, others go violet/amber
  vec3 hue = mix(mix(uC0, uC1, v1), mix(uC1, uC2, v3), 0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2));
  // saturation push: keep the dust hue vivid even after all the mixing
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, 0.0, 1.0);
  // the palette carries each agent's identity — dust leans firmly into it
  // (different agents on one screen read as different colored skies)
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);
  vec3 col = dust * galaxy * (0.6 + 0.9 * isNeb);
  // rotation streaks: faint orbital shear lines inside the band, drifting —
  // the galaxy visibly *turns*
  float shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * 0.14;
  // a second, fainter dust arm crossing the main band — spiral-galaxy depth
  float gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  float arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += mix(dust, uC1, 0.35) * arm * 0.2;
  // the void itself is never pure black: a whisper of deep indigo that
  // breathes — the "magic" ambient of a long-exposure sky
  // the void itself carries the agent's hue — the strongest identity cue,
  // since it covers the whole sphere
  vec3 voidGlow = mix(vec3(0.04, 0.03, 0.1), mix(uC0, mix(uC1, uC2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);
  // warm amber core glow deep in the band
  col += vec3(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * 0.4;
  // galactic-core archetype: a blazing warm bulge with a halo of star-fog,
  // fixed to the rotating sphere so it wheels around as the galaxy turns
  float ca = v2 * 6.28318;
  vec3 Cdir = normalize(vec3(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  float bulge = max(dot(n, Cdir), 0.0);
  col += mix(vec3(1.0, 0.85, 0.6), uC2, 0.25) * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;
  // nebula pockets, two layers in different hues: hot spots of saturated
  // palette color glowing in the dust, slowly breathing
  float pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * 0.6 + lon * 3.0));
  col += mix(uC2, uC0, fract(v1 + 0.5 * sin(lon * 2.0) + 0.5)) * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb);
  float pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += mix(uC1, uC2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb);
  // Detail factor by orb size (1 = large): small list orbs keep faded bright stars but drop the grain
  // and most of the dense faint dust — those are what read as granular noise / alias at list sizes.
  float detail = smoothstep(90.0, 200.0, uRes.y);
  // milky grain: ultra-fine star dust packed into the band — the granular
  // texture that says "Milky Way" in long-exposure shots
  vec2 gg = vec2(lon, lat) * 34.0;
  vec2 gc = floor(gg);
  vec2 gf = fract(gg);
  float gh = h1(gc.x * 3.7 + gc.y * 11.3);
  vec2 gp = vec2(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  float gd = length((gf - gp) * vec2(cos(lat), 1.0));
  float grain = exp(-gd * gd * 700.0 * clamp(uRes.y / 420.0, 0.22, 1.0)) * step(0.3, gh) * (0.15 + 0.85 * band);
  col += vec3(0.88, 0.9, 1.0) * grain * 0.4 * detail;
  float w = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);



  // three star scales: a few bright, many mid, dense faint dust (denser in band)
  for (int s = 0; s < 3; s++) {
    float K = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    vec2 g = vec2(lon, lat) * K;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float hx = h1(cell.x * 13.7 + cell.y * 7.3 + float(s) * 91.0);
    float hy = h1(cell.x * 5.1 + cell.y * 17.9 + float(s) * 37.0);
    vec2 sp = vec2(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    float d = length((f - sp) * vec2(cos(lat), 1.0));
    // archetype star census: nebulae are star-poor, cores star-rich,
    // deep fields sparse but every star counts
    float census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    float keep = step((s == 2 ? 0.3 : 0.55) + census, h1(hx * 89.0 + hy * 31.0) + band * 0.25);
    // small orbs: stars must stay >= ~1px and twinkle gently, or they alias
    // into flicker as the sphere tumbles
    float resFac = clamp(uRes.y / 420.0, 0.22, 1.0);
    float tw = mix(0.92, 0.6 + 0.4 * sin(t * (1.5 + 3.0 * hx) + hx * 40.0), resFac);
    // per-star size: each star draws its own radius from the hash (4x range),
    // and brightness follows size — a real magnitude distribution
    float hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    float sizeJit = 0.35 + 1.8 * hz * hz; // few big, many small
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0)) / sizeJit * resFac;
    float star = exp(-d * d * sharp) * keep * tw;
    // near-white stars with the faintest temperature variation, like the sky
    vec3 tint = mix(vec3(1.0), hx < 0.33 ? vec3(0.85, 0.9, 1.0) : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1, 0.3)), 0.6);
    float bright = (s == 0 ? 1.7 : (s == 1 ? 0.9 : 0.5)) * (0.55 + 0.7 * sizeJit);
    // small orbs: keep the bright/mid stars (just faded), but drop most of the dense faint dust (s==2)
    // and the grain — those are what read as granular noise at list sizes.
    float starFade = mix(s == 2 ? 0.14 : 0.45, 1.0, detail);
    col += tint * star * bright * starFade;
    // the biggest stars get a soft halo bloom + diffraction-cross sparkle
    if (s == 0) {
      float big = smoothstep(1.2, 2.0, sizeJit);
      col += tint * exp(-d * d * 60.0) * 0.18 * big * tw * starFade;
      vec2 dd = (f - sp) * vec2(cos(lat), 1.0);
      float spike = exp(-dd.x * dd.x * 1200.0) * exp(-dd.y * dd.y * 26.0)
                  + exp(-dd.y * dd.y * 1200.0) * exp(-dd.x * dd.x * 26.0);
      col += tint * spike * 0.3 * big * tw * starFade;
      w = max(w, spike * 0.3 * big * starFade);
    }
    w = max(w, star * min(bright, 1.5) * starFade);
  }

  // pulsar: one bright star per orb that flashes rhythmically with a halo —
  // audio pushes its beat brighter and faster
  float pa = v1 * 6.28318;
  vec3 P = normalize(vec3(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  float pd = max(dot(n, P), 0.0);
  float beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3 + 1.5 * uAudio) + v3 * 6.28), 8.0);
  beat = min(1.0, beat + 0.6 * uAudio);
  float pulsarFade = mix(0.45, 1.0, detail);
  col += vec3(0.9, 0.95, 1.0) * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  w = max(w, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);

  return vec4(min(col, vec3(1.0)), min(w, 1.0));
}

// Sample the rotating sphere at 3D point n (unit sphere). The ball TUMBLES:
// it spins around a tilted axis while that axis itself slowly precesses and
// the whole ball rolls — rotation on multiple axes, like a marble turned in
// the hand, so the pattern travels over the poles too, not just sideways.
vec4 sphereAt(vec3 n, float spin, float t) {
  float roll = t * 0.13; // roll around the view axis
  float cr = cos(roll), sr = sin(roll);
  n = vec3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);
  float tilt = 0.45 + 0.35 * sin(t * 0.24); // precessing axis
  float cx = cos(tilt), sx = sin(tilt);
  n = vec3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);
  float cs = cos(spin), ss = sin(spin);
  n = vec3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);
  return starfield(n, t);
}

// The whole orb as a pure function of the (pre-lens) screen point p — the
// in-shader lens re-evaluates this at displaced coordinates per RGB channel.
vec3 shade(vec2 p) {
  float r = length(p);
  // No alpha mask: the shader renders edge-to-edge of the square canvas
  // (the limb colors smear outward past r=1 as overscan), so the lens —
  // SVG or in-shader — always has pixels to displace; otherwise it pulls
  // transparent samples and stamps a hard arc inside the sphere. The CSS
  // clip-path on the canvas wrapper cuts the true circular silhouette.
#ifndef DUAL_LAYER
  // Batch (list) orbs have no lens, so the square corners are never used —
  // discard them to skip the whole galaxy compute for ~21% of pixels.
  if (r > 1.0) { discard; }
#endif
  float t = uTime * 0.8 + uPhase;

  // sphere geometry
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec3 N = vec3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4); // 0 center -> 1 at the limb

  // Front hemisphere point is N itself; the see-through far wall is hit by
  // the refracted ray continuing through the glass to the back of the ball.
  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 R = refract(I, N, 0.75);
  // exit point of the ray on the back of the unit sphere
  float dHit = -2.0 * dot(N, R);
  vec3 B = normalize(N + R * dHit);

  // both layers live on the SAME rotating sphere — the front face and the
  // far wall seen through the glass — so the whole ball reads as one object
  // spinning, with the back side counter-sliding in true perspective.
  // organic motion: the spin angle is integrated on the CPU (uSpin) so the
  // rotation can accelerate, ease, and reverse smoothly — especially under
  // audio. Pattern time keeps its own gentle warp for non-linear drift.
  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);
  vec4 front = sphereAt(N, uSpin, tWarp);
  // The back-wall galaxy sample doubles fragment cost; only the hero (single-orb)
  // program keeps it. Batched list orbs skip it (invisible at small sizes).
#ifdef DUAL_LAYER
  vec4 back = sphereAt(B, uSpin, tWarp * 0.8 + 2.7);
#else
  vec4 back = vec4(0.0);
#endif

  // glass body: deep-space glass — near-black void with the anchor color
  // breathing at the rim; just enough page light leaks through the edge
  // to keep it reading as glass rather than a flat black disc
  vec3 voidCol = mix(uAnchor * 0.04, uAnchor * 0.35, fres);
  vec3 col = mix(uBg, voidCol, 0.97 - 0.04 * fres);
  // mix (not add): the band REPLACES the glass color where it lives, so it
  // reads on light pages instead of clipping to white
  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba * 0.16); // far-wall echo
  col = mix(col, front.rgb, fa * 0.85);
  {
    // Aurora borealis, voice as light — drawn in VIEW space so the
    // curtains always hang in the visible upper sky (the galaxy tumbles
    // behind them). Amplitude undulates like speech; fine rays shimmer
    // through; classic green at the base climbing into violet.
    float alon = atan(N.x, N.z);
    float speech = pow(0.5 + 0.5 * sin(alon * 3.0 + sin(alon * 7.0 + t * 1.1) * 0.7 + t * 0.5), 3.0)
                 * (0.55 + 0.45 * sin(alon * 5.0 - t * 0.65 + 1.7));
    float sky = -N.y; // canvas blit flips Y: -N.y is the visible upper sky
    float hang = smoothstep(-0.15, 0.5, sky);
    float rays = 0.7 + 0.3 * sin(alon * 24.0 + sin(alon * 9.0 - t * 0.8) * 2.0 + t * 1.6);
    // audio: the voice IS the aurora — curtains surge with live amplitude
    float aur = clamp(speech, 0.0, 1.0) * hang * rays * (1.0 + 2.2 * uAudio);
    // per-orb aurora character: some classic green→violet, others lean into
    // the palette (teal→pink, blue→gold…)
    float av = fract(uPhase * 2.93);
    vec3 aurCol = mix(vec3(0.12, 0.95, 0.55), vec3(0.45, 0.35, 1.0),
                      smoothstep(0.0, 0.95, sky + 0.35 * speech));
    aurCol = mix(aurCol, mix(uC0, uC2, av), 0.15 + 0.4 * av);
    col += aurCol * aur * 0.8;

    // shooting star: every ~6s a meteor streaks across a random trajectory,
    // white-hot head with an exponentially fading tail
    float met = 4.5 + 3.5 * fract(uPhase * 4.91); // per-orb meteor cadence
    float epoch = floor(t / met);
    float ph = fract(t / met);
    vec2 s0 = vec2(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
    vec2 sd = normalize(vec2(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
    vec2 head = s0 + sd * ph * 2.8;
    vec2 rel = p - head;
    float along = dot(rel, sd);
    float perp = dot(rel, vec2(-sd.y, sd.x));
    float vis = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.32, ph);
    float tail = exp(-perp * perp * 1600.0) * exp(along * 9.0) * step(along, 0.0)
               * smoothstep(-0.5, -0.02, along);
    float headGlow = exp(-dot(rel, rel) * 900.0);
    col += (vec3(1.0) * headGlow * 1.2 + mix(vec3(1.0), uC1, 0.3) * tail * 0.85) * vis;

    // moving illumination: a broad diffuse gradient (a soft terminator)
    // sweeps around the sphere, brightening whole regions of sky and dust in
    // turn — this is what makes the ball feel LIT, not printed
    vec3 LD = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
    float diffuse = 0.62 + 0.65 * max(dot(N, LD), 0.0);
    // audio: the whole sky brightens and breathes with the voice
    diffuse *= 1.0 + 0.35 * uAudio;
    col *= diffuse;
    // Voice light: while speaking, a warm core flare wakes deep in the
    // sphere and the rim catches the agent's color — the orb visibly *emits*
    vec3 voiceCol = mix(uC1, vec3(1.0, 0.97, 0.9), 0.45);
    col += voiceCol * pow(1.0 - rr, 1.8) * uAudio * 0.5; // inner flare
    col += (uC1 * 0.7 + vec3(0.12)) * fres * uAudio * 0.65; // rim ignition
    // sparkle excitement: stars glitter harder while the voice is live
    col += col * uAudio * 0.18 * sin(t * 14.0 + rr * 40.0 + uPhase * 7.0);
    // counter-rim: a faint atmospheric glow opposite the moving light
    float counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
    col += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;
  }

  // 3D lighting off the sphere normal — the key light DRIFTS slowly (like a
  // light source moving in the room) and breathes in intensity, so the glass
  // never feels statically lit
  vec3 L1 = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmp = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  col += vec3(1.0) * pow(max(dot(N, L1), 0.0), 150.0) * keyAmp;
  // broad soft sheen sweeping across the dome on a long period
  vec3 LS = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += vec3(1.0) * pow(max(dot(N, LS), 0.0), 7.0) * 0.05;
  vec3 L2 = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69)); // counter glint
  col += vec3(1.0) * pow(max(dot(N, L2), 0.0), 140.0) * 0.25;
  // fresnel rim — a bubble's edge catches a touch of the band's color
  col = mix(col, front.rgb, fa * fres * 0.3);
  // whisper of limb compression
  float limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col * 0.85, limb * 0.4);

  return col;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
#define DUAL_LAYER

varying vec2 vUV;
uniform vec2 uRes;
uniform vec3 uBg;
uniform vec3 uAnchor;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uTime;
uniform float uPhase;
uniform float uAudio;
uniform float uSpin;
uniform float uArch;
uniform float uLens;
${SHARED_GALAXY_SHADER}

void main() {
	vec2 p = vUV * 2.0 - 1.0;
	if (uLens > 0.0) {
		float r = length(p);
		float ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
		float fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);
		if (fall > 0.004) {
			float swell = 1.0 + 0.16 * (0.6 * sin(uTime * 0.9 + uPhase)
				+ 0.4 * sin(uTime * 1.7 + uPhase * 1.3));
			float k = uLens * fall * swell;
			float cR = 1.4 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase));
			float cG = 1.2 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 2.1));
			float cB = 1.0 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 4.2));
			vec3 col = vec3(
				shade(p * (1.0 - k * cR)).r,
				shade(p * (1.0 - k * cG)).g,
				shade(p * (1.0 - k * cB)).b
			);
			vec2 a2 = min(abs(p), 1.0);
			float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
			float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
			glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
			col += vec3(0.25) * min(glow, 1.0);
			gl_FragColor = vec4(col, 1.0);
			return;
		}
	}
	gl_FragColor = vec4(shade(p), 1.0);
}
`;

type Uniforms = Readonly<{
	uRes: WebGLUniformLocation | null;
	uBg: WebGLUniformLocation | null;
	uAnchor: WebGLUniformLocation | null;
	uC0: WebGLUniformLocation | null;
	uC1: WebGLUniformLocation | null;
	uC2: WebGLUniformLocation | null;
	uTime: WebGLUniformLocation | null;
	uPhase: WebGLUniformLocation | null;
	uAudio: WebGLUniformLocation | null;
	uSpin: WebGLUniformLocation | null;
	uArch: WebGLUniformLocation | null;
	uLens: WebGLUniformLocation | null;
}>;

export class V3GalaxyOrbRenderer {
	private readonly gl: WebGLRenderingContext | undefined;
	private program: WebGLProgram | undefined;
	private uniforms: Uniforms | undefined;
	private ready = false;
	private lastTime: number | undefined;
	private audioSmooth = 0;
	private audioFast = 0;
	private previousAudio = 0;
	private spin = 0;
	private spinVelocity = 0.42;
	private spinDirection = 1;
	private flipQueued = false;
	private oscillatorSign = 1;
	private readonly phase = 0.731;

	constructor(private readonly canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl', {
			alpha: true,
			antialias: true,
			premultipliedAlpha: true,
			preserveDrawingBuffer: false,
			powerPreference: 'low-power',
		}) ?? undefined;
		this.gl = gl;
		if (!gl) {
			return;
		}
		canvas.addEventListener('webglcontextlost', event => {
			event.preventDefault();
			this.ready = false;
		});
		canvas.addEventListener('webglcontextrestored', () => this.initialize());
		this.initialize();
	}

	get available(): boolean {
		return this.ready;
	}

	get hasContext(): boolean {
		return !!this.gl;
	}

	render(time: number, audioLevel: number): boolean {
		if (!this.ready || !this.gl || !this.program || !this.uniforms) {
			return false;
		}
		this.updateDynamics(time, audioLevel);
		const gl = this.gl;
		const uniforms = this.uniforms;
		const width = this.canvas.width;
		const height = this.canvas.height;
		gl.useProgram(this.program);
		gl.viewport(0, 0, width, height);
		gl.uniform2f(uniforms.uRes, width, height);
		gl.uniform3f(uniforms.uBg, 0.004, 0.005, 0.012);
		gl.uniform3f(uniforms.uAnchor, 0.45, 0.48, 0.62);
		gl.uniform3f(uniforms.uC0, 0.31, 0.36, 0.84);
		gl.uniform3f(uniforms.uC1, 0.31, 0.78, 0.9);
		gl.uniform3f(uniforms.uC2, 0.76, 0.35, 0.78);
		gl.uniform1f(uniforms.uTime, time);
		gl.uniform1f(uniforms.uPhase, this.phase);
		gl.uniform1f(uniforms.uAudio, this.audioSmooth);
		gl.uniform1f(uniforms.uSpin, this.spin);
		gl.uniform1f(uniforms.uArch, 0);
		gl.uniform1f(uniforms.uLens, 0.055);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		return true;
	}

	private initialize(): void {
		const gl = this.gl;
		if (!gl) {
			return;
		}
		const vertex = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
		const fragment = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
		if (!vertex || !fragment) {
			return;
		}
		const program = gl.createProgram();
		if (!program) {
			return;
		}
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.bindAttribLocation(program, 0, 'aPos');
		gl.bindAttribLocation(program, 1, 'aUV');
		gl.linkProgram(program);
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.error('[V3VoiceOrb] shader link failed:', gl.getProgramInfoLog(program));
			gl.deleteProgram(program);
			return;
		}
		if (this.program) {
			gl.deleteProgram(this.program);
		}
		this.program = program;
		this.uniforms = {
			uRes: gl.getUniformLocation(program, 'uRes'),
			uBg: gl.getUniformLocation(program, 'uBg'),
			uAnchor: gl.getUniformLocation(program, 'uAnchor'),
			uC0: gl.getUniformLocation(program, 'uC0'),
			uC1: gl.getUniformLocation(program, 'uC1'),
			uC2: gl.getUniformLocation(program, 'uC2'),
			uTime: gl.getUniformLocation(program, 'uTime'),
			uPhase: gl.getUniformLocation(program, 'uPhase'),
			uAudio: gl.getUniformLocation(program, 'uAudio'),
			uSpin: gl.getUniformLocation(program, 'uSpin'),
			uArch: gl.getUniformLocation(program, 'uArch'),
			uLens: gl.getUniformLocation(program, 'uLens'),
		};

		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
			-1, -1, 0, 1,
			1, -1, 1, 1,
			-1, 1, 0, 0,
			1, 1, 1, 0,
		]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		this.ready = true;
	}

	private compileShader(type: number, source: string): WebGLShader | undefined {
		const gl = this.gl;
		if (!gl) {
			return undefined;
		}
		const shader = gl.createShader(type);
		if (!shader) {
			return undefined;
		}
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.error('[V3VoiceOrb] shader compile failed:', gl.getShaderInfoLog(shader));
			gl.deleteShader(shader);
			return undefined;
		}
		return shader;
	}

	private updateDynamics(time: number, rawAudio: number): void {
		const delta = this.lastTime === undefined ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
		this.lastTime = time;
		const audio = Math.min(1, Math.max(0, rawAudio));
		const smoothTime = audio > this.audioSmooth ? 0.11 : 0.3;
		const fastTime = audio > this.audioFast ? 0.04 : 0.18;
		if (delta > 0) {
			this.audioSmooth += (audio - this.audioSmooth) * (1 - Math.exp(-delta / smoothTime));
			this.audioFast += (audio - this.audioFast) * (1 - Math.exp(-delta / fastTime));
		}
		const oscillator = Math.sin(time * (0.45 + 0.2 * ((6.31 * this.phase) % 1)) + this.phase);
		if (Math.sign(oscillator) !== this.oscillatorSign) {
			this.oscillatorSign = Math.sign(oscillator);
			this.flipQueued = true;
		}
		if (this.flipQueued && this.audioFast < 0.18) {
			this.spinDirection = -this.spinDirection;
			this.flipQueued = false;
		}
		const variation = 0.35 * Math.sin(time * (0.11 + 0.08 * ((2.17 * this.phase) % 1)) + this.phase);
		const targetVelocity = 0.65 * (0.65 + 0.7 * ((6.31 * this.phase) % 1)) * (1 + variation)
			+ this.spinDirection * this.audioFast * 2.2;
		if (delta > 0) {
			this.spinVelocity += (targetVelocity - this.spinVelocity) * (1 - Math.exp(-delta / 0.35));
			const audioRise = Math.max(0, this.audioFast - this.previousAudio);
			this.spinVelocity += this.spinDirection * Math.min(6 * audioRise, 1.4) * delta * 14;
			this.spin += this.spinVelocity * delta;
		}
		this.previousAudio = this.audioFast;
	}
}
