// enhanced-pmrem.js
//
// Forked from three.js r184 examples/jsm equivalent of src/extras/PMREMGenerator.js.
// Single change of substance: LOD_MIN raised from 4 → 7, so the smallest PMREM
// mip is 128×128 per cube face instead of 16×16. That's what controls the perceived
// "blockiness" of high-roughness reflections — three.js's stock LOD_MIN=4 floor
// is what makes matte metals look pixelated even with a 4k source HDR.
//
// Because the cubeUV layout shifts when LOD_MIN changes, materials that *read*
// the PMREM need their cube_uv_reflection_fragment shader chunk patched so the
// roughness→mip math lines up. Use `patchMaterialForEnhancedPMREM(mat)` for that.

import * as THREE from "three";

// Smallest PMREM mip is 2^LOD_MIN pixels per cube face.
//   Stock three.js: 4 → 16×16 (visibly blocky at high roughness)
//   Our fork:       7 → 128×128 (effectively smooth)
// Bumping further (8 → 256×256) widens the cubeUV atlas so each ping-pong
// render target grows ~2×; not worth it on top of 4k HDR input.
const LOD_MIN = 7;

// Standard deviations (radians) for the extra "deep blur" mips, used when
// sigma > 0 is passed to fromScene(). Unchanged from stock.
const EXTRA_LOD_SIGMA = [0.125, 0.215, 0.35, 0.446, 0.526, 0.582];

// Max length of the Gaussian blur for-loop. Higher sigma needs more samples;
// stock value is fine (20).
const MAX_SAMPLES = 20;

// GGX VNDF importance samples per output pixel for the radiance prefilter.
// Stock r184 is 256; 1024 noticeably cleans up mid-roughness banding at the
// cost of ~4× longer PMREM generation. Only runs at env load time, then
// cached, so the cost is amortised.
const GGX_SAMPLES = 1024;

// Module-scope scratch state, mirroring stock layout.
// NOTE: this state is shared across all EnhancedPMREMGenerator instances.
// Two generators running concurrently would clobber each other's saved
// renderer state. Today only one is constructed by PBRViewer — if you ever
// add another, move these into per-instance fields.
const _flatCamera = new THREE.OrthographicCamera();
const _clearColor = new THREE.Color();
let _oldTarget = null;
let _oldActiveCubeFace = 0;
let _oldActiveMipmapLevel = 0;
let _oldXrEnabled = false;
const _origin = new THREE.Vector3();

class EnhancedPMREMGenerator {
  constructor(renderer) {
    this._renderer = renderer;
    this._pingPongRenderTarget = null;

    this._lodMax = 0;
    this._cubeSize = 0;
    this._sizeLods = [];
    this._sigmas = [];
    this._lodMeshes = [];

    this._backgroundBox = null;
    this._cubemapMaterial = null;
    this._equirectMaterial = null;
    this._blurMaterial = null;
    this._ggxMaterial = null;
  }

  /** PMREM from a Scene, with optional Gaussian pre-blur of radius `sigma`. */
  fromScene(scene, sigma = 0, near = 0.1, far = 100, options = {}) {
    const { size = 256, position = _origin } = options;

    _oldTarget = this._renderer.getRenderTarget();
    _oldActiveCubeFace = this._renderer.getActiveCubeFace();
    _oldActiveMipmapLevel = this._renderer.getActiveMipmapLevel();
    _oldXrEnabled = this._renderer.xr.enabled;
    this._renderer.xr.enabled = false;

    this._setSize(size);
    const cubeUVRenderTarget = this._allocateTargets();
    cubeUVRenderTarget.depthBuffer = true;

    this._sceneToCubeUV(scene, near, far, cubeUVRenderTarget, position);

    if (sigma > 0) {
      this._blur(cubeUVRenderTarget, 0, 0, sigma);
    }

    this._applyPMREM(cubeUVRenderTarget);
    this._cleanup(cubeUVRenderTarget);
    return cubeUVRenderTarget;
  }

  fromEquirectangular(equirectangular, renderTarget = null) {
    return this._fromTexture(equirectangular, renderTarget);
  }

  fromCubemap(cubemap, renderTarget = null) {
    return this._fromTexture(cubemap, renderTarget);
  }

  dispose() {
    this._dispose();
    if (this._cubemapMaterial !== null) this._cubemapMaterial.dispose();
    if (this._equirectMaterial !== null) this._equirectMaterial.dispose();
    if (this._backgroundBox !== null) {
      this._backgroundBox.geometry.dispose();
      this._backgroundBox.material.dispose();
    }
  }

  // ── private interface ─────────────────────────────────────────────────

  _setSize(cubeSize) {
    this._lodMax = Math.floor(Math.log2(cubeSize));
    this._cubeSize = Math.pow(2, this._lodMax);
  }

  _dispose() {
    if (this._blurMaterial !== null) this._blurMaterial.dispose();
    if (this._ggxMaterial !== null) this._ggxMaterial.dispose();
    if (this._pingPongRenderTarget !== null) this._pingPongRenderTarget.dispose();
    for (let i = 0; i < this._lodMeshes.length; i++) {
      this._lodMeshes[i].geometry.dispose();
    }
  }

  _cleanup(outputTarget) {
    this._renderer.setRenderTarget(_oldTarget, _oldActiveCubeFace, _oldActiveMipmapLevel);
    this._renderer.xr.enabled = _oldXrEnabled;
    outputTarget.scissorTest = false;
    _setViewport(outputTarget, 0, 0, outputTarget.width, outputTarget.height);
  }

  _fromTexture(texture, renderTarget) {
    if (
      texture.mapping === THREE.CubeReflectionMapping ||
      texture.mapping === THREE.CubeRefractionMapping
    ) {
      this._setSize(
        texture.image.length === 0
          ? 16
          : (texture.image[0].width || texture.image[0].image.width),
      );
    } else {
      // Equirectangular
      this._setSize(texture.image.width / 4);
    }

    _oldTarget = this._renderer.getRenderTarget();
    _oldActiveCubeFace = this._renderer.getActiveCubeFace();
    _oldActiveMipmapLevel = this._renderer.getActiveMipmapLevel();
    _oldXrEnabled = this._renderer.xr.enabled;
    this._renderer.xr.enabled = false;

    const cubeUVRenderTarget = renderTarget || this._allocateTargets();
    this._textureToCubeUV(texture, cubeUVRenderTarget);
    this._applyPMREM(cubeUVRenderTarget);
    this._cleanup(cubeUVRenderTarget);
    return cubeUVRenderTarget;
  }

  _allocateTargets() {
    // The 7 trailing extra-mip slots are LOD_MIN-sized. Stock used `16 * 7`
    // because LOD_MIN was 4 → 16-pixel mips; we use the actual tile size.
    const minTileSize = 1 << LOD_MIN;
    const width = 3 * Math.max(this._cubeSize, minTileSize * 7);
    const height = 4 * this._cubeSize;

    const params = {
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
    };

    const cubeUVRenderTarget = _createRenderTarget(width, height, params);

    if (
      this._pingPongRenderTarget === null ||
      this._pingPongRenderTarget.width !== width ||
      this._pingPongRenderTarget.height !== height
    ) {
      if (this._pingPongRenderTarget !== null) this._dispose();
      this._pingPongRenderTarget = _createRenderTarget(width, height, params);

      const { _lodMax } = this;
      ({
        lodMeshes: this._lodMeshes,
        sizeLods: this._sizeLods,
        sigmas: this._sigmas,
      } = _createPlanes(_lodMax));

      this._blurMaterial = _getBlurShader(_lodMax, width, height);
      this._ggxMaterial = _getGGXShader(_lodMax, width, height);
    }

    return cubeUVRenderTarget;
  }

  _compileMaterial(material) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this._renderer.compile(mesh, _flatCamera);
  }

  _sceneToCubeUV(scene, near, far, cubeUVRenderTarget, position) {
    const fov = 90;
    const aspect = 1;
    const cubeCamera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    const upSign = [1, -1, 1, 1, 1, 1];
    const forwardSign = [1, 1, 1, -1, -1, -1];
    const renderer = this._renderer;

    const originalAutoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    renderer.getClearColor(_clearColor);

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = false;

    const reversedDepthBuffer = renderer.state.buffers.depth.getReversed();
    if (reversedDepthBuffer) {
      renderer.setRenderTarget(cubeUVRenderTarget);
      renderer.clearDepth();
      renderer.setRenderTarget(null);
    }

    if (this._backgroundBox === null) {
      this._backgroundBox = new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial({
          name: "PMREM.Background",
          side: THREE.BackSide,
          depthWrite: false,
          depthTest: false,
        }),
      );
    }

    const backgroundBox = this._backgroundBox;
    const backgroundMaterial = backgroundBox.material;

    let useSolidColor = false;
    const background = scene.background;

    if (background) {
      if (background.isColor) {
        backgroundMaterial.color.copy(background);
        scene.background = null;
        useSolidColor = true;
      }
    } else {
      backgroundMaterial.color.copy(_clearColor);
      useSolidColor = true;
    }

    for (let i = 0; i < 6; i++) {
      const col = i % 3;
      if (col === 0) {
        cubeCamera.up.set(0, upSign[i], 0);
        cubeCamera.position.set(position.x, position.y, position.z);
        cubeCamera.lookAt(position.x + forwardSign[i], position.y, position.z);
      } else if (col === 1) {
        cubeCamera.up.set(0, 0, upSign[i]);
        cubeCamera.position.set(position.x, position.y, position.z);
        cubeCamera.lookAt(position.x, position.y + forwardSign[i], position.z);
      } else {
        cubeCamera.up.set(0, upSign[i], 0);
        cubeCamera.position.set(position.x, position.y, position.z);
        cubeCamera.lookAt(position.x, position.y, position.z + forwardSign[i]);
      }

      const size = this._cubeSize;
      _setViewport(cubeUVRenderTarget, col * size, i > 2 ? size : 0, size, size);

      renderer.setRenderTarget(cubeUVRenderTarget);
      if (useSolidColor) renderer.render(backgroundBox, cubeCamera);
      renderer.render(scene, cubeCamera);
    }

    renderer.toneMapping = toneMapping;
    renderer.autoClear = originalAutoClear;
    scene.background = background;
  }

  _textureToCubeUV(texture, cubeUVRenderTarget) {
    const renderer = this._renderer;
    const isCubeTexture =
      texture.mapping === THREE.CubeReflectionMapping ||
      texture.mapping === THREE.CubeRefractionMapping;

    if (isCubeTexture) {
      if (this._cubemapMaterial === null) this._cubemapMaterial = _getCubemapMaterial();
      this._cubemapMaterial.uniforms.flipEnvMap.value =
        texture.isRenderTargetTexture === false ? -1 : 1;
    } else {
      if (this._equirectMaterial === null) this._equirectMaterial = _getEquirectMaterial();
    }

    const material = isCubeTexture ? this._cubemapMaterial : this._equirectMaterial;
    const mesh = this._lodMeshes[0];
    mesh.material = material;
    material.uniforms["envMap"].value = texture;

    const size = this._cubeSize;
    _setViewport(cubeUVRenderTarget, 0, 0, 3 * size, 2 * size);

    renderer.setRenderTarget(cubeUVRenderTarget);
    renderer.render(mesh, _flatCamera);
  }

  _applyPMREM(cubeUVRenderTarget) {
    const renderer = this._renderer;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    const n = this._lodMeshes.length;
    for (let i = 1; i < n; i++) {
      this._applyGGXFilter(cubeUVRenderTarget, i - 1, i);
    }
    renderer.autoClear = autoClear;
  }

  _applyGGXFilter(cubeUVRenderTarget, lodIn, lodOut) {
    const renderer = this._renderer;
    const pingPongRenderTarget = this._pingPongRenderTarget;

    const ggxMaterial = this._ggxMaterial;
    const ggxMesh = this._lodMeshes[lodOut];
    ggxMesh.material = ggxMaterial;

    const ggxUniforms = ggxMaterial.uniforms;

    const targetRoughness = lodOut / (this._lodMeshes.length - 1);
    const sourceRoughness = lodIn / (this._lodMeshes.length - 1);
    const incrementalRoughness = Math.sqrt(
      targetRoughness * targetRoughness - sourceRoughness * sourceRoughness,
    );

    const blurStrength = 0.0 + targetRoughness * 1.25;
    const adjustedRoughness = incrementalRoughness * blurStrength;

    const { _lodMax } = this;
    const outputSize = this._sizeLods[lodOut];
    const x = 3 * outputSize * (lodOut > _lodMax - LOD_MIN ? lodOut - _lodMax + LOD_MIN : 0);
    const y = 4 * (this._cubeSize - outputSize);

    ggxUniforms["envMap"].value = cubeUVRenderTarget.texture;
    ggxUniforms["roughness"].value = adjustedRoughness;
    ggxUniforms["mipInt"].value = _lodMax - lodIn;

    _setViewport(pingPongRenderTarget, x, y, 3 * outputSize, 2 * outputSize);
    renderer.setRenderTarget(pingPongRenderTarget);
    renderer.render(ggxMesh, _flatCamera);

    ggxUniforms["envMap"].value = pingPongRenderTarget.texture;
    ggxUniforms["roughness"].value = 0.0;
    ggxUniforms["mipInt"].value = _lodMax - lodOut;

    _setViewport(cubeUVRenderTarget, x, y, 3 * outputSize, 2 * outputSize);
    renderer.setRenderTarget(cubeUVRenderTarget);
    renderer.render(ggxMesh, _flatCamera);
  }

  _blur(cubeUVRenderTarget, lodIn, lodOut, sigma, poleAxis) {
    const pingPongRenderTarget = this._pingPongRenderTarget;
    this._halfBlur(cubeUVRenderTarget, pingPongRenderTarget, lodIn, lodOut, sigma, "latitudinal", poleAxis);
    this._halfBlur(pingPongRenderTarget, cubeUVRenderTarget, lodOut, lodOut, sigma, "longitudinal", poleAxis);
  }

  _halfBlur(targetIn, targetOut, lodIn, lodOut, sigmaRadians, direction, poleAxis) {
    const renderer = this._renderer;
    const blurMaterial = this._blurMaterial;

    if (direction !== "latitudinal" && direction !== "longitudinal") {
      console.error("blur direction must be either latitudinal or longitudinal!");
    }

    const STANDARD_DEVIATIONS = 3;
    const blurMesh = this._lodMeshes[lodOut];
    blurMesh.material = blurMaterial;
    const blurUniforms = blurMaterial.uniforms;

    const pixels = this._sizeLods[lodIn] - 1;
    const radiansPerPixel = isFinite(sigmaRadians)
      ? Math.PI / (2 * pixels)
      : (2 * Math.PI) / (2 * MAX_SAMPLES - 1);
    const sigmaPixels = sigmaRadians / radiansPerPixel;
    const samples = isFinite(sigmaRadians)
      ? 1 + Math.floor(STANDARD_DEVIATIONS * sigmaPixels)
      : MAX_SAMPLES;

    if (samples > MAX_SAMPLES) {
      console.warn(
        `sigmaRadians, ${sigmaRadians}, is too large and will clip, as it requested ${samples} samples when the maximum is set to ${MAX_SAMPLES}`,
      );
    }

    const weights = [];
    let sum = 0;
    for (let i = 0; i < MAX_SAMPLES; ++i) {
      const x = i / sigmaPixels;
      const weight = Math.exp((-x * x) / 2);
      weights.push(weight);
      if (i === 0) sum += weight;
      else if (i < samples) sum += 2 * weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] = weights[i] / sum;

    blurUniforms["envMap"].value = targetIn.texture;
    blurUniforms["samples"].value = samples;
    blurUniforms["weights"].value = weights;
    blurUniforms["latitudinal"].value = direction === "latitudinal";
    if (poleAxis) blurUniforms["poleAxis"].value = poleAxis;

    const { _lodMax } = this;
    blurUniforms["dTheta"].value = radiansPerPixel;
    blurUniforms["mipInt"].value = _lodMax - lodIn;

    const outputSize = this._sizeLods[lodOut];
    const x = 3 * outputSize * (lodOut > _lodMax - LOD_MIN ? lodOut - _lodMax + LOD_MIN : 0);
    const y = 4 * (this._cubeSize - outputSize);

    _setViewport(targetOut, x, y, 3 * outputSize, 2 * outputSize);
    renderer.setRenderTarget(targetOut);
    renderer.render(blurMesh, _flatCamera);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function _createPlanes(lodMax) {
  const sizeLods = [];
  const sigmas = [];
  const lodMeshes = [];
  let lod = lodMax;
  const totalLods = lodMax - LOD_MIN + 1 + EXTRA_LOD_SIGMA.length;

  for (let i = 0; i < totalLods; i++) {
    const sizeLod = Math.pow(2, lod);
    sizeLods.push(sizeLod);
    let sigma = 1.0 / sizeLod;

    if (i > lodMax - LOD_MIN) {
      sigma = EXTRA_LOD_SIGMA[i - lodMax + LOD_MIN - 1];
    } else if (i === 0) {
      sigma = 0;
    }
    sigmas.push(sigma);

    const texelSize = 1.0 / (sizeLod - 2);
    const min = -texelSize;
    const max = 1 + texelSize;
    const uv1 = [min, min, max, min, max, max, min, min, max, max, min, max];

    const cubeFaces = 6;
    const vertices = 6;
    const positionSize = 3;
    const uvSize = 2;
    const faceIndexSize = 1;

    const position = new Float32Array(positionSize * vertices * cubeFaces);
    const uv = new Float32Array(uvSize * vertices * cubeFaces);
    const faceIndex = new Float32Array(faceIndexSize * vertices * cubeFaces);

    for (let face = 0; face < cubeFaces; face++) {
      const x = (face % 3) * 2 / 3 - 1;
      const y = face > 2 ? 0 : -1;
      const coordinates = [
        x, y, 0,
        x + 2 / 3, y, 0,
        x + 2 / 3, y + 1, 0,
        x, y, 0,
        x + 2 / 3, y + 1, 0,
        x, y + 1, 0,
      ];
      position.set(coordinates, positionSize * vertices * face);
      uv.set(uv1, uvSize * vertices * face);
      const fill = [face, face, face, face, face, face];
      faceIndex.set(fill, faceIndexSize * vertices * face);
    }

    const planes = new THREE.BufferGeometry();
    planes.setAttribute("position", new THREE.BufferAttribute(position, positionSize));
    planes.setAttribute("uv", new THREE.BufferAttribute(uv, uvSize));
    planes.setAttribute("faceIndex", new THREE.BufferAttribute(faceIndex, faceIndexSize));
    lodMeshes.push(new THREE.Mesh(planes, null));

    if (lod > LOD_MIN) lod--;
  }

  return { lodMeshes, sizeLods, sigmas };
}

function _createRenderTarget(width, height, params) {
  const rt = new THREE.WebGLRenderTarget(width, height, params);
  rt.texture.mapping = THREE.CubeUVReflectionMapping;
  rt.texture.name = "PMREM.cubeUv";
  rt.scissorTest = true;
  return rt;
}

function _setViewport(target, x, y, width, height) {
  target.viewport.set(x, y, width, height);
  target.scissor.set(x, y, width, height);
}

function _getGGXShader(lodMax, width, height) {
  const mat = new THREE.ShaderMaterial({
    name: "PMREMGGXConvolution",
    defines: {
      GGX_SAMPLES: GGX_SAMPLES,
      CUBEUV_TEXEL_WIDTH: 1.0 / width,
      CUBEUV_TEXEL_HEIGHT: 1.0 / height,
      CUBEUV_MAX_MIP: `${lodMax}.0`,
    },
    uniforms: {
      envMap: { value: null },
      roughness: { value: 0.0 },
      mipInt: { value: 0 },
    },
    vertexShader: _getCommonVertexShader(),
    fragmentShader: /* glsl */ `

      precision highp float;
      precision highp int;

      varying vec3 vOutputDirection;

      uniform sampler2D envMap;
      uniform float roughness;
      uniform float mipInt;

      #define ENVMAP_TYPE_CUBE_UV
      #include <cube_uv_reflection_fragment>

      #define PI 3.14159265359

      float radicalInverse_VdC(uint bits) {
        bits = (bits << 16u) | (bits >> 16u);
        bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
        bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
        bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
        bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
        return float(bits) * 2.3283064365386963e-10;
      }

      vec2 hammersley(uint i, uint N) {
        return vec2(float(i) / float(N), radicalInverse_VdC(i));
      }

      vec3 importanceSampleGGX_VNDF(vec2 Xi, vec3 V, float roughness) {
        float alpha = roughness * roughness;
        vec3 T1 = vec3(1.0, 0.0, 0.0);
        vec3 T2 = cross(V, T1);
        float r = sqrt(Xi.x);
        float phi = 2.0 * PI * Xi.y;
        float t1 = r * cos(phi);
        float t2 = r * sin(phi);
        float s = 0.5 * (1.0 + V.z);
        t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;
        vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * V;
        return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
      }

      void main() {
        vec3 N = normalize(vOutputDirection);
        vec3 V = N;

        vec3 prefilteredColor = vec3(0.0);
        float totalWeight = 0.0;

        if (roughness < 0.001) {
          gl_FragColor = vec4(bilinearCubeUV(envMap, N, mipInt), 1.0);
          return;
        }

        vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        vec3 tangent = normalize(cross(up, N));
        vec3 bitangent = cross(N, tangent);

        for(uint i = 0u; i < uint(GGX_SAMPLES); i++) {
          vec2 Xi = hammersley(i, uint(GGX_SAMPLES));
          vec3 H_tangent = importanceSampleGGX_VNDF(Xi, vec3(0.0, 0.0, 1.0), roughness);
          vec3 H = normalize(tangent * H_tangent.x + bitangent * H_tangent.y + N * H_tangent.z);
          vec3 L = normalize(2.0 * dot(V, H) * H - V);
          float NdotL = max(dot(N, L), 0.0);
          if(NdotL > 0.0) {
            vec3 sampleColor = bilinearCubeUV(envMap, L, mipInt);
            prefilteredColor += sampleColor * NdotL;
            totalWeight += NdotL;
          }
        }

        if (totalWeight > 0.0) prefilteredColor = prefilteredColor / totalWeight;
        gl_FragColor = vec4(prefilteredColor, 1.0);
      }
    `,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  // Patch the cube_uv chunk constants to match our LOD_MIN.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = _patchCubeUVChunk(shader.fragmentShader);
  };
  return mat;
}

function _getBlurShader(lodMax, width, height) {
  const weights = new Float32Array(MAX_SAMPLES);
  const poleAxis = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.ShaderMaterial({
    name: "SphericalGaussianBlur",
    defines: {
      n: MAX_SAMPLES,
      CUBEUV_TEXEL_WIDTH: 1.0 / width,
      CUBEUV_TEXEL_HEIGHT: 1.0 / height,
      CUBEUV_MAX_MIP: `${lodMax}.0`,
    },
    uniforms: {
      envMap: { value: null },
      samples: { value: 1 },
      weights: { value: weights },
      latitudinal: { value: false },
      dTheta: { value: 0 },
      mipInt: { value: 0 },
      poleAxis: { value: poleAxis },
    },
    vertexShader: _getCommonVertexShader(),
    fragmentShader: /* glsl */ `

      precision mediump float;
      precision mediump int;

      varying vec3 vOutputDirection;

      uniform sampler2D envMap;
      uniform int samples;
      uniform float weights[ n ];
      uniform bool latitudinal;
      uniform float dTheta;
      uniform float mipInt;
      uniform vec3 poleAxis;

      #define ENVMAP_TYPE_CUBE_UV
      #include <cube_uv_reflection_fragment>

      vec3 getSample( float theta, vec3 axis ) {
        float cosTheta = cos( theta );
        vec3 sampleDirection = vOutputDirection * cosTheta
          + cross( axis, vOutputDirection ) * sin( theta )
          + axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );
        return bilinearCubeUV( envMap, sampleDirection, mipInt );
      }

      void main() {
        vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );
        if ( all( equal( axis, vec3( 0.0 ) ) ) ) {
          axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );
        }
        axis = normalize( axis );

        gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
        gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

        for ( int i = 1; i < n; i++ ) {
          if ( i >= samples ) break;
          float theta = dTheta * float( i );
          gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
          gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );
        }
      }
    `,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = _patchCubeUVChunk(shader.fragmentShader);
  };
  return mat;
}

function _getEquirectMaterial() {
  return new THREE.ShaderMaterial({
    name: "EquirectangularToCubeUV",
    uniforms: { envMap: { value: null } },
    vertexShader: _getCommonVertexShader(),
    fragmentShader: /* glsl */ `

      precision mediump float;
      precision mediump int;

      varying vec3 vOutputDirection;
      uniform sampler2D envMap;

      #include <common>

      void main() {
        vec3 outputDirection = normalize( vOutputDirection );
        vec2 uv = equirectUv( outputDirection );
        gl_FragColor = vec4( texture2D( envMap, uv ).rgb, 1.0 );
      }
    `,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function _getCubemapMaterial() {
  return new THREE.ShaderMaterial({
    name: "CubemapToCubeUV",
    uniforms: { envMap: { value: null }, flipEnvMap: { value: -1 } },
    vertexShader: _getCommonVertexShader(),
    fragmentShader: /* glsl */ `

      precision mediump float;
      precision mediump int;

      uniform float flipEnvMap;
      varying vec3 vOutputDirection;
      uniform samplerCube envMap;

      void main() {
        gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );
      }
    `,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function _getCommonVertexShader() {
  return /* glsl */ `

    precision mediump float;
    precision mediump int;

    attribute float faceIndex;
    varying vec3 vOutputDirection;

    vec3 getDirection( vec2 uv, float face ) {
      uv = 2.0 * uv - 1.0;
      vec3 direction = vec3( uv, 1.0 );
      if ( face == 0.0 ) {
        direction = direction.zyx;
      } else if ( face == 1.0 ) {
        direction = direction.xzy;
        direction.xz *= -1.0;
      } else if ( face == 2.0 ) {
        direction.x *= -1.0;
      } else if ( face == 3.0 ) {
        direction = direction.zyx;
        direction.xz *= -1.0;
      } else if ( face == 4.0 ) {
        direction = direction.xzy;
        direction.xy *= -1.0;
      } else if ( face == 5.0 ) {
        direction.z *= -1.0;
      }
      return direction;
    }

    void main() {
      vOutputDirection = getDirection( uv, faceIndex );
      gl_Position = vec4( position, 1.0 );
    }
  `;
}

// ── shader patch ──────────────────────────────────────────────────────────
//
// The cube_uv_reflection_fragment chunk encodes the stock LOD_MIN=4 layout in
// several constants. To swap it for our LOD_MIN layout we shift the relevant
// mip-space values by (LOD_MIN - 4) so the trailing-slot math still lands in
// the available extra-mip positions.
//
//   * cubeUV_m{0,1,4,5,6}        shifted by +2 (mirror moves +2 in mip-space)
//   * log2 constant adjusted      keeps the formula continuous at the
//                                cubeUV_r6 transition point (since
//                                -2*log2(0.5*x) = -2*log2(x) + 2)
//   * cubeUV_minMipLevel  4 → LOD_MIN
//   * cubeUV_minTileSize  16 → 2^LOD_MIN

// onBeforeCompile fires BEFORE three.js resolves #include directives, so a
// regex over the shader source won't see the chunk's body. We expand the
// include ourselves (using the chunk from THREE.ShaderChunk) and patch the
// expanded text, then substitute it for the #include line.
function _patchedCubeUVChunkContent() {
  const shift = LOD_MIN - 4;
  const minMip = `${LOD_MIN}.0`;
  const minTile = `${1 << LOD_MIN}.0`;
  const stock = THREE.ShaderChunk["cube_uv_reflection_fragment"];

  // Each patch must hit at least once; if a future three.js release reformats
  // the chunk (different whitespace, different numeric form, renamed defines)
  // a regex would silently miss and reflections would render with broken
  // mip-space math. Assert every substitution to fail loudly instead.
  const patches = [
    [/#define\s+cubeUV_minMipLevel\s+4\.0/g, `#define cubeUV_minMipLevel ${minMip}`],
    [/#define\s+cubeUV_minTileSize\s+16\.0/g, `#define cubeUV_minTileSize ${minTile}`],
    [/#define\s+cubeUV_m0\s+-\s*2\.0/g, `#define cubeUV_m0 ${-2 + shift}.0`],
    [/#define\s+cubeUV_m1\s+-\s*1\.0/g, `#define cubeUV_m1 ${-1 + shift}.0`],
    [/#define\s+cubeUV_m4\s+2\.0/g, `#define cubeUV_m4 ${2 + shift}.0`],
    [/#define\s+cubeUV_m5\s+3\.0/g, `#define cubeUV_m5 ${3 + shift}.0`],
    [/#define\s+cubeUV_m6\s+4\.0/g, `#define cubeUV_m6 ${4 + shift}.0`],
    // Shift the log2 formula: -2*log2(1.16*r) → -2*log2(1.16*r) + shift.
    // Algebraic identity: -2*log2(0.5*x) = -2*log2(x) + 2, so replace the
    // 1.16 constant with 1.16 / 2^(shift/2).
    [
      /-\s*2\.0\s*\*\s*log2\(\s*1\.16\s*\*\s*roughness\s*\)/g,
      `-2.0 * log2(${(1.16 / Math.pow(2, shift / 2)).toFixed(4)} * roughness)`,
    ],
  ];

  let patched = stock;
  for (const [pattern, replacement] of patches) {
    if (!pattern.test(patched)) {
      throw new Error(
        `EnhancedPMREMGenerator: pattern ${pattern} did not match in ` +
        `cube_uv_reflection_fragment chunk. three.js may have changed the ` +
        `chunk format — re-derive the patches for the current version.`,
      );
    }
    patched = patched.replace(pattern, replacement);
  }
  return patched;
}

let _patchedChunkCache = null;
function _patchCubeUVChunk(src) {
  if (_patchedChunkCache === null) _patchedChunkCache = _patchedCubeUVChunkContent();
  return src.replace(
    /#include\s+<cube_uv_reflection_fragment>/g,
    _patchedChunkCache,
  );
}

// ── material patch ────────────────────────────────────────────────────────
// Materials that read our PMREM need their cube_uv_reflection_fragment chunk
// patched so all the layout constants match. Idempotent.

const __PATCH_TAG = "__enhancedPmremPatched";

export function patchMaterialForEnhancedPMREM(material) {
  if (material[__PATCH_TAG]) return;
  const userOnBeforeCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (userOnBeforeCompile) userOnBeforeCompile(shader, renderer);
    shader.fragmentShader = _patchCubeUVChunk(shader.fragmentShader);
  };
  material[__PATCH_TAG] = true;
  material.needsUpdate = true;
}

export { EnhancedPMREMGenerator };
export const ENHANCED_LOD_MIN = LOD_MIN;
