/* ============================================================
   AuraFace — real-time voxel AI face (Three.js InstancedMesh)
   ------------------------------------------------------------
   Modular lip-sync / state API for the AURA User Interaction UI.

   Events / methods:
     onListeningStart() / onListeningEnd()
     onThinkingStart()  / onThinkingEnd()
     onTTSStart(audioData?, timingData?)
     onTTSProgress(timestamp)
     onTTSEnd()
     setAnalyser(analyserNode)   // Web Audio fallback lip-sync
     update(dt, now)             // call each frame
     resize(w, h)
     dispose()
   ============================================================ */
(function (global) {
  "use strict";

  const VISEMES = {
    closed:  { open: 0.0, wide: 0.0, round: 0.0, smile: 0.0 },
    open:    { open: 1.0, wide: 0.15, round: 0.1, smile: 0.0 },
    wide:    { open: 0.45, wide: 1.0, round: 0.0, smile: 0.35 },
    narrow:  { open: 0.25, wide: -0.2, round: 0.35, smile: 0.0 },
    round:   { open: 0.55, wide: -0.1, round: 1.0, smile: 0.0 },
    ee:      { open: 0.3, wide: 0.85, round: 0.0, smile: 1.0 },
    closedLips: { open: 0.0, wide: 0.1, round: 0.0, smile: 0.0 },
  };

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Signed distance helpers for a front-facing face profile. */
  function faceDepth(nx, ny) {
    // Base head ellipsoid (x,y in ~[-1,1])
    const rx = 0.78;
    const ry = 1.05;
    const ell = 1 - (nx * nx) / (rx * rx) - (ny * ny) / (ry * ry);
    if (ell <= 0) return -1;

    let z = Math.sqrt(Math.max(0, ell)) * 0.72;

    // Forehead flatten
    if (ny > 0.35) z *= 0.92 + 0.08 * (1 - (ny - 0.35) / 0.7);

    // Eye sockets (recessed)
    const eyeY = 0.22;
    const eyeSep = 0.28;
    for (const sx of [-1, 1]) {
      const ex = nx - sx * eyeSep;
      const ey = ny - eyeY;
      const er = Math.sqrt(ex * ex * 1.6 + ey * ey * 2.4);
      z -= 0.14 * smoothstep(0.22, 0.0, er);
      // Closed eyelid ridge
      if (er < 0.18 && ey > -0.02 && ey < 0.08) z += 0.04 * (1 - er / 0.18);
    }

    // Nose bridge + tip
    const noseX = Math.abs(nx);
    if (noseX < 0.12 && ny > -0.05 && ny < 0.45) {
      const along = (ny + 0.05) / 0.5;
      const width = 0.12 - along * 0.04;
      const n = 1 - noseX / Math.max(0.02, width);
      z += 0.22 * Math.max(0, n) * (0.4 + along * 0.8);
    }
    // Nostrils dip
    if (Math.abs(Math.abs(nx) - 0.06) < 0.04 && ny > -0.08 && ny < 0.02) {
      z -= 0.05;
    }

    // Cheek fullness
    const cheek = Math.exp(-((Math.abs(nx) - 0.4) ** 2) / 0.08 - ((ny + 0.05) ** 2) / 0.12);
    z += 0.06 * cheek;

    // Mouth plane (slightly recessed lips base)
    if (Math.abs(nx) < 0.32 && ny > -0.42 && ny < -0.12) {
      const mx = nx / 0.32;
      const my = (ny + 0.27) / 0.15;
      const mouthMask = Math.max(0, 1 - mx * mx * 0.9 - my * my);
      z -= 0.04 * mouthMask;
      // Lip ridge
      const lip = Math.exp(-Math.pow(Math.abs(my) - 0.55, 2) / 0.08) * mouthMask;
      z += 0.05 * lip;
    }

    // Jaw taper
    if (ny < -0.55) {
      const j = (-0.55 - ny) / 0.55;
      z *= 1 - j * 0.55;
      const jawW = 0.55 * (1 - j * 0.7);
      if (Math.abs(nx) > jawW) return -1;
    }

    // Chin
    if (Math.abs(nx) < 0.18 && ny < -0.75 && ny > -1.05) {
      z += 0.08 * (1 - Math.abs(nx) / 0.18);
    }

    return z;
  }

  function isMouthCell(nx, ny) {
    return Math.abs(nx) < 0.34 && ny > -0.48 && ny < -0.1;
  }

  function isDissolveCell(nx, ny, z) {
    if (ny > -0.35) return false;
    const edge = Math.abs(nx) > 0.45 || ny < -0.7;
    const sparse = (Math.sin(nx * 40 + ny * 17) * 0.5 + 0.5) > 0.55;
    return edge || (ny < -0.55 && sparse) || z < 0.12;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   */
  function createAuraFace(canvas, opts) {
    opts = opts || {};
    const THREE = global.THREE;
    if (!THREE) throw new Error("THREE is required before AuraFace");

    const parent = canvas.parentElement;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.05, 3.55);
    camera.lookAt(0, -0.05, 0);

    // Lighting — cool cyan / white like the reference
    const key = new THREE.DirectionalLight(0xdff9ff, 1.35);
    key.position.set(0.4, 2.2, 2.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x3b82f6, 0.55);
    fill.position.set(-2.0, 0.2, 1.2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x67e8f9, 0.7);
    rim.position.set(0.2, -1.5, -2.0);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0x0b1a33, 0.55));

    // ---- Build voxel instances ----
    const resX = opts.resX || 56;
    const resY = opts.resY || 72;
    const voxels = [];
    const mouthIndices = [];
    const dissolveIndices = [];

    for (let iy = 0; iy < resY; iy++) {
      for (let ix = 0; ix < resX; ix++) {
        const nx = (ix / (resX - 1)) * 2 - 1;
        const ny = 1.05 - (iy / (resY - 1)) * 2.15;
        const z = faceDepth(nx, ny);
        if (z < 0) continue;

        // Skip some interior samples for performance while keeping silhouette dense
        const border =
          faceDepth(nx + 0.04, ny) < 0 ||
          faceDepth(nx - 0.04, ny) < 0 ||
          faceDepth(nx, ny + 0.04) < 0 ||
          faceDepth(nx, ny - 0.04) < 0;
        if (!border && (ix + iy) % 2 === 1 && !isMouthCell(nx, ny)) continue;

        const dissolve = isDissolveCell(nx, ny, z);
        // Lower face sparsity
        if (dissolve && Math.random() > 0.62) continue;

        const idx = voxels.length;
        const mouth = isMouthCell(nx, ny);
        voxels.push({
          x: nx * 1.05,
          y: ny * 1.05,
          z: z,
          nx,
          ny,
          mouth,
          dissolve,
          phase: Math.random() * Math.PI * 2,
          amp: 0.015 + Math.random() * 0.035,
          seed: Math.random(),
        });
        if (mouth) mouthIndices.push(idx);
        if (dissolve) dissolveIndices.push(idx);
      }
    }

    const count = voxels.length;
    const box = new THREE.BoxGeometry(0.028, 0.055, 0.028);
    // Slightly taller bricks like the reference
    const material = new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x0e7490,
      emissiveIntensity: 0.35,
      metalness: 0.25,
      roughness: 0.35,
      flatShading: true,
    });

    const mesh = new THREE.InstancedMesh(box, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);

    // Per-instance colors (blue → white highlights on forehead/nose)
    {
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        const v = voxels[i];
        const hi = clamp(v.z * 1.1 + v.ny * 0.25 + 0.35, 0, 1);
        c.setRGB(
          lerp(0.12, 0.92, hi),
          lerp(0.35, 0.97, hi),
          lerp(0.55, 1.0, hi)
        );
        if (v.dissolve) c.multiplyScalar(0.75);
        mesh.setColorAt(i, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // Dissolved network lines
    const linePositions = [];
    const maxLinks = Math.min(280, dissolveIndices.length * 2);
    for (let n = 0; n < maxLinks; n++) {
      const a = dissolveIndices[(Math.random() * dissolveIndices.length) | 0];
      const b = dissolveIndices[(Math.random() * dissolveIndices.length) | 0];
      if (a === b) continue;
      const va = voxels[a];
      const vb = voxels[b];
      const dx = va.x - vb.x;
      const dy = va.y - vb.y;
      const dz = va.z - vb.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 0.12 || d2 < 0.008) continue;
      linePositions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    }
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(linePositions, 3)
    );
    const lines = new THREE.LineSegments(
      lineGeom,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    scene.add(lines);

    const dummy = new THREE.Object3D();
    const baseColor = new THREE.Color(0x7dd3fc);
    const targetColor = new THREE.Color(0x7dd3fc);

    let state = "idle";
    let speaking = false;
    let analyser = null;
    let timeDomain = null;
    let freqData = null;

    const mouth = {
      open: 0,
      wide: 0,
      round: 0,
      smile: 0,
      target: { open: 0, wide: 0, round: 0, smile: 0 },
    };

    let energy = 0;
    let smoothEnergy = 0;
    let cameraParallax = { x: 0, y: 0 };

    function setState(next) {
      state = next;
    }

    function blendViseme(name, amount) {
      const v = VISEMES[name] || VISEMES.closed;
      const a = clamp(amount, 0, 1);
      mouth.target.open = lerp(mouth.target.open, v.open, a);
      mouth.target.wide = lerp(mouth.target.wide, v.wide, a);
      mouth.target.round = lerp(mouth.target.round, v.round, a);
      mouth.target.smile = lerp(mouth.target.smile, v.smile, a);
    }

    function analyseAudio() {
      if (!analyser) {
        energy = 0;
        return;
      }
      if (!timeDomain || timeDomain.length !== analyser.fftSize) {
        timeDomain = new Uint8Array(analyser.fftSize);
        freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteTimeDomainData(timeDomain);
      analyser.getByteFrequencyData(freqData);

      let sum = 0;
      for (let i = 0; i < timeDomain.length; i++) {
        const s = (timeDomain[i] - 128) / 128;
        sum += s * s;
      }
      energy = Math.sqrt(sum / timeDomain.length);

      // Band energies for crude viseme guess
      const n = freqData.length;
      let low = 0;
      let mid = 0;
      let high = 0;
      const n1 = (n * 0.15) | 0;
      const n2 = (n * 0.45) | 0;
      for (let i = 0; i < n1; i++) low += freqData[i];
      for (let i = n1; i < n2; i++) mid += freqData[i];
      for (let i = n2; i < n; i++) high += freqData[i];
      low /= n1 * 255;
      mid /= (n2 - n1) * 255;
      high /= (n - n2) * 255;

      // Reset targets toward closed, then push toward speech shapes
      mouth.target.open = 0;
      mouth.target.wide = 0;
      mouth.target.round = 0;
      mouth.target.smile = 0;

      if (energy < 0.02) {
        blendViseme("closed", 1);
      } else if (energy < 0.04 && low > mid) {
        blendViseme("closedLips", 0.85);
      } else if (high > mid * 1.15 && high > low) {
        blendViseme("ee", clamp(energy * 8, 0.3, 1));
        blendViseme("wide", clamp(energy * 5, 0.2, 0.8));
      } else if (low > mid && low > high) {
        blendViseme("open", clamp(energy * 10, 0.35, 1));
        blendViseme("round", clamp(low * 2, 0.2, 0.7));
      } else if (mid > high) {
        blendViseme("wide", clamp(energy * 7, 0.3, 1));
        blendViseme("open", clamp(energy * 5, 0.2, 0.7));
      } else {
        blendViseme("open", clamp(energy * 8, 0.25, 0.95));
      }
    }

    function mouthOffset(v, open, wide, round, smile) {
      if (!v.mouth) return { x: 0, y: 0, z: 0, s: 1 };
      const mx = v.nx / 0.34;
      const my = (v.ny + 0.27) / 0.18;
      // Upper vs lower lip
      const lower = my < 0 ? 1 : 0.15;
      const upper = my > 0 ? 1 : 0.2;

      const oy =
        -open * 0.12 * lower +
        open * 0.04 * upper +
        smile * 0.02 * (1 - Math.abs(mx));
      const ox = wide * 0.07 * mx + smile * 0.03 * mx;
      const oz =
        -open * 0.05 +
        round * 0.08 * (1 - Math.abs(mx) * 0.5) -
        smile * 0.02;
      const s = 1 + open * 0.15 * lower;
      return { x: ox, y: oy, z: oz, s };
    }

    function updateInstances(dt, now) {
      const activity =
        state === "speaking"
          ? 1.35
          : state === "thinking"
            ? 1.15
            : state === "listening"
              ? 1.05
              : 0.85;

      const wave = now * 0.7;
      const speakBoost = speaking ? 1 + smoothEnergy * 2.2 : 1;

      for (let i = 0; i < count; i++) {
        const v = voxels[i];
        // Idle organic motion
        const w1 = Math.sin(wave * 1.1 + v.phase + v.nx * 3.2 + v.ny * 2.1);
        const w2 = Math.sin(wave * 0.55 + v.seed * 12 + v.ny * 4.0);
        const w3 = Math.cos(wave * 0.9 + v.phase * 1.7);

        let dx = w1 * v.amp * 0.45 * activity;
        let dy = w2 * v.amp * 0.55 * activity;
        let dz = w3 * v.amp * 0.9 * activity;

        // Occasional soft drift away & return
        const drift = Math.sin(wave * 0.25 + v.seed * 20);
        if (drift > 0.92) {
          dx += (v.seed - 0.5) * 0.04;
          dz += 0.03;
        }

        // Dissolve region more lively + downward scatter
        if (v.dissolve) {
          dx += w1 * 0.02 * activity;
          dy += -0.01 + w2 * 0.03;
          dz += w3 * 0.04;
        }

        // Thinking: gentle reorganization wave
        if (state === "thinking") {
          const tw = Math.sin(wave * 2.2 + v.nx * 8 + v.ny * 6);
          dz += tw * 0.025;
          dx += tw * 0.01;
        }

        // Speaking energy ripples
        if (speaking) {
          const rip = Math.sin(wave * 4 + v.ny * 10 + smoothEnergy * 8);
          dz += rip * 0.02 * speakBoost * (0.4 + Math.abs(v.nx));
        }

        const mo = mouthOffset(
          v,
          mouth.open,
          mouth.wide,
          mouth.round,
          mouth.smile
        );

        const sx = 1 * (v.dissolve ? 0.85 : 1);
        const sy = (v.dissolve ? 0.9 : 1.15) * mo.s;
        const sz = 1 * (v.dissolve ? 0.85 : 1);

        dummy.position.set(
          v.x + dx + mo.x,
          v.y + dy + mo.y,
          v.z + dz + mo.z
        );
        dummy.scale.set(sx, sy, sz);
        dummy.rotation.set(
          w2 * 0.08 * activity,
          w1 * 0.06 * activity,
          w3 * 0.05 * activity
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;

      // Network opacity breathes
      lines.material.opacity =
        0.22 +
        0.12 * Math.sin(now * 0.8) +
        (speaking ? 0.15 * smoothEnergy : 0) +
        (state === "thinking" ? 0.1 : 0);
    }

    function resize(w, h) {
      if (!w || !h) {
        w = parent.clientWidth;
        h = parent.clientHeight;
      }
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function update(dt, nowSec) {
      const now = nowSec != null ? nowSec : performance.now() / 1000;

      if (speaking) analyseAudio();
      else {
        mouth.target.open *= 0.9;
        mouth.target.wide *= 0.9;
        mouth.target.round *= 0.9;
        mouth.target.smile *= 0.9;
        energy *= 0.92;
      }

      const follow = speaking ? 14 : 8;
      const k = 1 - Math.exp(-follow * dt);
      mouth.open = lerp(mouth.open, mouth.target.open, k);
      mouth.wide = lerp(mouth.wide, mouth.target.wide, k);
      mouth.round = lerp(mouth.round, mouth.target.round, k);
      mouth.smile = lerp(mouth.smile, mouth.target.smile, k);
      smoothEnergy = lerp(smoothEnergy, energy, 1 - Math.exp(-10 * dt));

      // Subtle camera parallax
      const px = Math.sin(now * 0.25) * 0.04;
      const py = Math.cos(now * 0.18) * 0.025;
      cameraParallax.x = lerp(cameraParallax.x, px, 0.04);
      cameraParallax.y = lerp(cameraParallax.y, py, 0.04);
      camera.position.x = cameraParallax.x;
      camera.position.y = 0.05 + cameraParallax.y;
      camera.lookAt(0, -0.05, 0);

      // Tint by state
      if (state === "speaking") targetColor.setHex(0xa5f3fc);
      else if (state === "listening") targetColor.setHex(0x6ee7b7);
      else if (state === "thinking") targetColor.setHex(0xfde68a);
      else targetColor.setHex(0x7dd3fc);
      baseColor.lerp(targetColor, 0.05);
      material.color.copy(baseColor);
      material.emissiveIntensity = 0.3 + smoothEnergy * 0.55;

      updateInstances(dt, now);
      renderer.render(scene, camera);
    }

    // ---- Public event API ----
    function onListeningStart() {
      setState("listening");
    }
    function onListeningEnd() {
      if (state === "listening") setState("idle");
    }
    function onThinkingStart() {
      setState("thinking");
    }
    function onThinkingEnd() {
      if (state === "thinking") setState("idle");
    }
    function onTTSStart(_audioData, _timingData) {
      speaking = true;
      setState("speaking");
      // timingData / phonemes reserved for future viseme timeline
      if (_timingData && Array.isArray(_timingData.visemes)) {
        // stash for onTTSProgress if provided later
        api._visemeTrack = _timingData.visemes;
      } else {
        api._visemeTrack = null;
      }
    }
    function onTTSProgress(timestamp) {
      if (!api._visemeTrack || !api._visemeTrack.length) return;
      const t = timestamp || 0;
      let best = api._visemeTrack[0];
      for (let i = 0; i < api._visemeTrack.length; i++) {
        if (api._visemeTrack[i].t <= t) best = api._visemeTrack[i];
        else break;
      }
      if (best && best.name) {
        mouth.target.open = 0;
        mouth.target.wide = 0;
        mouth.target.round = 0;
        mouth.target.smile = 0;
        blendViseme(best.name, 1);
      }
    }
    function onTTSEnd() {
      speaking = false;
      api._visemeTrack = null;
      mouth.target.open = 0;
      mouth.target.wide = 0;
      mouth.target.round = 0;
      mouth.target.smile = 0;
      if (state === "speaking") setState("idle");
    }

    function setAnalyser(node) {
      analyser = node || null;
    }

    function dispose() {
      mesh.dispose();
      box.dispose();
      material.dispose();
      lineGeom.dispose();
      lines.material.dispose();
      renderer.dispose();
    }

    const api = {
      onListeningStart,
      onListeningEnd,
      onThinkingStart,
      onThinkingEnd,
      onTTSStart,
      onTTSProgress,
      onTTSEnd,
      setAnalyser,
      update,
      resize,
      dispose,
      get state() {
        return state;
      },
      get voxelCount() {
        return count;
      },
      _visemeTrack: null,
    };

    resize();
    // Initial matrices
    updateInstances(0.016, 0);
    return api;
  }

  global.AuraFace = { create: createAuraFace, VISEMES };
})(typeof window !== "undefined" ? window : globalThis);
