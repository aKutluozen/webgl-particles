import chroma from "chroma-js";
import { glsl, twgl } from "./WebGL";

const createShader = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string
) => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!compiled) {
    console.error(source);
    let i = 1;
    for (const line of source.split("\n")) {
      console.log(i, line);
      i++;
    }
    throw new Error(gl.getShaderInfoLog(shader) || "unknown error");
  }
  return shader;
};

const attachVerticesToProgram = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  array: Float32Array,
  name: string
) => {
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return buffer;
};

const createShaderProgram = (
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
) => {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program");
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);

  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  return program;
};

const createFullscreenProgram = (
  gl: WebGL2RenderingContext,
  fragmentSource: string
) => {
  const program = createShaderProgram(
    gl,
    glsl`
        in vec2 pos;
        void main() {
            gl_Position = vec4(pos, 0, 1);
        }
    `,
    fragmentSource
  );

  const buffer = attachVerticesToProgram(
    gl,
    program,
    new Float32Array([
      -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
    ]),
    "pos"
  );

  return [program, buffer] as const;
};

const createDataTexture = (
  gl: WebGL2RenderingContext,
  array: Float32Array,
  width: number,
  height: number
) => {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create texture");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA32F,
    width,
    height,
    0,
    gl.RGBA,
    gl.FLOAT,
    array
  );

  return texture;
};

const createDoubleBufferTexture = (
  size: number,
  init: (i: number) => [number, number, number, number] | undefined,
  gl: WebGL2RenderingContext
) => {
  const data = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const arr = init(i);
    if (!arr) {
      break;
    }
    let O = i * 4 - 1;

    data[++O] = arr[0];
    data[++O] = arr[1];
    data[++O] = arr[2];
    data[++O] = arr[3];
  }

  let read = createDataTexture(gl, data, size, size);
  let write = createDataTexture(gl, data, size, size);

  return {
    getRead() {
      return read;
    },
    getWrite() {
      return write;
    },
    swap() {
      [read, write] = [write, read];
    },
  };
};

const PARTICLE_COUNT = 20000;

const createParticles = (gl: WebGL2RenderingContext, particleCount: number) => {
  gl.getExtension("EXT_color_buffer_float");

  let textureSize = 2;
  while (textureSize * textureSize < particleCount) {
    textureSize *= 2;
  }

  const transformTexture = createDoubleBufferTexture(
    textureSize,
    (i) => {
      if (i < particleCount) {
        return [
          Math.sin((i / particleCount) * Math.PI * 2) / 2,
          Math.cos((i / particleCount) * Math.PI * 2) / 2,
          0,
          0,
        ];
      }
    },
    gl
  );

  const colorTexture = createDoubleBufferTexture(
    textureSize,
    (i) => {
      if (i < particleCount) {
        let [r, g, b] = chroma.hsv((i / particleCount) * 360, 0.9, 1).gl();

        return [r, g, b, 1];
      }
    },
    gl
  );

  const propertyTexture = createDoubleBufferTexture(
    textureSize,
    (i) => {
      if (i < particleCount) {
        return [0.00001, 0, 0, 0];
      }
    },
    gl
  );

  const [program, buffer] = createFullscreenProgram(
    gl,
    glsl`    
      uniform vec3 mouse;

      uniform sampler2D transformTexture;
      uniform sampler2D colorTexture;
      uniform sampler2D propertyTexture;
          
      layout(location=0) out vec4 transformOut;
      layout(location=1) out vec4 colorOut;
      layout(location=2) out vec4 propertyOut;

      const int particleCount = ${PARTICLE_COUNT};

      const int textureSize = ${textureSize};

      vec4 fetchFromIndex(sampler2D texture, int index) {
        return texelFetch(texture, ivec2(index%textureSize, index/textureSize), 0);
      }

      vec4 getTransform(int index) {
        return fetchFromIndex(transformTexture, index);
      }
      vec4 getColor(int index) {
        return fetchFromIndex(colorTexture, index);
      }
      vec4 getProperties(int index) {
        return fetchFromIndex(propertyTexture, index);
      }

      float particleDistance(vec2 dir) {
        float linear = sqrt((dir.x * dir.x + dir.y * dir.y) / 8.0);
      
        float attractionForce = pow(linear, 0.2) - 1.0;
        float stiffness = 100000.0;
        const float radius = 1.0;
        float repulsionForce = pow(-linear + 1.0, (1.0 / radius) * 200.0);
        return attractionForce * 2.5 + repulsionForce * stiffness;
      }


      vec4 updateTransform(int INDEX) {
        vec2 pos = getTransform(INDEX).xy;
        vec2 vel = getTransform(INDEX).zw;

        vec3 color = getColor(INDEX).rgb;

        vec2 props = getProperties(INDEX).xy;
        float gravity = props.x;
        float radius = props.y;

        float friction = 0.9;
        float heat = 0.0001;

        const bool wrapAround = false;

        for (int i = 0; i < particleCount; i++) {
          vec2 otherPos = getTransform(i).xy;
          vec3 otherColor = getColor(i).rgb;
          vec2 direction = pos - otherPos;
          
          float colorDistance = cos(length(otherColor.rgb - color.gbr - color.brg))*0.1;

          float attraction = particleDistance(direction) * gravity;

          vel += direction * attraction * colorDistance;
        }

        if (mouse.z != 0.0) {
          vec2 direction = pos - mouse.xy;
          float distance = length(direction);
          if (distance > 0.0) {
            direction /= distance;
          }

          float attraction = particleDistance(direction) * mouse.z * 0.01;

          vel += direction * attraction;
        }

        vel *= friction;

        //vx += (Math.random() * 2 - 1) * heat;
        //vy += (Math.random() * 2 - 1) * heat;

        pos += vel;

        // wall bounce
        if (wrapAround) {
          if (pos.x > 1.0) {
            pos.x = -1.0;
          } else if (pos.x < -1.0) {
            pos.x = 1.0;
          }

          if (pos.y >= 1.0) {
            pos.y = -1.0;
          } else if (pos.y < -1.0) {
            pos.y = 1.0;
          }
        } else {
          if (pos.x > 1.0) {
            pos.x = 1.0;
            vel.x *= -1.0;
          } else if (pos.x < -1.0) {
            pos.x = -1.0;
            vel.x *= -1.0;
          }

          if (pos.y > 1.0) {
            pos.y = 1.0;
            vel.y *= -1.0;
          } else if (pos.y < -1.0) {
            pos.y = -1.0;
            vel.y *= -1.0;
          }
        }

        return vec4(pos, vel);
      }

      void main() {
        int x = int(gl_FragCoord.y);
        int y = int(gl_FragCoord.x);

        int indexParticle = x * textureSize + y;
        if (indexParticle > particleCount) {
          discard;
        }

        transformOut = updateTransform(indexParticle);
        colorOut = getColor(indexParticle);
        propertyOut = getProperties(indexParticle);
      }
    `
  );

  const transformTextureLocation = gl.getUniformLocation(
    program,
    "transformTexture"
  );
  const colorTextureLocation = gl.getUniformLocation(program, "colorTexture");
  const propertyTextureLocation = gl.getUniformLocation(
    program,
    "propertyTexture"
  );

  const mouseLocation = gl.getUniformLocation(program, "mouse");

  const getParticleState = (index: number, tex: WebGLTexture) => {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0
    );
    const canRead =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!canRead) {
      throw new Error("Failed to read framebuffer");
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

    const output = new Float32Array(4);

    let idx = index;
    let x = Math.trunc(idx / textureSize);
    let y = Math.trunc(idx % textureSize);
    gl.readPixels(y, x, 1, 1, gl.RGBA, gl.FLOAT, output);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return output;
  };

  const fb = gl.createFramebuffer();

  const textures = [
    { texture: transformTexture, location: transformTextureLocation },
    { texture: colorTexture, location: colorTextureLocation },
    { texture: propertyTexture, location: propertyTextureLocation },
  ];

  return {
    count: particleCount,
    textureSize: textureSize,
    textureTransform: transformTexture.getRead(),
    textureColor: colorTexture.getRead(),
    textureProperties: propertyTexture.getRead(),
    getParticleState,
    update(mx: number, my: number, pressed: number) {
      gl.useProgram(program);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      for (let i = 0; i < textures.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, textures[i].texture.getRead());
        gl.uniform1i(textures[i].location, i);
      }

      gl.uniform3f(mouseLocation, mx, my, pressed);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

      for (let i = 0; i < textures.length; i++) {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0 + i,
          gl.TEXTURE_2D,
          textures[i].texture.getWrite(),
          0
        );
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      this.textureTransform = transformTexture.getWrite();
      this.textureColor = colorTexture.getWrite();
      this.textureProperties = propertyTexture.getWrite();

      transformTexture.swap();
      colorTexture.swap();
      propertyTexture.swap();
    },
  };
};

export const createSimulation = (canvas: HTMLCanvasElement) => {
  const gl = canvas.getContext("webgl2");
  if (!gl) return;

  const width = 1024;
  const height = 1024;
  canvas.width = width;
  canvas.height = height;

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

  let mx = 0;
  let my = 0;
  let pressed = 0;
  const mouseMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    mx = e.clientX - rect.left;
    my = e.clientY - rect.top;
    mx = mx / rect.width;
    my = my / rect.height;
    mx = mx * 2 - 1;
    my = my * 2 - 1;

    my = -my;
  };
  window.addEventListener("mousemove", mouseMove);

  const mouseDown = (e: MouseEvent) => {
    pressed = e.buttons === 4 ? -1 : 1;
  };
  window.addEventListener("mousedown", mouseDown);

  const mouseUp = (e: MouseEvent) => {
    pressed = 0;
  };
  window.addEventListener("mouseup", mouseUp);

  let particles = createParticles(gl, PARTICLE_COUNT);
  let destroyed = false;

  const program = createShaderProgram(
    gl,
    glsl`
      in vec2 indexPos;
      in vec2 pos;
        uniform sampler2D textureTransform;
        uniform sampler2D textureColor;
        uniform sampler2D textureProperties;

        out vec4 outColor;
        out vec4 outProperties;
        out vec4 outTransform;

        const float SIZE = 0.005;
        
        void main() {
          vec4 transform = texelFetch(textureTransform, ivec2(indexPos.y, indexPos.x), 0);
          outTransform = transform;
          outColor = texelFetch(textureColor, ivec2(indexPos.y, indexPos.x), 0);
          outProperties = texelFetch(textureProperties, ivec2(indexPos.y, indexPos.x), 0);

          gl_Position = vec4(pos * SIZE + transform.xy , 0, 1);
        }
      `,
    glsl`
        out vec4 fragColor;

        const float SIZE = 0.005;
        const vec2 screenSize = vec2(${width}.0, ${height}.0);

        in vec4 outColor;
        in vec4 outProperties;
        in vec4 outTransform;

        void main() {
          vec2 screenPos = (gl_FragCoord.xy/screenSize)*2.0-1.0;
          float alpha = -length(outTransform.xy - screenPos)*(1.0/SIZE)+1.0;

          alpha = pow(alpha, 0.5);

          fragColor = vec4(outColor.rgb, alpha * outColor.a);
        }
      `
  );

  const particleIndices = new Float32Array(particles.count * 12);

  for (let x = 0; x < particles.textureSize; x++) {
    for (let y = 0; y < particles.textureSize; y++) {
      const idx = (x * particles.textureSize + y) * 12;
      particleIndices[idx + 0] = x;
      particleIndices[idx + 1] = y;
      particleIndices[idx + 2] = x;
      particleIndices[idx + 3] = y;
      particleIndices[idx + 4] = x;
      particleIndices[idx + 5] = y;
      particleIndices[idx + 6] = x;
      particleIndices[idx + 7] = y;
      particleIndices[idx + 8] = x;
      particleIndices[idx + 9] = y;
      particleIndices[idx + 10] = x;
      particleIndices[idx + 11] = y;
    }
  }

  const indexBuffer = attachVerticesToProgram(
    gl,
    program,
    particleIndices,
    "indexPos"
  );

  const particleQuads = new Float32Array(particles.count * 12);

  for (let i = 0; i < particles.count; i++) {
    const idx = i * 12;

    particleQuads[idx + 0] = -1.0;
    particleQuads[idx + 1] = -1.0;
    particleQuads[idx + 2] = 1.0;
    particleQuads[idx + 3] = -1.0;
    particleQuads[idx + 4] = -1.0;
    particleQuads[idx + 5] = 1.0;
    particleQuads[idx + 6] = -1.0;
    particleQuads[idx + 7] = 1.0;
    particleQuads[idx + 8] = 1.0;
    particleQuads[idx + 9] = -1.0;
    particleQuads[idx + 10] = 1.0;
    particleQuads[idx + 11] = 1.0;
  }

  const posBuffer = attachVerticesToProgram(gl, program, particleQuads, "pos");

  const transformLocation = gl.getUniformLocation(program, "textureTransform");
  const colorLocation = gl.getUniformLocation(program, "textureColor");
  const propertyLocation = gl.getUniformLocation(program, "textureProperties");

  const tick = () => {
    if (destroyed) return;

    particles.update(mx, my, pressed);

    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, particles.textureTransform);
    gl.uniform1i(transformLocation, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, particles.textureColor);
    gl.uniform1i(colorLocation, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, particles.textureProperties);
    gl.uniform1i(propertyLocation, 2);

    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, particles.count * 6);
    gl.disable(gl.BLEND);
    requestAnimationFrame(tick);
  };
  tick();

  console.log(twgl);

  return () => {
    destroyed = true;
    // gpu.destroy();
    window.removeEventListener("mousemove", mouseMove);
    window.removeEventListener("mousedown", mouseDown);
    window.removeEventListener("mouseup", mouseUp);
  };
};
