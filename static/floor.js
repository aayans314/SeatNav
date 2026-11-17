/*
  SeatNav 3D floor map.

  Builds the floor (walls, rooms, landmarks) and the carrels from the layout file
  (static/layout/*.json) and shows each carrel's state. The desk lamp and a pool of
  light take the state colour, and the furniture says the same thing without colour:
  empty chair = free, someone seated = occupied, bag left on the chair = away.

  Plain three.js from the CDN (see the import map in index.html), no build step.
  app.js imports this file after the page shell is up, so the counts and the list
  work while three.js is still downloading, and on phones without WebGL.
*/

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- real sizes in metres (matched to the photo of the carrels) ----------

const WALL_H = 1.1;          // walls are cut low so you can see into every room
const WALL_T = 0.12;
const PANEL_H = 1.4;         // grey fabric panels
const SPINE_T = 0.07;        // the back-to-back panel down the middle of a compartment
const PANEL_T = 0.045;
const PART_DEPTH = 0.8;      // how far the side partitions reach out from the spine
const DESK_D = 0.62;
const DESK_H = 0.74;
const DESK_T = 0.04;

// How far each state pulls the chair out from the desk (m) and turns it (rad).
const CHAIR = { FREE: [0, 0], OCCUPIED: [0.1, 0], AWAY: [0.42, 0.5], OFFLINE: [0, 0] };

const ARROW_ANGLE = { east: 0, north: Math.PI / 2, west: Math.PI, south: -Math.PI / 2 };

// ---------- geometry helpers ----------

function merge(geometries) {
  // mergeGeometries needs every part indexed the same way, so flatten them all first
  const merged = mergeGeometries(geometries.map((g) => (g.index ? g.toNonIndexed() : g)));
  geometries.forEach((g) => g.dispose());
  return merged;
}

// Static parts are collected per material and merged, so a compartment is a few draw calls.
class Batch {
  constructor() {
    this.parts = new Map();
  }

  box(material, w, h, d, x, y, z, rotY = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    this.add(material, g.translate(x, y, z));
  }

  // a copy of a shared geometry, turned by rotY and moved to (x, y, z)
  place(material, geometry, x, y, z, rotY = 0) {
    this.add(material, geometry.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z)));
  }

  add(material, geometry) {
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push(geometry);
  }

  addTo(parent, shadows = true) {
    for (const [material, geometries] of this.parts) {
      const mesh = new THREE.Mesh(merge(geometries), material);
      mesh.castShadow = mesh.receiveShadow = shadows;
      parent.add(mesh);
    }
  }
}

// Furniture is modelled facing -x (towards the desk); carrels on the other side are turned round.
function chairGeometries() {
  const seat = new RoundedBoxGeometry(0.46, 0.08, 0.46, 2, 0.03).translate(0, 0.47, 0);
  const back = new RoundedBoxGeometry(0.07, 0.4, 0.42, 2, 0.03).translate(0.23, 0.82, 0);
  const brace = new THREE.BoxGeometry(0.04, 0.26, 0.05).translate(0.23, 0.56, 0);
  const post = new THREE.CylinderGeometry(0.025, 0.03, 0.36, 8).translate(0, 0.26, 0);
  const base = new THREE.CylinderGeometry(0.28, 0.28, 0.035, 5).translate(0, 0.065, 0);
  return { seat: merge([seat]), frame: merge([back, brace, post, base]) };
}

// ---------- people: seated, looking towards -x, hands on the desk ----------

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function limb(radius, a, b) {
  // a capsule from point a to point b
  const dir = b.clone().sub(a);
  const g = new THREE.CapsuleGeometry(radius, Math.max(dir.length(), 0.001), 4, 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// a cylinder from a (radius r1) to b (radius r2); pair with ball() at the joints
function taper(r1, r2, a, b) {
  const dir = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r2, r1, Math.max(dir.length(), 0.001), 14);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// an ellipsoid with radii (rx, ry, rz) centred on p
function ball(p, rx, ry = rx, rz = rx) {
  return new THREE.SphereGeometry(1, 16, 12).scale(rx, ry, rz).translate(p.x, p.y, p.z);
}

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');

function faceTexture({ skin, brow, iris, lips, woman }) {
  // wraps round the head: the middle of the canvas is the front of the face and the
  // middle row is eye level. 1 cm is about 10 px across and 7 px down.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  const ellipse = (x, y, rx, ry, start = 0, end = Math.PI * 2) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, start, end);
  };
  g.fillStyle = skin;
  g.fillRect(0, 0, 512, 256);
  g.lineCap = 'round';
  for (const s of [-1, 1]) {
    const cheek = g.createRadialGradient(256 + s * 46, 158, 2, 256 + s * 46, 158, 30);
    cheek.addColorStop(0, `rgba(190, 80, 70, ${woman ? 0.2 : 0.12})`);
    cheek.addColorStop(1, 'rgba(190, 80, 70, 0)');
    g.fillStyle = cheek;
    g.fillRect(200 + s * 46, 120, 112, 80);

    const x = 256 + s * 32;
    const y = 126;
    g.fillStyle = 'rgba(70, 40, 30, 0.18)';              // shadow of the brow over the eye
    ellipse(x, y - 2, 15, 7);
    g.fill();
    g.save();
    g.fillStyle = '#f2ece4';
    ellipse(x, y, 11.5, 4);
    g.fill();
    g.clip();
    g.fillStyle = iris;
    ellipse(x, y + 0.5, 5.5, 4.2);
    g.fill();
    g.fillStyle = '#0d0d0d';
    ellipse(x, y + 0.5, 2.6, 2);
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ellipse(x - 1.5, y - 1, 1.1, 0.9);
    g.fill();
    g.restore();
    g.strokeStyle = '#2a1c18';                            // upper lid and lashes
    g.lineWidth = woman ? 2.2 : 1.4;
    ellipse(x, y, 11.5, 4, Math.PI * 1.05, Math.PI * 1.95);
    g.stroke();

    g.strokeStyle = brow;                                 // eyebrow
    g.lineWidth = woman ? 2.4 : 3.6;
    g.beginPath();
    g.moveTo(256 + s * 18, 115);
    g.quadraticCurveTo(256 + s * 33, woman ? 104 : 108, 256 + s * 47, 115);
    g.stroke();
  }
  g.strokeStyle = 'rgba(90, 45, 35, 0.35)';               // nostrils, under the nose
  g.lineWidth = 1.5;
  for (const s of [-1, 1]) {
    ellipse(256 + s * 6, 160, 3, 1.4);
    g.stroke();
  }
  g.fillStyle = lips;                                     // lips with a darker line between them
  ellipse(256, 175, woman ? 16 : 17, woman ? 4.2 : 3.2);
  g.fill();
  g.strokeStyle = 'rgba(80, 30, 28, 0.8)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(240, 175);
  g.quadraticCurveTo(256, 177, 272, 175);
  g.stroke();
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const SKIN = ['#f3d0b3', '#e8b994', '#d29f78', '#b07a52', '#8a5a3b', '#5e3b26'];
const SHIRT = [0x3d6fa3, 0xc8553d, 0x4f8a5b, 0xd8a33f, 0x6c5ba3, 0x2f3a46, 0xb04a7a, 0xe9e4da, 0x7a8c99];
const PANTS = [0x2c3442, 0x3b5b86, 0x1f2023, 0x8a7a5c, 0x55606b];
const SHOES = [0x1d1f22, 0xe8e6e1, 0x5b3d2a, 0x30343a];
const HAIR = [0x2b1d16, 0x111111, 0x5a3820, 0x8f6236, 0x3a2a22, 0xb08a52, 0x6e2f1c];
const IRIS = ['#4a2f1d', '#2e1d12', '#5a3a22', '#3d5a6e', '#5b6b3a'];

// torso outlines as [radius, height above the hips] in metres, turned into a solid
const TORSO = {
  man: [[0, -0.02], [0.15, -0.02], [0.158, 0.04], [0.15, 0.13], [0.158, 0.22], [0.168, 0.32], [0.172, 0.4], [0.165, 0.45], [0.13, 0.49], [0.07, 0.52], [0.05, 0.53], [0, 0.53]],
  woman: [[0, -0.02], [0.165, -0.02], [0.172, 0.04], [0.14, 0.14], [0.135, 0.2], [0.15, 0.28], [0.152, 0.34], [0.148, 0.4], [0.14, 0.44], [0.11, 0.475], [0.06, 0.505], [0.042, 0.515], [0, 0.515]],
};

function makePerson(seed = 0) {
  // the same seed always gives the same person
  const rand = (k) => {
    let x = Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b);
    x ^= x >>> 15;
    x = Math.imul(x, 0x2c1b3c6d);
    x ^= x >>> 12;
    return (x >>> 0) / 4294967296;
  };
  const pick = (list, k) => list[Math.floor(rand(k) * list.length)];
  const woman = seed % 2 === 1;                           // every other person is a woman
  const skin = pick(SKIN, 1);
  const hair = pick(HAIR, 3);
  const std = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
  const materials = {
    shirt: std(pick(SHIRT, 2)),
    pants: std(pick(PANTS, 4), 0.9),
    skin: std(skin, 0.6),
    face: new THREE.MeshStandardMaterial({ roughness: 0.6, map: faceTexture({
      skin, woman, brow: css(hair), iris: pick(IRIS, 5),
      lips: woman ? 'rgba(170, 70, 80, 0.75)' : 'rgba(150, 75, 70, 0.45)',
    }) }),
    hair: std(hair, 0.75),
    shoes: std(pick(SHOES, 6), 0.55),
    soles: std(0xe6e3dc, 0.8),
  };
  const parts = Object.fromEntries(Object.keys(materials).map((key) => [key, []]));

  // sitting on the chair, leaning a little towards the desk
  const LEAN = 0.1;
  const hip = V(0.06, 0.6, 0);
  parts.shirt.push(new THREE.LatheGeometry(TORSO[woman ? 'woman' : 'man'].map(([r, h]) => new THREE.Vector2(r, h)), 20)
    .scale(woman ? 0.66 : 0.6, 1, 1).rotateZ(LEAN).translate(hip.x, hip.y, 0));
  parts.shirt.push(new THREE.TorusGeometry(woman ? 0.044 : 0.052, 0.013, 8, 20).rotateX(Math.PI / 2)
    .rotateZ(LEAN).translate(0.007, 1.115, 0));          // collar
  parts.pants.push(ball(V(0.07, 0.6, 0), 0.12, 0.085, woman ? 0.175 : 0.16));

  const sw = woman ? 0.148 : 0.165;                       // half the shoulder width
  const longSleeves = rand(7) < 0.5;
  for (const s of [-1, 1]) {
    const shoulder = V(0.01, woman ? 1.045 : 1.06, s * sw);
    const elbow = V(-0.06, 0.8, s * (sw + 0.035));
    const wrist = V(-0.32, 0.79, s * (sw - 0.03));
    const hand = V(-0.375, 0.778, s * (sw - 0.045));
    const [upper, lower, end] = woman ? [0.04, 0.034, 0.024] : [0.048, 0.04, 0.028];
    parts.shirt.push(ball(shoulder, upper + (longSleeves ? 0.002 : 0.007)));
    if (longSleeves) {
      parts.shirt.push(taper(upper, lower, shoulder, elbow), ball(elbow, lower), taper(lower, end + 0.004, elbow, wrist));
    } else {
      const hem = shoulder.clone().lerp(elbow, 0.5);
      parts.shirt.push(taper(upper + 0.007, upper + 0.005, shoulder, hem));
      parts.skin.push(taper(upper, lower, shoulder, elbow), ball(elbow, lower), taper(lower, end, elbow, wrist));
    }
    // hand flat on the desk, thumb on the inside
    const k = woman ? 0.9 : 1;
    parts.skin.push(ball(wrist, end), ball(hand, 0.05 * k, 0.016, 0.04 * k));
    parts.skin.push(limb(0.011 * k, V(-0.34, 0.782, s * (sw - 0.075)), V(-0.385, 0.775, s * (sw - 0.09))));

    const hipJoint = V(0.05, 0.585, s * 0.095);
    const knee = V(-0.36, 0.57, s * 0.105);
    const ankle = V(-0.4, 0.11, s * 0.105);
    parts.pants.push(taper(woman ? 0.088 : 0.085, woman ? 0.055 : 0.058, hipJoint, knee), ball(knee, 0.058));
    parts.pants.push(taper(0.052, 0.038, knee, ankle), ball(knee.clone().lerp(ankle, 0.3).add(V(0.012, 0, 0)), 0.055, 0.09, 0.052));
    parts.pants.push(ball(ankle, 0.038));
    const foot = woman ? 0.24 : 0.27;
    parts.shoes.push(new RoundedBoxGeometry(foot, 0.075, woman ? 0.09 : 0.1, 2, 0.03).translate(-0.45, 0.05, s * 0.105));
    parts.soles.push(new THREE.BoxGeometry(foot + 0.01, 0.02, woman ? 0.095 : 0.105).translate(-0.45, 0.01, s * 0.105));
  }
  parts.skin.push(limb(woman ? 0.043 : 0.05, V(0.005, 1.1, 0), V(-0.02, 1.19, 0)));   // neck

  // the head, modelled round the origin, then tipped forward to look down at the laptop
  const [rx, ry, rz] = woman ? [0.092, 0.11, 0.076] : [0.097, 0.115, 0.08];
  const head = { face: [], skin: [], hair: [] };
  // a unit sphere stretched to the head's size, narrower towards the chin; puff > 1 sits just outside it
  const toHead = (g, puff = 1) => {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const jaw = y < 0 ? y * y : 0;
      pos.setXYZ(i, pos.getX(i) * rx * puff * (1 - 0.12 * jaw), y * ry * puff, pos.getZ(i) * rz * puff * (1 - (woman ? 0.3 : 0.22) * jaw));
    }
    g.computeVertexNormals();
    return g;
  };
  head.face.push(toHead(new THREE.SphereGeometry(1, 40, 24).rotateY(Math.PI)));
  head.skin.push(ball(V(-rx + 0.006, -0.018, 0), woman ? 0.013 : 0.015, woman ? 0.022 : 0.025, woman ? 0.01 : 0.012));   // nose

  const style = woman ? pick(['long', 'long', 'ponytail', 'bun'], 8) : pick(['short', 'short', 'full'], 8);
  // hair: the part of the head above a hairline that is high at the forehead, lower at the
  // sides and lowest at the nape (heights as a fraction of the head's half-height)
  const hairShell = (front, side, back, puff) => {
    const g = new THREE.SphereGeometry(1, 48, 28);
    const pos = g.attributes.position;
    const line = (x) => (x < 0 ? side - (front - side) * x : side + (back - side) * x);
    const above = (i) => pos.getY(i) > line(pos.getX(i));
    const index = g.index.array;
    const keep = [];
    for (let i = 0; i < index.length; i += 3) {
      if (above(index[i]) || above(index[i + 1]) || above(index[i + 2])) keep.push(index[i], index[i + 1], index[i + 2]);
    }
    g.setIndex(keep);
    // slide the vertices just below the hairline up onto it, so the edge is smooth
    for (let i = 0; i < pos.count; i++) {
      let [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      for (let n = 0; n < 4 && y < line(x); n++) {
        y = line(x);
        const k = Math.sqrt(Math.max(0, 1 - y * y)) / (Math.hypot(x, z) || 1);
        x *= k;
        z *= k;
      }
      pos.setXYZ(i, x, y, z);
    }
    return toHead(g, puff);
  };
  if (style === 'short') head.hair.push(hairShell(0.62, 0.3, -0.35, 1.03));
  if (style === 'full') head.hair.push(hairShell(0.5, 0.12, -0.45, 1.07));
  if (style === 'long') head.hair.push(hairShell(0.55, -0.15, -0.5, 1.05));
  if (style === 'ponytail' || style === 'bun') head.hair.push(hairShell(0.6, 0.15, -0.3, 1.03));
  if (style !== 'long') for (const s of [-1, 1]) head.skin.push(ball(V(0.008, -0.005, s * rz), 0.02, 0.03, 0.01));   // ears
  if (style === 'bun') head.hair.push(ball(V(rx * 0.85, ry * 0.45, 0), 0.048));
  if (style === 'ponytail') head.hair.push(ball(V(rx * 0.97, 0.02, 0), 0.028));

  const tipForward = new THREE.Matrix4().makeTranslation(-0.02, 1.18, 0)    // top of the neck
    .multiply(new THREE.Matrix4().makeRotationZ(0.2))
    .multiply(new THREE.Matrix4().makeTranslation(-0.01, 0.1, 0));           // neck to the middle of the head
  for (const [key, list] of Object.entries(head)) parts[key].push(...list.map((g) => g.applyMatrix4(tipForward)));

  // hair that hangs straight down, so it isn't tipped with the head
  if (style === 'long') {
    parts.hair.push(ball(V(0.03, 1.17, 0), 0.075, 0.16, 0.105));
    for (const s of [-1, 1]) parts.hair.push(limb(0.026, V(-0.06, 1.31, s * 0.08), V(-0.02, 1.12, s * 0.095)));
  }
  if (style === 'ponytail') parts.hair.push(limb(0.03, V(0.06, 1.28, 0), V(0.09, 1.1, 0)));

  const person = new THREE.Group();
  for (const [key, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(merge(list), materials[key]);
    mesh.castShadow = true;
    person.add(mesh);
  }
  return person;
}

function laptopGeometry() {
  const base = new THREE.BoxGeometry(0.23, 0.015, 0.32).translate(0, 0.0075, 0);
  const screen = new THREE.BoxGeometry(0.012, 0.22, 0.32).translate(0, 0.11, 0).rotateZ(0.22).translate(-0.11, 0.012, 0);
  return merge([base, screen]);
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function carpetTexture() {
  // the library's streaky charcoal carpet: light streaks on white, tinted by the floor colour
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 700; i++) {
    const shade = Math.floor(120 + rnd() * 110);
    g.fillStyle = 'rgba(' + shade + ',' + shade + ',' + shade + ',0.6)';
    g.fillRect(rnd() * 256, rnd() * 256, 8 + rnd() * 50, 1 + rnd() * 2.5);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.4, 0.4);              // floor UVs are in metres, so one tile per 2.5 m
  texture.anisotropy = 4;
  return texture;
}

function rugTexture(color, accent) {
  // area rug: accent border, a thin inner line and a row of diamonds
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = accent;
  g.fillRect(0, 0, 256, 160);
  g.fillStyle = color;
  g.fillRect(10, 10, 236, 140);
  g.strokeStyle = accent;
  g.lineWidth = 3;
  g.strokeRect(20, 20, 216, 120);
  for (let i = 0; i < 7; i++) {
    const x = 40 + i * 29.3;
    g.fillStyle = i % 2 ? accent : 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.moveTo(x, 62);
    g.lineTo(x + 12, 80);
    g.lineTo(x, 98);
    g.lineTo(x - 12, 80);
    g.fill();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function curtainGeometry(length, height) {
  // a white curtain with soft folds
  const g = new THREE.PlaneGeometry(length, height, Math.max(8, Math.round(length / 0.06)), 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, 0.035 * Math.sin(pos.getX(i) * 26));
  g.computeVertexNormals();
  return g;
}

function booksTexture() {
  // rows of book spines for the stacks; seeded so it looks the same on every load
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  const spines = ['#7d2e2b', '#2f4b7c', '#3e6b4a', '#c9a227', '#e8e2d4', '#8a4b2a', '#4a3f6b', '#b85c38', '#2b2b2b', '#5d7d8c'];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = '#6e4a32';
  g.fillRect(0, 0, 1024, 256);
  for (let row = 0; row < 4; row++) {
    const top = row * 64 + 6;
    for (let x = 4; x < 1020;) {
      const w = 6 + Math.floor(rnd() * 10);
      const h = 52 - Math.floor(rnd() * 14);
      g.fillStyle = spines[Math.floor(rnd() * spines.length)];
      g.fillRect(x, top + 52 - h, w - 1, h);
      x += w;
    }
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

// ---------- the floor view ----------

export function createFloor(container, layout, { onSelect = () => {}, decoratePin = () => {} } = {}) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  // layout pixels -> metres: x runs east, z runs south (down the image), y is up
  const s = layout.metres_per_px;
  const xs = layout.outline.map((p) => p[0]);
  const ys = layout.outline.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const at = ([x, y], h = 0) => new THREE.Vector3((x - cx) * s, h, (y - cy) * s);
  const area = ([x0, y0, x1, y1]) => ({ min: at([x0, y0]), max: at([x1, y1]) });
  const flatShape = (points) => new THREE.Shape(points.map((p) => {
    const v = at(p);
    return new THREE.Vector2(v.x, -v.z);   // rotateX(-90deg) below turns shape y into world z
  }));
  const floorArea = area([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);

  // ---------- renderer, camera, controls ----------

  const renderer = new THREE.WebGLRenderer({ antialias: true });   // throws without WebGL; app.js falls back to the list
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'labels';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 2.5;
  controls.maxDistance = 160;
  controls.maxPolarAngle = 1.25;
  controls.zoomToCursor = true;

  // keep the view over the building
  controls.addEventListener('change', () => {
    const t = controls.target;
    const x = THREE.MathUtils.clamp(t.x, floorArea.min.x, floorArea.max.x);
    const z = THREE.MathUtils.clamp(t.z, floorArea.min.z, floorArea.max.z);
    camera.position.x += x - t.x;
    camera.position.z += z - t.z;
    t.set(x, 0, z);
    dirty = true;
  });
  controls.addEventListener('start', () => {
    tween = null;
    currentView = null;          // the user took over; stop re-fitting on resize
  });

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8c8a85, 0.8);
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  const view = area(layout.carrel_view.box);
  const reach = Math.max(floorArea.max.x - floorArea.min.x, floorArea.max.z - floorArea.min.z) / 2 + 2;
  sun.position.set(-10, 24, -13);
  sun.castShadow = true;                 // one shadow map over the whole floor
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 90 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);

  // ---------- materials (theme colours come from the CSS tokens in index.html) ----------

  const std = (color, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
  const mat = {
    floor: std(0xffffff, 0.95, { map: carpetTexture() }),
    slab: std(0xffffff, 1),
    carpet: std(0xffffff, 1),
    wall: std(0xffffff, 0.9),
    wallTop: new THREE.MeshBasicMaterial(),
    stairs: std(0xffffff, 1),
    ghost: std(0xffffff, 1),                       // carrels without sensors
    fabric: std(0x8f9693, 1),                      // grey panels
    wood: std(0x95522c, 0.5),                      // cherry posts and desk tops
    counter: std(0xe9e6df, 0.8),
    metal: std(0xc3c7ca, 0.35, { metalness: 0.7 }),
    seat: std(0x2f4f92, 0.9),                      // blue chair seats
    dark: std(0x26282c, 0.6),
    person: std(0xe6dfd4, 0.75),
    laptop: std(0x3a3f46, 0.45, { metalness: 0.4 }),
    bag: std(0x6a5a9c, 0.9),
    lavender: std(0x8f8cc4, 0.95),                 // club armchairs
    teal: std(0x239485, 0.95),                     // lounge seats
    shelfDark: std(0x2e2a27, 0.7),
    monitor: std(0x15181b, 0.4),
    leaf: std(0x4f9d3a, 0.8),
    glass: std(0xbfdbe8, 0.1, { transparent: true, opacity: 0.32, depthWrite: false }),
    frost: std(0xe8f0ee, 0.3, { transparent: true, opacity: 0.6, depthWrite: false }),
    brick: std(0x9a4a35, 0.95),
    cabinet: std(0x474c52, 0.55),                  // dark grey cabinets and counter tops
    board: std(0xf4f6f6, 0.3),
    yellow: std(0xe0b52a, 0.6),
    lantern: std(0xd2452f, 0.6),
    curtain: std(0xfbfaf6, 0.9, { side: THREE.DoubleSide }),
    hit: new THREE.MeshBasicMaterial({ visible: false }),
    arrow: new THREE.MeshBasicMaterial({ toneMapped: false }),
  };
  // closed rooms: walls fade between two greys (redrawn for each theme), plain roof
  const roomCanvas = document.createElement('canvas');
  roomCanvas.width = 4;
  roomCanvas.height = 128;
  const roomTexture = new THREE.CanvasTexture(roomCanvas);
  roomTexture.colorSpace = THREE.SRGBColorSpace;
  mat.roomWall = std(0xffffff, 0.9, { map: roomTexture });
  mat.roomRoof = std(0xffffff, 0.9);
  const books = booksTexture();
  const shelfFront = std(0xffffff, 0.9, { map: books });
  const glow = glowTexture();

  const palette = {};
  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#888888');
    Object.assign(palette, {
      dark: darkScheme.matches,
      bg: color('--scene-bg'), floor: color('--scene-floor'), carpet: color('--scene-carpet'),
      wall: color('--scene-wall'), wallTop: color('--scene-wall-top'), ghost: color('--scene-ghost'), brand: color('--brand'),
      roomTop: css.getPropertyValue('--room-top').trim() || '#eef1f4',
      roomBottom: css.getPropertyValue('--room-bottom').trim() || '#aeb6be',
      FREE: color('--free'), OCCUPIED: color('--occupied'), AWAY: color('--away'), OFFLINE: color('--offline'),
    });
  }

  function applyTheme() {
    scene.background = palette.bg.clone();
    mat.floor.color.copy(palette.floor);
    mat.slab.color.copy(palette.floor).multiplyScalar(0.8);
    mat.stairs.color.copy(palette.floor).multiplyScalar(0.8);
    mat.carpet.color.copy(palette.carpet);
    mat.wall.color.copy(palette.wall);
    mat.wallTop.color.copy(palette.wallTop);
    mat.ghost.color.copy(palette.ghost);
    mat.arrow.color.copy(palette.brand);
    const g = roomCanvas.getContext('2d');
    const fade = g.createLinearGradient(0, 0, 0, 128);   // canvas top = top of the wall
    fade.addColorStop(0, palette.roomTop);
    fade.addColorStop(1, palette.roomBottom);
    g.fillStyle = fade;
    g.fillRect(0, 0, 4, 128);
    roomTexture.needsUpdate = true;
    mat.roomRoof.color.set(palette.roomTop);
    hemi.intensity = palette.dark ? 0.3 : 0.8;     // a darker room at night so the lamps glow
    sun.intensity = palette.dark ? 0.5 : 1.7;
    scene.environmentIntensity = palette.dark ? 0.3 : 1;
  }

  // ---------- the building ----------

  const slabGeometry = new THREE.ExtrudeGeometry(flatShape(layout.outline), { depth: 0.3, bevelEnabled: false });
  slabGeometry.rotateX(-Math.PI / 2).translate(0, -0.3, 0);
  const slab = new THREE.Mesh(slabGeometry, [mat.floor, mat.slab]);
  slab.receiveShadow = true;
  scene.add(slab);

  if (layout.carpet) {
    const carpet = new THREE.Mesh(new THREE.ShapeGeometry(flatShape(layout.carpet)).rotateX(-Math.PI / 2), mat.carpet);
    carpet.position.y = 0.004;
    carpet.receiveShadow = true;
    scene.add(carpet);
  }

  const building = new Batch();
  const wallTops = new Batch();
  for (const [p0, p1] of layout.walls) {
    const a = at(p0);
    const b = at(p1);
    const length = a.distanceTo(b) + WALL_T;    // overlap a little so corners close
    const angle = -Math.atan2(b.z - a.z, b.x - a.x);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    building.box(mat.wall, length, WALL_H, WALL_T, mid.x, WALL_H / 2, mid.z, angle);
    wallTops.box(mat.wallTop, length, 0.012, WALL_T + 0.004, mid.x, WALL_H + 0.006, mid.z, angle);
  }

  function segment(p0, p1) {
    const a = at(p0);
    const b = at(p1);
    return { length: a.distanceTo(b), angle: -Math.atan2(b.z - a.z, b.x - a.x), mid: a.clone().add(b).multiplyScalar(0.5) };
  }

  for (const [p0, p1] of layout.brick || []) {
    const { length, angle, mid } = segment(p0, p1);
    building.box(mat.brick, length + WALL_T, WALL_H, WALL_T * 1.6, mid.x, WALL_H / 2, mid.z, angle);
    wallTops.box(mat.wallTop, length + WALL_T, 0.012, WALL_T * 1.6 + 0.004, mid.x, WALL_H + 0.006, mid.z, angle);
  }

  // big windows and glass offices with dark frames, and glass office fronts with white frames;
  // glass goes in the no-shadow batch so it doesn't darken the floor
  for (const [list, sill, frame] of [[layout.windows || [], 0.45, mat.dark], [layout.glass || [], 0.25, mat.wall]]) {
    for (const [p0, p1] of list) {
      const { length, angle, mid } = segment(p0, p1);
      const paneY = (WALL_H + sill) / 2;
      building.box(frame, length + WALL_T, sill, WALL_T, mid.x, sill / 2, mid.z, angle);
      wallTops.box(mat.glass, length, WALL_H - sill, 0.03, mid.x, paneY, mid.z, angle);
      wallTops.box(frame === mat.dark ? mat.dark : mat.wallTop, length + WALL_T, 0.04, WALL_T, mid.x, WALL_H, mid.z, angle);
      const posts = Math.max(1, Math.round(length / 1.5));
      for (let i = 0; i <= posts; i++) {
        const t = (i / posts - 0.5) * length;
        building.box(frame, 0.06, WALL_H - sill, 0.08, mid.x + Math.cos(-angle) * t, paneY, mid.z + Math.sin(-angle) * t, angle);
      }
    }
  }

  for (const lm of layout.landmarks || []) {
    if (lm.kind === 'shelves') {
      const { min, max } = area(lm.rect);
      const w = max.x - min.x;
      books.repeat.set(w / 2.4, 1);
      const shelves = new THREE.Mesh(new THREE.BoxGeometry(w, 1.6, max.z - min.z),
        [mat.counter, mat.counter, mat.counter, mat.counter, shelfFront, shelfFront]);
      shelves.position.set((min.x + max.x) / 2, 0.8, (min.z + max.z) / 2);
      shelves.castShadow = shelves.receiveShadow = true;
      scene.add(shelves);
    } else if (lm.kind === 'counter') {
      const { min, max } = area(lm.rect);
      const w = max.x - min.x;
      const d = max.z - min.z;
      const x = (min.x + max.x) / 2;
      const z = (min.z + max.z) / 2;
      building.box(mat.counter, w, 1.0, d, x, 0.5, z);
      building.box(mat.wood, w + 0.04, 0.05, d + 0.08, x, 1.02, z);
    } else if (lm.kind === 'stairs') {
      const stairs = new THREE.Mesh(new THREE.ShapeGeometry(flatShape(lm.polygon)).rotateX(-Math.PI / 2), mat.stairs);
      stairs.position.y = 0.006;
      scene.add(stairs);
    }
  }
  building.addTo(scene);
  wallTops.addTo(scene, false);

  function addLabel(parent, className, text, position) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    const label = new CSS2DObject(el);
    label.position.copy(position);
    parent.add(label);
    return label;
  }

  for (const l of layout.labels || []) addLabel(scene, 'room-label', l.text, at(l.at, 0.15));

  const arrowShape = new THREE.Shape([[-0.7, -0.14], [0.2, -0.14], [0.2, -0.38], [0.75, 0], [0.2, 0.38], [0.2, 0.14], [-0.7, 0.14]]
    .map(([x, y]) => new THREE.Vector2(x, y)));
  const arrowGeometry = new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2);
  const fullArea = { min: floorArea.min.clone(), max: floorArea.max.clone() };   // the floor plus exit labels outside it
  for (const e of layout.entrances || []) {
    const angle = ARROW_ANGLE[e.dir] ?? 0;
    const arrow = new THREE.Mesh(arrowGeometry, mat.arrow);
    arrow.position.copy(at(e.at, 0.02));
    arrow.rotation.y = angle;
    scene.add(arrow);
    const ahead = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(1.3);   // label sits past the arrow tip
    const tip = arrow.position.clone().add(ahead).setY(0.3);
    addLabel(scene, 'entrance-label', e.name, tip);
    fullArea.min.min(tip);
    fullArea.max.max(tip);
  }

  for (const t of layout.tags || []) addLabel(scene, 'zone-tag', t.text, at(t.at, 1.9));

  // ---------- carrels ----------

  const chair = chairGeometries();
  const laptopGeo = laptopGeometry();
  const bagGeo = new RoundedBoxGeometry(0.2, 0.36, 0.3, 2, 0.06);
  const lampHeadGeo = new THREE.BoxGeometry(0.26, 0.025, 0.055);
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const rippleGeo = new THREE.RingGeometry(0.42, 0.5, 48).rotateX(-Math.PI / 2);

  const carrels = new Map();       // seat id -> its meshes and current state
  const hitBoxes = [];

  for (const comp of layout.compartments) {
    const ghost = !!comp.inactive;
    const { min, max } = area(comp.box);
    const group = new THREE.Group();
    group.position.set((min.x + max.x) / 2, 0, (min.z + max.z) / 2);
    // "facing" turns the whole compartment: it is the way the first seat in each row faces
    // (east unless set; the test bench faces north, towards its whiteboard)
    group.rotation.y = ARROW_ANGLE[comp.facing] ?? 0;
    scene.add(group);

    const sideways = Math.abs(Math.sin(group.rotation.y)) > 0.5;
    const length = sideways ? max.x - min.x : max.z - min.z;   // the spine runs north-south before turning
    const rowW = length / comp.seats.length;
    const parts = new Batch();
    const { fabric, wood, metal, dark } = mat;   // compartments without sensors look the same, minus lights and pins

    if (comp.panels !== false) {           // "panels": false gives plain desks (the test bench)
      parts.box(fabric, SPINE_T, PANEL_H, length + PANEL_T, 0, PANEL_H / 2, 0);
      for (let i = 0; i <= comp.seats.length; i++) {
        const z = -length / 2 + i * rowW;
        for (const side of [-1, 1]) {
          parts.box(fabric, PART_DEPTH, PANEL_H - 0.02, PANEL_T, side * PART_DEPTH / 2, (PANEL_H - 0.02) / 2, z);
          parts.box(wood, 0.06, PANEL_H + 0.01, 0.07, side * PART_DEPTH, (PANEL_H + 0.01) / 2, z);
        }
      }
    }

    comp.seats.forEach((row, r) => row.forEach((seatId, column) => {
      if (!seatId) return;
      const side = column === 0 ? -1 : 1;  // west half faces east, east half faces west
      const z = -length / 2 + (r + 0.5) * rowW;
      parts.box(wood, DESK_D, DESK_T, rowW - PANEL_T - 0.02, side * (SPINE_T / 2 + DESK_D / 2), DESK_H, z);
      parts.box(metal, 0.02, 0.5, 0.02, side * (SPINE_T / 2 + 0.03), DESK_H + 0.25, z + rowW * 0.3);         // lamp arm
      parts.box(dark, 0.05, 0.05, 0.22, side * (SPINE_T / 2 + 0.03), DESK_H + 0.06, z - rowW * 0.15);        // power strip
      carrels.set(seatId, buildCarrel(group, seatId, side, z, rowW, ghost));
    }));
    if (!ghost) {
      // a brand-coloured outline on the floor marks the live compartment
      // (only round the sides that have seats)
      const hw = PART_DEPTH + 0.75;
      const hl = length / 2 + 0.25;
      const used = (column) => comp.seats.some((row) => row[column]);
      const x0 = used(0) ? -hw : -0.25;
      const x1 = used(1) ? hw : 0.25;
      for (const s of [-1, 1]) parts.box(mat.arrow, x1 - x0, 0.01, 0.06, (x0 + x1) / 2, 0.012, s * hl);
      for (const x of [x0, x1]) parts.box(mat.arrow, 0.06, 0.01, 2 * hl, x, 0.012, 0);
    }
    parts.addTo(group);
  }

  // ---------- furniture and decoration (static, merged per material) ----------

  const deco = new Batch();
  // seats are modelled looking towards -x; FACING turns them to look the given way
  const FACING = { west: 0, north: -Math.PI / 2, east: Math.PI, south: Math.PI / 2 };
  const ovalTop = new THREE.CylinderGeometry(0.45, 0.45, 0.03, 28).scale(1, 1, 0.55);
  const ovalFoot = new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24).scale(1, 1, 0.6);
  const leaves = merge([0, 1, 2, 3, 4, 5].map((i) =>
    new THREE.ConeGeometry(0.05, 0.5, 4).translate(0, 0.25, 0).rotateZ(0.6).rotateY(i * 1.05)));

  const bookMats = ['#2f4b7c', '#c9a227', '#3e6b4a', '#b85c38', '#e8e2d4', '#7d2e2b', '#4a3f6b'].map((c) => std(c, 0.8));

  const turn = (lx, lz, a) => [lx * Math.cos(a) + lz * Math.sin(a), -lx * Math.sin(a) + lz * Math.cos(a)];
  function part(p, a, material, lx, y, lz, w, h, d) {
    const [ox, oz] = turn(lx, lz, a);
    deco.box(material, w, h, d, p.x + ox, y, p.z + oz, a);
  }
  function officeChair(p, a, lx, lz, look) {
    const [ox, oz] = turn(lx, lz, a);
    deco.place(mat.seat, chair.seat, p.x + ox, 0, p.z + oz, a + look);
    deco.place(mat.dark, chair.frame, p.x + ox, 0, p.z + oz, a + look);
  }

  const BUILD = {
    // group or study table: long side along local x, office chairs along both long sides
    table(f, p, a) {
      const [w, d] = f.size_m || [1.6, 0.8];
      const [south, north] = f.seats || [0, 0];
      part(p, a, ({ light: mat.counter, dark: mat.cabinet })[f.top] || mat.wood, 0, 0.74, 0, w, 0.05, d);
      if (f.base === 'panel') {
        for (const s of [-1, 1]) part(p, a, mat.wood, s * (w / 2 - 0.05), 0.36, 0, 0.05, 0.72, d - 0.12);
        part(p, a, mat.wood, 0, 0.42, 0, w - 0.12, 0.55, 0.04);
      } else {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(p, a, mat.metal, sx * (w / 2 - 0.06), 0.36, sz * (d / 2 - 0.06), 0.05, 0.72, 0.05);
      }
      for (const [n, side] of [[south, 1], [north, -1]]) {
        for (let i = 0; i < n; i++) officeChair(p, a, (i - (n - 1) / 2) * (w / n), side * (d / 2 + 0.32), side > 0 ? FACING.north : FACING.south);
      }
    },
    // Bloomberg cluster: two desks each side of a frosted divider, one more across the north end
    terminals(f, p, a) {
      for (const side of [-1, 1]) {
        for (const k of [-0.62, 0.62]) {
          part(p, a, mat.wood, side * 0.42, 0.74, k, 0.78, 0.05, 1.2);
          part(p, a, mat.metal, side * 0.78, 0.36, k, 0.05, 0.72, 1.1);
          for (const m of [-0.27, 0.27]) part(p, a, mat.monitor, side * 0.15, 1.02, k + m, 0.03, 0.32, 0.52);
          officeChair(p, a, side * 1.05, k, side > 0 ? FACING.west : FACING.east);
        }
      }
      part(p, a, mat.frost, 0, 1.0, 0, 0.03, 0.5, 2.5);
      part(p, a, mat.wood, 0, 0.74, -1.63, 1.2, 0.05, 0.78);
      for (const m of [-0.27, 0.27]) part(p, a, mat.monitor, m, 1.02, -1.32, 0.52, 0.32, 0.03);
      officeChair(p, a, 0, -2.34, FACING.south);
    },
    // lavender club armchair
    armchair(f, p) {
      const a = FACING[f.facing] ?? 0;
      part(p, a, mat.lavender, 0, 0.22, 0, 0.72, 0.36, 0.62);
      part(p, a, mat.lavender, 0.3, 0.45, 0, 0.16, 0.82, 0.8);
      for (const s of [-1, 1]) part(p, a, mat.lavender, 0, 0.33, s * 0.34, 0.76, 0.62, 0.14);
    },
    // teal armless lounge seats in a row
    lounge(f, p) {
      const a = FACING[f.facing] ?? 0;
      const n = f.seats || 1;
      for (let i = 0; i < n; i++) {
        const lz = (i - (n - 1) / 2) * 0.72;
        part(p, a, mat.teal, 0, 0.21, lz, 0.7, 0.42, 0.7);
        part(p, a, mat.teal, 0.29, 0.6, lz, 0.12, 0.42, 0.7);
      }
    },
    // oval wood table on a pedestal, next to lounge seats
    side_table(f, p, a) {
      deco.place(mat.wood, ovalTop, p.x, 0.62, p.z, a);
      deco.place(mat.dark, ovalFoot, p.x, 0.01, p.z, a);
      part(p, a, mat.metal, 0, 0.31, 0, 0.05, 0.6, 0.05);
    },
    pillar(f, p) {
      const s = f.size_m || 0.6;
      deco.box(mat.wall, s, 1.5, s, p.x, 0.75, p.z);
    },
    plant(f, p) {
      const y = f.on_m || 0;
      deco.add(mat.dark, new THREE.CylinderGeometry(0.13, 0.1, 0.24, 12).translate(p.x, y + 0.12, p.z));
      deco.place(mat.leaf, leaves, p.x, y + 0.2, p.z);
    },
    // bookcases along a line: the stacks, dark wall shelves, and the bent reference bookcase
    shelves(f) {
      const h = f.height_m || 1.6;
      const d = f.depth_m || 0.45;
      const side = f.style === 'dark' ? mat.shelfDark : f.style === 'reference' ? mat.wood : mat.counter;
      for (let i = 0; i + 1 < f.line.length; i++) {
        const { length, angle, mid } = segment(f.line[i], f.line[i + 1]);
        const texture = books.clone();
        texture.repeat.set(length / 2.4, f.style === 'reference' ? 0.5 : 1);
        texture.needsUpdate = true;
        const front = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 });
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(length + (i ? d : 0), h, d), [side, side, side, side, front, front]);
        shelf.position.set(mid.x, h / 2, mid.z);
        shelf.rotation.y = angle;
        shelf.castShadow = shelf.receiveShadow = true;
        scene.add(shelf);
      }
    },
    // front desk counter (cherry front, dark top), or low dark storage cabinets with "style": "cabinet"
    counter(f) {
      const d = f.depth_m || 0.6;
      const h = f.height_m || 1.05;
      const body = f.style === 'cabinet' ? mat.cabinet : mat.wood;
      for (let i = 0; i + 1 < f.line.length; i++) {
        const { length, angle, mid } = segment(f.line[i], f.line[i + 1]);
        deco.box(body, length + d, h - 0.04, d, mid.x, (h - 0.04) / 2, mid.z, angle);
        deco.box(f.style === 'cabinet' ? mat.dark : mat.cabinet, length + d + 0.04, 0.04, d + 0.06, mid.x, h - 0.02, mid.z, angle);
      }
    },
    // rolling whiteboard along a short line
    whiteboard(f) {
      const { length, angle, mid } = segment(f.line[0], f.line[1]);
      deco.box(mat.board, length, 0.9, 0.03, mid.x, 1.35, mid.z, angle);
      for (const t of [-0.5, 0.5]) {
        deco.box(mat.metal, 0.04, 1.8, 0.04, mid.x + Math.cos(-angle) * t * length, 0.9, mid.z + Math.sin(-angle) * t * length, angle);
      }
    },
    // book cart ("color": "yellow" or black)
    cart(f, p, a) {
      part(p, a, f.color === 'yellow' ? mat.yellow : mat.dark, 0, 0.5, 0, 0.75, 0.86, 0.38);
      part(p, a, mat.metal, 0, 0.04, 0, 0.7, 0.04, 0.34);
    },
    // a row of standing books on a counter or cabinet top ("on_m" is the surface height)
    book_display(f) {
      const y = f.on_m || 1.05;
      for (let i = 0; i + 1 < f.line.length; i++) {
        const { length, angle, mid } = segment(f.line[i], f.line[i + 1]);
        const n = Math.floor(length / 0.22);
        for (let k = 0; k < n; k++) {
          const t = ((k + 0.5) / n - 0.5) * length;
          const h = 0.2 + ((k * 7) % 4) * 0.025;
          deco.box(bookMats[(k * 5 + i) % bookMats.length], 0.17, h, 0.035, mid.x + Math.cos(-angle) * t, y + h / 2, mid.z + Math.sin(-angle) * t, angle);
        }
      }
    },
    // paper lanterns strung along the front of the desk
    garland(f) {
      const y = f.y_m || 0.85;
      for (let i = 0; i + 1 < f.line.length; i++) {
        const { length, angle, mid } = segment(f.line[i], f.line[i + 1]);
        const n = Math.floor(length / 0.3);
        for (let k = 0; k <= n; k++) {
          const t = (k / n - 0.5) * length;
          const sag = 0.08 * Math.sin(Math.PI * ((k % 4) / 4));
          deco.add(mat.lantern, new THREE.SphereGeometry(0.04, 8, 6).translate(mid.x + Math.cos(-angle) * t, y - sag, mid.z + Math.sin(-angle) * t));
        }
      }
    },
    // someone sitting on an office chair (e.g. staff at the front desk)
    person(f, p) {
      const look = FACING[f.facing] ?? 0;
      officeChair(p, 0, 0, 0, look);
      const someone = makePerson(f.seed || 0);
      someone.position.set(p.x, 0, p.z);
      someone.rotation.y = look;
      scene.add(someone);
    },
  };

  for (const f of layout.furniture || []) {
    const build = BUILD[f.type];
    if (build) build(f, f.at ? at(f.at) : null, THREE.MathUtils.degToRad(f.rot_deg || 0));
    else console.warn('Unknown furniture type in layout:', f.type);
  }

  // ---------- closed rooms (no seats): blank grey blocks, curtains behind any glass fronts ----------

  const ROOM_H = 1.9;
  const ROOM_T = WALL_T + 0.03;                    // thicker than the old walls under them, so their faces don't flicker
  const sheer = new Batch();                       // glass and curtains: no shadows
  for (const room of layout.rooms || []) {
    const pts = room.outline;
    const centre = pts.reduce((sum, p) => sum.add(at(p)), new THREE.Vector3()).divideScalar(pts.length);
    pts.forEach((p0, i) => {
      const p1 = pts[(i + 1) % pts.length];
      const { length, angle, mid } = segment(p0, p1);
      if (!(room.curtain_edges || []).includes(i)) {
        deco.box(mat.roomWall, length + ROOM_T, ROOM_H, ROOM_T, mid.x, ROOM_H / 2, mid.z, angle);
        return;
      }
      // glass front: sill, posts and header, a pane, and curtains just inside
      const along = new THREE.Vector3(Math.cos(-angle), 0, Math.sin(-angle));
      const inward = new THREE.Vector3(-along.z, 0, along.x);
      if (inward.dot(centre.clone().sub(mid)) < 0) inward.negate();
      deco.box(mat.roomWall, length + WALL_T, 0.25, WALL_T, mid.x, 0.125, mid.z, angle);
      deco.box(mat.roomWall, length + WALL_T, 0.12, WALL_T, mid.x, ROOM_H - 0.06, mid.z, angle);
      const posts = Math.max(1, Math.round(length / 1.5));
      for (let k = 0; k <= posts; k++) {
        const t = (k / posts - 0.5) * length;
        deco.box(mat.roomWall, 0.07, ROOM_H, 0.09, mid.x + along.x * t, ROOM_H / 2, mid.z + along.z * t, angle);
      }
      sheer.box(mat.glass, length, ROOM_H - 0.37, 0.03, mid.x, (ROOM_H + 0.13) / 2, mid.z, angle);
      const ch = ROOM_H - 0.45;
      sheer.add(mat.curtain, curtainGeometry(length - 0.1, ch).rotateY(angle)
        .translate(mid.x + inward.x * 0.12, 0.3 + ch / 2, mid.z + inward.z * 0.12));
    });
    const roof = new THREE.ExtrudeGeometry(flatShape(pts), { depth: 0.06, bevelEnabled: false });
    deco.add(mat.roomRoof, roof.rotateX(-Math.PI / 2).translate(0, ROOM_H, 0));
  }
  sheer.addTo(scene, false);

  // ---------- area rugs ----------

  for (const r of layout.rugs || []) {
    const p = at(r.at);
    const [w, d] = r.size_m;
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: rugTexture(r.color, r.accent || '#f3ead8'), roughness: 1 }));
    rug.position.set(p.x, 0.008, p.z);
    rug.rotation.y = THREE.MathUtils.degToRad(r.rot_deg || 0);
    rug.receiveShadow = true;
    scene.add(rug);
  }

  deco.addTo(scene);

  function buildCarrel(group, seatId, side, z, rowW, ghost) {
    const c = { seatId, side, ghost, state: null, pull: 0, turn: 0, target: [0, 0] };
    c.worldPos = new THREE.Vector3(side * 0.6, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), group.rotation.y).add(group.position);

    c.chair = new THREE.Group();
    const seat = new THREE.Mesh(chair.seat, mat.seat);
    const frame = new THREE.Mesh(chair.frame, mat.dark);
    seat.castShadow = frame.castShadow = true;
    c.chair.add(seat, frame);
    c.chairX = side * (SPINE_T / 2 + DESK_D + 0.14);
    c.chairRot = side > 0 ? 0 : Math.PI;
    c.chair.position.set(c.chairX, 0, z);
    c.chair.rotation.y = c.chairRot;
    group.add(c.chair);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(PART_DEPTH + 0.8, PANEL_H, rowW), mat.hit);
    hit.position.set(side * (PART_DEPTH + 0.8) / 2, PANEL_H / 2, z);
    hit.userData.seatId = seatId;
    group.add(hit);
    hitBoxes.push(hit);

    if (ghost) return c;

    c.person = makePerson(hitBoxes.length);
    c.bag = new THREE.Mesh(bagGeo, mat.bag);
    c.bag.position.set(0.07, 0.69, 0);
    c.bag.castShadow = true;
    c.chair.add(c.person, c.bag);

    c.laptop = new THREE.Mesh(laptopGeo, mat.laptop);
    c.laptop.castShadow = true;
    c.laptop.position.set(side * (SPINE_T / 2 + DESK_D * 0.6), DESK_H + DESK_T / 2, z - rowW * 0.08);
    c.laptop.rotation.y = c.chairRot;
    group.add(c.laptop);

    c.lamp = new THREE.Mesh(lampHeadGeo, new THREE.MeshStandardMaterial({ color: 0xd9dcde, roughness: 0.4 }));
    c.lamp.position.set(side * (SPINE_T / 2 + 0.15), DESK_H + 0.5, z + rowW * 0.3);
    group.add(c.lamp);

    // light on the desk and on the floor around the chair, in the state colour
    c.glow = new THREE.MeshBasicMaterial({ map: glow, transparent: true, depthWrite: false, toneMapped: false });
    const pool = new THREE.Mesh(glowGeo, c.glow);
    pool.scale.set(DESK_D * 0.95, 1, rowW * 0.9);
    pool.position.set(side * (SPINE_T / 2 + DESK_D / 2), DESK_H + DESK_T / 2 + 0.004, z);
    const halo = new THREE.Mesh(glowGeo, c.glow);
    halo.scale.set(1.7, 1, rowW * 1.05);
    halo.position.set(side * (SPINE_T / 2 + DESK_D + 0.4), 0.012, z);
    group.add(pool, halo);
    c.lit = [pool, halo];

    c.ripple = new THREE.Mesh(rippleGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    c.ripple.position.set(side * (SPINE_T / 2 + DESK_D / 2 + 0.3), 0.02, z);
    c.ripple.visible = false;
    group.add(c.ripple);

    c.pin = document.createElement('button');
    c.pin.type = 'button';
    c.pin.className = 'pin';
    c.pin.addEventListener('click', (event) => {
      event.stopPropagation();
      onSelect(seatId);
    });
    const pin = new CSS2DObject(c.pin);
    pin.position.set(side * (SPINE_T / 2 + DESK_D / 2 + 0.15), PANEL_H + 0.45, z);
    group.add(pin);
    return c;
  }

  // ---------- state ----------

  const BLACK = new THREE.Color(0x000000);
  let selectedId = null;
  let lastStates = new Map();

  function paint(c) {
    const off = c.state === 'OFFLINE';
    const color = palette[c.state] || palette.OFFLINE;
    c.glow.color.copy(color);
    c.glow.opacity = palette.dark ? 0.85 : 0.55;
    c.glow.blending = palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    c.glow.needsUpdate = true;
    c.lit.forEach((m) => { m.visible = !off; });
    c.lamp.material.emissive.copy(off ? BLACK : color);
    c.lamp.material.emissiveIntensity = palette.dark ? 2.2 : 1.2;
  }

  function placeChair(c) {
    c.chair.position.x = c.chairX + c.side * c.pull;
    c.chair.rotation.y = c.chairRot + c.side * c.turn;
  }

  function setStates(states, { animate = true } = {}) {
    for (const c of carrels.values()) {
      if (c.ghost) continue;
      const state = states.get(c.seatId) || 'OFFLINE';
      const changed = c.state !== null && c.state !== state;
      c.state = state;
      paint(c);
      c.person.visible = state === 'OCCUPIED';
      c.laptop.visible = state === 'OCCUPIED' || state === 'AWAY';
      c.bag.visible = state === 'AWAY';
      c.target = CHAIR[state] || CHAIR.OFFLINE;
      if (!animate || reduceMotion.matches) {
        [c.pull, c.turn] = c.target;
        placeChair(c);
      }
      if (changed && animate && !reduceMotion.matches) ripple(c);
      decoratePin(c.pin, { seatId: c.seatId, state, selected: c.seatId === selectedId });
    }
    lastStates = states;
    dirty = true;
  }

  // ---------- animation (only renders while something moves) ----------

  const animations = new Set();
  let dirty = true;
  let tween = null;
  let currentView = 'carrels';   // preset view to keep fitted when the screen size changes

  // eases each chair towards where its state puts it; returns whether any moved
  function stepChairs(dt) {
    let moving = false;
    const k = 1 - Math.exp(-dt * 6);
    for (const c of carrels.values()) {
      if (c.ghost) continue;
      const dp = c.target[0] - c.pull;
      const dr = c.target[1] - c.turn;
      if (Math.abs(dp) < 0.001 && Math.abs(dr) < 0.001) continue;
      c.pull += dp * k;
      c.turn += dr * k;
      placeChair(c);
      moving = true;
    }
    return moving;
  }

  function ripple(c) {
    let t = 0;
    c.ripple.material.color.copy(palette[c.state] || palette.OFFLINE);
    c.ripple.visible = true;
    const run = (dt) => {
      t += dt / 1.2;
      c.ripple.scale.setScalar(1 + t * 3.5);
      c.ripple.material.opacity = 0.9 * Math.max(0, 1 - t);
      if (t < 1) return true;
      c.ripple.visible = false;
      return false;
    };
    animations.add(run);
  }

  function frame(box, polarDeg, thetaDeg) {
    // camera target and position that fit `box` (on the floor) on screen from the given angles
    const polar = THREE.MathUtils.degToRad(polarDeg);
    const theta = THREE.MathUtils.degToRad(thetaDeg);
    const target = new THREE.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2);
    const hw = (box.max.x - box.min.x) / 2;
    const hd = (box.max.z - box.min.z) / 2;
    const across = Math.abs(Math.cos(theta)) * hw + Math.abs(Math.sin(theta)) * hd;
    const along = Math.abs(Math.sin(theta)) * hw + Math.abs(Math.cos(theta)) * hd;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = Math.max(across / Math.tan(hfov / 2),
      1.35 * (along * Math.cos(polar) + 0.8 * Math.sin(polar)) / Math.tan(vfov / 2)) * 1.1;
    return { target, position: target.clone().add(new THREE.Vector3().setFromSphericalCoords(dist, polar, theta)) };
  }

  const portrait = () => camera.aspect < 1;
  const views = {
    carrels: () => frame(view, layout.carrel_view.polar_deg, layout.carrel_view.theta_deg),
    floor: () => frame(fullArea, 40, portrait() ? 90 : 0),
    top: () => frame(fullArea, 0.5, portrait() ? 90 : 0),
  };

  function flyTo({ target, position }, instant = reduceMotion.matches) {
    if (instant) {
      tween = null;
      controls.target.copy(target);
      camera.position.copy(position);
      controls.update();
      dirty = true;
      return;
    }
    const from = { target: controls.target.clone(), position: camera.position.clone() };
    let t = 0;
    tween = (dt) => {
      t = Math.min(1, t + dt / 0.8);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      controls.target.lerpVectors(from.target, target, k);
      camera.position.lerpVectors(from.position, position, k);
      return t < 1;
    };
  }

  function focusSeat(seatId) {
    const c = carrels.get(seatId);
    if (!c) return;
    const now = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const p = c.worldPos;
    const box = { min: new THREE.Vector3(p.x - 1.6, 0, p.z - 1.6), max: new THREE.Vector3(p.x + 1.6, 0, p.z + 1.6) };
    flyTo(frame(box, THREE.MathUtils.radToDeg(Math.min(now.phi, 1.0)), THREE.MathUtils.radToDeg(now.theta)));
  }

  // ---------- input ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let press = null;
  let fingers = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    fingers++;
    press = fingers === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    fingers = Math.max(0, fingers - 1);
    if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8 || performance.now() - press.t > 500) return;
    press = null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hitBoxes, false)[0];
    onSelect(hit ? hit.object.userData.seatId : null);
  });
  renderer.domElement.addEventListener('pointercancel', () => { fingers = Math.max(0, fingers - 1); press = null; });

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (currentView) flyTo(views[currentView](), true);
    dirty = true;
  }

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    let busy = false;
    if (tween) {
      busy = true;
      if (!tween(dt)) tween = null;
    }
    if (controls.update()) busy = true;
    if (stepChairs(dt)) busy = true;
    for (const run of animations) {
      busy = true;
      if (!run(dt)) animations.delete(run);
    }
    if (busy || dirty) {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      dirty = false;
    }
  }

  readPalette();
  applyTheme();
  darkScheme.addEventListener('change', () => {
    readPalette();
    applyTheme();
    setStates(lastStates, { animate: false });
  });

  new ResizeObserver(resize).observe(container);
  resize();
  requestAnimationFrame(loop);

  return {
    setStates,
    setView(name, instant = false) {
      if (!views[name]) return;
      currentView = name;
      flyTo(views[name](), instant || reduceMotion.matches);
    },
    select(seatId) {
      selectedId = seatId;
      for (const c of carrels.values()) {
        if (!c.ghost) decoratePin(c.pin, { seatId: c.seatId, state: c.state, selected: c.seatId === selectedId });
      }
      if (seatId) {
        currentView = null;
        focusSeat(seatId);
      }
      dirty = true;
    },
  };
}
