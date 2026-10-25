// リング × フック設定 クレーンゲーム練習
// アームからチェーンでリングがぶら下がっている。アクリル板の上に立つ固定フックの
// 「開いている側」へリングを滑り込ませ、引き上げ時にフックへ掛かると、
// フックとチェーンでつながった下の網台が吊り上がって傾き、景品が取り出し口へ落ちる。
//
// 単位: 1 = 10cm。重力も 98 (= 9.8 m/s²) にスケールして実機の時間感覚を再現する。
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// ---------------------------------------------------------------- 定数
const G = 98;
const DT = 1 / 180;
const CAB = { xMin: -4, xMax: 4, zMin: -3, zMax: 3, h: 15.2 };
const CHUTE_X = -2.1;                 // x < CHUTE_X が取り出し口
const HOME = { x: -3.0, z: 2.2 };     // アームの初期位置（左手前・取り出し口の上）
const RANGE = { xMin: -3.2, xMax: 3.3, zMin: -2.5, zMax: 2.3 };
const CARRIAGE_Y = 14.4;
const L_HOME = 0.7;
const SPEEDS = { 0: 1.1, 0.5: 1.6, 1: 2.4 };   // クレーンの移動速度 小 11cm/s・中 16cm/s・大 24cm/s（速いほど止めた時によく揺れる）
const ACCEL = 60;                     // 実機のガントリーはほぼ急発進・急停止（アーム本体は揺れず、リングだけが振れる）
const DESCEND_SPEED = 1.4;
const LIFT_SPEED = 1.0;
const BOTTOM_HOLD = 1.2;             // 下降停止後、引き上げまでの待ち時間
const FREE_TIME = 15;

const RING_SIZES = { L: { R: 0.8, label: '大' }, M: { R: 0.6, label: '中' }, S: { R: 0.45, label: '小' } };
const TUBE = 0.055;

const HEAD_HY = 0.26;
const DEFAULT_CHAIN = 2.2;             // チェーンの既定 22cm
// アームが下りる高さ（台の固定設定）: 既定のチェーンで、リングとチェーンをつなぐ金具（リングの付け根）が
// 板から 2cm 浮く高さ。リング本体は板に着いて斜めに寝る。チェーンを伸ばすと付け根も板に着いてリングが平らに倒れる
const armStop = () => HEAD_HY + DEFAULT_CHAIN + 0.2;
// チェーンの最短: 下降しきったとき、まっすぐ垂れたリングの下端が板に届く長さ（これより短いとフックに届かず取れない）
// 大 8cm / 中 12cm / 小 15cm
const chainMin = size => Math.ceil((armStop() - HEAD_HY - 2 * RING_SIZES[size].R) * 20) / 20;
const CHAIN_MAX = 4.0;
const chainDrop = () => HEAD_HY + settings.chain;    // ヘッド中心からリング上端まで
let NOISE = 0.006;

const RACK = { len: 3.8, halfZ: 1.4, thick: 0.1, topY: 2.1 };   // 網台。ヒンジは x = CHUTE_X
const SHELF = { xMin: -1.2, xMax: 3.95, zMin: -2.95, zMax: 2.95, topY: 3.95, thick: 0.1 };
const HOOK = { stemTop: 0.62, apexY: 0.82, apexZ: 0.26, endY: 0.7, endZ: 0.46, tipY: 0.3, w: 0.045 };

const GR = { STATIC: 1, RACK: 2, PRIZE: 4, HEAD: 8, RING: 16, HOOK: 32, SHELF: 64 };
// 床（アクリル板）とリングの摩擦。cannon-es の摩擦は「μ×重力×質量」を接触点ごとの上限にする近似で、
// 実際の垂直抗力を使わない（リングは小球の集まりなので寝ると接触点の数だけ摩擦が増えて全く動かなくなる）。
// そのためエンジンの摩擦は 0 にして、接触の垂直抗力から静止摩擦・動摩擦を自前で計算する（applyRingFloorFriction）
const FLOOR_MU = { defaultKinetic: 0.12, staticRatio: 1.35, staticExtra: 0.02, stickSpeed: 0.04 };
const floorMuS = () => settings.floorMuK * FLOOR_MU.staticRatio + FLOOR_MU.staticExtra;

// ---------------------------------------------------------------- 設定・記録
const DEFAULTS = { speed: 0.5, difficulty: 'normal', marker: true, floorMuK: FLOOR_MU.defaultKinetic, chain: 2.2, reflect: true, grid: true, mode: 'fixed', size: 'M', hookDir: 'random', hookYaw: 90, ringYaw: 90, twist: 0.5, swing: 0.65, random: true, pip: true };
const savedSettings = localStorage.getItem('ufo-hook-settings');
const storedSettings = JSON.parse(savedSettings || '{}') || {};
const settings = Object.assign({}, DEFAULTS, storedSettings);
if (!['high', 'normal', 'easy'].includes(storedSettings.difficulty)) {
  // 旧版はリングサイズ L が高難易度を兼ねていたため、その状態だけ引き継ぐ
  settings.difficulty = storedSettings.size === 'L' || storedSettings.hard ? 'high' : 'normal';
}
delete settings.captureModel;
// スマホの初回は重い映り込みをオフにしておく
if (!savedSettings && matchMedia('(pointer: coarse)').matches) settings.reflect = false;
// 保存済み設定の移行
//  v2: 既定のリング・フックを 90°、揺れやすさを少し上げた
//  v4: チェーン既定 30cm（下ろしたときにリングが板の上を滑って傾く動きが大事）
//  v5: リングの揺れやすさの既定を「大」に
//  v6: チェーンの既定 = 下降時にリング下端が板から 2cm 浮く長さ
if (savedSettings && (settings.v ?? 1) < 5) {
  if ((settings.v ?? 1) < 2) Object.assign(settings, { hookYaw: DEFAULTS.hookYaw, ringYaw: DEFAULTS.ringYaw });
  if ((settings.v ?? 1) < 4) settings.chain = Math.max(settings.chain, DEFAULTS.chain);
  settings.swing = Math.max(settings.swing, DEFAULTS.swing);
}
delete settings.armStop;
if ((settings.v ?? 1) < 7) settings.chain = DEFAULT_CHAIN;
if ((settings.v ?? 1) < 8 && !settings.twist) settings.twist = DEFAULTS.twist;   // v8: 揺れでリングが回るを既定でオン   // v7: チェーン既定 22cm・下降位置はリングが 2cm 浮く高さ
if (savedSettings && (storedSettings.v ?? 1) < 12 && storedSettings.swing === 0.75) settings.swing = DEFAULTS.swing;
if (savedSettings && (storedSettings.v ?? 1) < 17) settings.floorMuK = DEFAULTS.floorMuK;   // v17: 摩擦を垂直抗力ベースに作り直し
delete settings.floorMu;
delete settings.weight;
delete settings.hard;
settings.v = 17;
localStorage.setItem('ufo-hook-settings', JSON.stringify(settings));
const saveSettings = () => localStorage.setItem('ufo-hook-settings', JSON.stringify(settings));
const statKey = () => {
  const legacyDifficulty = settings.size === 'L' ? 'high' : 'normal';
  const difficultyKey = settings.difficulty === legacyDifficulty ? '' : `-difficulty-${settings.difficulty}`;
  return `ufo-hook-stats-${settings.mode}-${settings.size}${difficultyKey}-physical`;
};
const loadStats = () => Object.assign({ tries: 0, wins: 0, streak: 0, best: 0 }, JSON.parse(localStorage.getItem(statKey()) || '{}'));
const saveStats = s => localStorage.setItem(statKey(), JSON.stringify(s));

// ---------------------------------------------------------------- 物理ワールド
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
world.solver.iterations = 40;
world.solver.tolerance = 1e-4;
world.allowSleep = false;

const mat = {
  stat: new CANNON.Material('static'),
  rack: new CANNON.Material('rack'),
  prize: new CANNON.Material('prize'),
  ring: new CANNON.Material('ring'),
  hook: new CANNON.Material('hook'),
  shelf: new CANNON.Material('shelf'),
};
world.defaultContactMaterial.friction = 0.3;
world.defaultContactMaterial.restitution = 0.05;
const cm = (a, b, friction, restitution = 0.05) =>
  world.addContactMaterial(new CANNON.ContactMaterial(a, b, { friction, restitution }));
cm(mat.prize, mat.rack, 0.12);
cm(mat.prize, mat.stat, 0.45);
world.addContactMaterial(new CANNON.ContactMaterial(mat.ring, mat.hook, { friction: 0, restitution: 0 }));
// アクリル板とリングの摩擦（設定「床の滑りやすさ」で切り替え）。既定はよく滑る:
// 着地後、リングの付け根（チェーンの支点）は落ちた位置から動かず、板に着いた先端側が滑って倒れる
const ringShelfCM = new CANNON.ContactMaterial(mat.ring, mat.shelf, { friction: 0, restitution: 0 });   // 摩擦は自前（上のコメント参照）
world.addContactMaterial(ringShelfCM);
cm(mat.hook, mat.shelf, 0.5, 0);

const V = (x, y, z) => new CANNON.Vec3(x, y, z);
const Z_AXIS = V(0, 0, 1);
const Y_AXIS = V(0, 1, 0);
const DEG = Math.PI / 180;
const yawQ = deg => new CANNON.Quaternion().setFromAxisAngle(Y_AXIS, deg * DEG);

// ---------------------------------------------------------------- 描画
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, IS_TOUCH ? 1.5 : 2));   // スマホは描画を軽く
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3f1f6);
scene.fog = new THREE.Fog(0xf3f1f6, 30, 55);
// 映り込み用の環境マップ（金属のリング・フック、アクリル板に周囲が映る）
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

const camMain = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
const camPip = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
const VIEWS = [
  { name: '正面', pos: [0, 14.6, 24], look: [0, 6.6, 0] },   // 立った目線でやや上から
  { name: '右横', pos: [22, 9, 0.3], look: [0, 6.2, 0] },
  { name: '斜め', pos: [13.5, 14, 14.5], look: [0, 5.8, 0] },
  { name: '真上', pos: [0, 24, 0.01], look: [0, 0, 0], noRoof: true },
];
let viewIdx = 0;
const ROOF_LAYER = 1;
camPip.layers.enable(ROOF_LAYER);
// 画面の縦横比に合わせて、筐体の横幅が収まる距離までカメラを引く（スマホ縦持ち対応）
function placeCamera(cam, v, halfW = 5.4, near = 3) {
  const look = new THREE.Vector3(...v.look), dir = new THREE.Vector3(...v.pos).sub(look);
  const d0 = dir.length(); dir.normalize();
  const tanH = Math.tan(cam.fov * DEG / 2) * cam.aspect;
  const dist = Math.max(d0, (cam === camMain && viewRects?.main.y ? halfW - 0.5 : halfW) / tanH + near);   // 手前のガラス面（z=3）基準で横幅 ±5.4 が入る距離
  // 縦長画面で操作ボタンの上に重ねて描くときは、ボタンの分だけ筐体を上へ
  if (cam === camMain && !viewRects?.main.y && cam.aspect < 0.8 && !v.noRoof) look.y -= 1.2;
  // 小窓の上に詰めたメイン画面では、筐体の上端が切れないよう少し上を見る
  if (cam === camMain && viewRects?.main.y && !v.noRoof) look.y += 0.9;
  cam.position.copy(look).addScaledVector(dir, dist);
  cam.lookAt(look);
}
function applyView() {
  const v = VIEWS[viewIdx];
  placeCamera(camMain, v);
  if (v.noRoof) camMain.layers.disable(ROOF_LAYER); else camMain.layers.enable(ROOF_LAYER);
  const p = VIEWS[viewIdx === 1 ? 0 : 1];
  placeCamera(camPip, p, viewIdx === 1 ? 5.4 : 3.4, viewIdx === 1 ? 3 : 4);   // 横からの別視点は奥行き方向（約±3.4）が入ればよい
}

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d0e0, 0.5));
const topLight = new THREE.DirectionalLight(0xffffff, 2.6);
topLight.position.set(0.5, 22, 1.5);   // ほぼ真上 → 板にリングとフックの影が落ちる
topLight.castShadow = true;
topLight.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048);
Object.assign(topLight.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 5, far: 30 });
topLight.shadow.bias = -0.0003;
topLight.shadow.normalBias = 0.01;
scene.add(topLight);
const front = new THREE.DirectionalLight(0xffffff, 0.35);
front.position.set(2, 6, 14);
scene.add(front);

const M = {
  white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }),
  whiteMatte: new THREE.MeshStandardMaterial({ color: 0xf7f7fa, roughness: 0.9 }),
  floor: new THREE.MeshStandardMaterial({ color: 0xe9e6ef, roughness: 0.85 }),
  chute: new THREE.MeshStandardMaterial({ color: 0x3a3440, roughness: 0.9 }),
  pink: new THREE.MeshStandardMaterial({ color: 0xff7eb6, roughness: 0.4 }),
  led: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, roughness: 0, side: THREE.DoubleSide, depthWrite: false }),
  acrylic: new THREE.MeshPhysicalMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.22, roughness: 0.02, metalness: 0, clearcoat: 1, envMapIntensity: 1.5, depthWrite: false }),
  acrylicEdge: new THREE.MeshStandardMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.7 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xd0d4dc, metalness: 0.9, roughness: 0.2 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xf2c200, metalness: 0.85, roughness: 0.25 }),
  wire: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.35 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.1, roughness: 0.3 }),
  ring: new THREE.MeshStandardMaterial({ color: 0xe2e5ec, metalness: 0.95, roughness: 0.12 }),
};
const shadowy = m => { m.castShadow = true; m.receiveShadow = true; return m; };
const box = (w, h, d, m) => shadowy(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m));
const cyl = (r, h, m, seg = 12) => shadowy(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m));
let shelfReflector = null, shelfGrid = null;   // アクリル板の映り込み・目盛り線

// ---------------------------------------------------------------- 筐体（静的）
function addStaticBox(cx, cy, cz, hx, hy, hz, mesh = null, opts = {}) {
  const b = new CANNON.Body({
    mass: 0, material: opts.material ?? mat.stat,
    collisionFilterGroup: opts.group ?? GR.STATIC, collisionFilterMask: opts.mask ?? -1,
  });
  b.addShape(new CANNON.Box(V(hx, hy, hz)));
  b.position.set(cx, cy, cz);
  world.addBody(b);
  if (mesh) { const m = box(hx * 2, hy * 2, hz * 2, mesh); m.position.set(cx, cy, cz); scene.add(m); }
  return b;
}
(function buildCabinet() {
  const W = CAB.xMax - CAB.xMin, D = CAB.zMax - CAB.zMin;
  // 床（取り出し口部分は穴）
  addStaticBox((CHUTE_X + CAB.xMax) / 2, -0.1, 0, (CAB.xMax - CHUTE_X) / 2, 0.1, D / 2, M.floor);
  addStaticBox((CAB.xMin + CHUTE_X) / 2, -2.0, 0, (CHUTE_X - CAB.xMin) / 2, 0.5, D / 2, M.chute);
  addStaticBox(CHUTE_X + 0.5, -1.1, 0, 0.5, 1.1, D / 2, M.chute);
  const rim = box(0.1, 0.14, D, M.pink); rim.position.set(CHUTE_X - 0.05, 0.07, 0); scene.add(rim);
  // 壁（見えない当たり判定＋ガラス）
  addStaticBox(CAB.xMin - 0.1, CAB.h / 2 - 1, 0, 0.1, CAB.h / 2 + 1, D / 2);
  addStaticBox(CAB.xMax + 0.1, CAB.h / 2 - 1, 0, 0.1, CAB.h / 2 + 1, D / 2);
  addStaticBox(0, CAB.h / 2 - 1, CAB.zMin - 0.1, W / 2, CAB.h / 2 + 1, 0.1);
  addStaticBox(0, CAB.h / 2 - 1, CAB.zMax + 0.1, W / 2, CAB.h / 2 + 1, 0.1);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, CAB.h + 2.4), M.whiteMatte);
  back.position.set(0, CAB.h / 2 - 1.2, CAB.zMin - 0.02); back.receiveShadow = true; scene.add(back);
  for (const [x, z, ry, w] of [[CAB.xMin, 0, Math.PI / 2, D], [CAB.xMax, 0, Math.PI / 2, D], [0, CAB.zMax, 0, W]]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, CAB.h), M.glass);
    g.position.set(x, CAB.h / 2, z); g.rotation.y = ry; scene.add(g);
  }
  // 白いフレーム・天井・土台
  for (const x of [CAB.xMin, CAB.xMax]) for (const z of [CAB.zMin, CAB.zMax]) {
    const p = box(0.22, CAB.h + 2.4, 0.22, M.white); p.position.set(x, CAB.h / 2 - 1.2, z); scene.add(p);
  }
  const roof = box(W + 0.6, 0.6, D + 0.6, M.white); roof.position.set(0, CAB.h + 0.3, 0); scene.add(roof);
  const ledStrip = box(W - 0.4, 0.06, 0.2, M.led); ledStrip.position.set(0, CAB.h - 0.05, CAB.zMax - 0.3); scene.add(ledStrip);
  const pinkBand = box(W + 0.62, 0.18, 0.05, M.pink); pinkBand.position.set(0, CAB.h + 0.3, CAB.zMax + 0.33); scene.add(pinkBand);
  // 天井は「真上」視点では描かない（レイヤー 1）。真上のライトの影も落とさない
  for (const m of [roof, ledStrip, pinkBand]) { m.layers.set(ROOF_LAYER); m.castShadow = false; }
  const base = box(W + 0.6, 2.4, D + 0.6, M.white); base.position.set(0, -1.42, 0); scene.add(base);
  const panel = box(W + 0.62, 0.5, 0.05, M.pink); panel.position.set(0, -0.6, CAB.zMax + 0.33); scene.add(panel);
  // ガントリーのレール
  for (const z of [RANGE.zMin - 0.3, RANGE.zMax + 0.3]) {
    const r = box(W - 0.2, 0.12, 0.12, M.metal); r.position.set(0, CARRIAGE_Y + 0.35, z); scene.add(r);
  }
  // アクリル板（フックが乗る棚）
  const sx = (SHELF.xMin + SHELF.xMax) / 2, sz = (SHELF.zMin + SHELF.zMax) / 2;
  const shx = (SHELF.xMax - SHELF.xMin) / 2, shz = (SHELF.zMax - SHELF.zMin) / 2;
  addStaticBox(sx, SHELF.topY - SHELF.thick / 2, sz, shx, SHELF.thick / 2, shz, null,
    { group: GR.SHELF, mask: GR.RING | GR.HOOK | GR.HEAD | GR.PRIZE, material: mat.shelf });
  const acr = new THREE.Mesh(new THREE.BoxGeometry(shx * 2, SHELF.thick, shz * 2), M.acrylic);
  acr.position.set(sx, SHELF.topY - SHELF.thick / 2, sz); acr.receiveShadow = true; scene.add(acr);
  buildShelfSurface(sx, sz, shx * 2, shz * 2);
  const edge = box(0.04, SHELF.thick + 0.02, shz * 2, M.acrylicEdge); edge.position.set(SHELF.xMin, SHELF.topY - SHELF.thick / 2, sz); scene.add(edge);
  const edge2 = box(shx * 2, SHELF.thick + 0.02, 0.04, M.acrylicEdge); edge2.position.set(sx, SHELF.topY - SHELF.thick / 2, SHELF.zMax); scene.add(edge2);
  // 板を支える白い金具
  for (const z of [SHELF.zMin + 0.2, SHELF.zMax - 0.2]) {
    const b = box(0.1, SHELF.topY - 0.1, 0.1, M.white); b.position.set(SHELF.xMax - 0.05, (SHELF.topY - 0.1) / 2, z); scene.add(b);
  }
  // 網台を下から支える支柱とヒンジ台座
  addStaticBox(1.4, (RACK.topY - RACK.thick - 0.02) / 2, 0, 0.15, (RACK.topY - RACK.thick - 0.02) / 2, 0.3, M.white,
    { mask: GR.RACK | GR.PRIZE });
  const ped = box(0.16, RACK.topY - 0.1, 0.5, M.white);
  ped.position.set(CHUTE_X + 0.02, (RACK.topY - 0.1) / 2 - 0.05, 0); scene.add(ped);
  const axle = cyl(0.06, RACK.halfZ * 2 + 0.3, M.metal, 16);
  axle.rotation.x = Math.PI / 2; axle.position.set(CHUTE_X, RACK.topY - RACK.thick / 2, 0); scene.add(axle);
  const label = makeLabel('GET!', '#ff4f9a');
  label.position.set((CAB.xMin + CHUTE_X) / 2, 0.03, CAB.zMax - 0.6); label.rotation.x = -Math.PI / 2; scene.add(label);
})();

function makeLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
}

// アクリル板の上面: 映り込み（Reflector）・影だけを描く面・目盛り線
function buildShelfSurface(cx, cz, w, d) {
  const y = SHELF.topY;
  // 映り込み。Reflector は不透明なので、シェーダーの α を下げて半透明にする
  shelfReflector = new Reflector(new THREE.PlaneGeometry(w, d), {
    textureWidth: 1024, textureHeight: 1024, color: 0xffffff, clipBias: 0.003,
  });
  shelfReflector.material.fragmentShader = shelfReflector.material.fragmentShader
    .replace('vec4( blendOverlay( base.rgb, color ), 1.0 )', 'vec4( blendOverlay( base.rgb, color ), 0.2 )');
  shelfReflector.material.transparent = true;
  shelfReflector.material.depthWrite = false;
  shelfReflector.rotation.x = -Math.PI / 2;
  shelfReflector.position.set(cx, y + 0.002, cz);
  shelfReflector.renderOrder = 1;
  scene.add(shelfReflector);
  // 影だけを受ける透明な面（透明なアクリルでも影がくっきり見える）
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.ShadowMaterial({ opacity: 0.32 }));
  shadowPlane.rotation.x = -Math.PI / 2; shadowPlane.position.set(cx, y + 0.004, cz);
  shadowPlane.receiveShadow = true; shadowPlane.renderOrder = 2;
  scene.add(shadowPlane);
  // 目盛り線（0.5 = 5cm ごと）
  const c = document.createElement('canvas'), px = 64;
  c.width = Math.round(w / 0.5) * px; c.height = Math.round(d / 0.5) * px;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(80,150,210,0.45)'; g.lineWidth = 2;
  for (let x = 0; x <= c.width; x += px) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
  for (let z = 0; z <= c.height; z += px) { g.beginPath(); g.moveTo(0, z); g.lineTo(c.width, z); g.stroke(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  shelfGrid = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  shelfGrid.rotation.x = -Math.PI / 2; shelfGrid.position.set(cx, y + 0.006, cz); shelfGrid.renderOrder = 3;
  scene.add(shelfGrid);
}
function applyShelfOptions() {
  if (shelfReflector) shelfReflector.visible = settings.reflect;
  if (shelfGrid) shelfGrid.visible = settings.grid;
}

// ---------------------------------------------------------------- 動的オブジェクトの管理
const synced = [];   // { body, obj }
function link(body, obj) { synced.push({ body, obj }); scene.add(obj); }
function unlink(body) {
  const i = synced.findIndex(s => s.body === body);
  if (i >= 0) { scene.remove(synced[i].obj); synced.splice(i, 1); }
  world.removeBody(body);
}

// ---------------------------------------------------------------- 網台・フック・景品（毎ラウンド作り直す）
const HINGE = { x: CHUTE_X, y: RACK.topY - RACK.thick / 2 };
const RACK_MASS = 3.0;   // 網台の重さ（固定。掛かれば必ず持ち上がる）
const MAX_TILT = 35 * Math.PI / 180;
let round = null;   // { rack, hook, chain, prize, lay, theta }

function randomLayout() {
  if (game.forceLayout) return { ...game.forceLayout };
  // フックの開いている側（+1: 手前 / -1: 奥）
  const dir = settings.hookDir === 'front' ? 1 : settings.hookDir === 'back' ? -1 : (Math.random() < 0.5 ? 1 : -1);
  if (!settings.random) return { x: 0.9, z: 0.0, dir };
  return { x: 0.3 + Math.random() * 1.0, z: -1.0 + Math.random() * 1.8, dir };
}

function buildRack(lay) {
  // 原点＝板の中心（≒重心）。左端がヒンジ。
  const cx = CHUTE_X + RACK.len / 2, cy = RACK.topY - RACK.thick / 2;
  // 網台は「フックの高さ」から角度を決める運動学的な剛体（重さはフックに掛かる力として扱う）
  const body = new CANNON.Body({
    mass: 0, type: CANNON.Body.KINEMATIC, material: mat.rack, position: V(cx, cy, 0),
    collisionFilterGroup: GR.RACK, collisionFilterMask: GR.PRIZE,
  });
  body.addShape(new CANNON.Box(V(RACK.len / 2, RACK.thick / 2, RACK.halfZ)));
  // 景品止めの低い枠（奥・手前のみ）
  for (const s of [-1, 1]) body.addShape(new CANNON.Box(V(RACK.len / 2, 0.12, 0.03)), V(0, RACK.thick / 2 + 0.12, s * (RACK.halfZ - 0.03)));
  body.updateMassProperties();

  const obj = new THREE.Group();
  const wireR = 0.018;
  for (let x = -RACK.len / 2; x <= RACK.len / 2 + 1e-6; x += 0.3) {
    const w = cyl(wireR, RACK.halfZ * 2, M.wire, 6); w.rotation.x = Math.PI / 2; w.position.set(x, RACK.thick / 2, 0); obj.add(w);
  }
  for (let z = -RACK.halfZ; z <= RACK.halfZ + 1e-6; z += 0.3) {
    const w = cyl(wireR, RACK.len, M.wire, 6); w.rotation.z = Math.PI / 2; w.position.set(0, RACK.thick / 2 - 0.03, z); obj.add(w);
  }
  const frame = new THREE.Mesh(new THREE.BoxGeometry(RACK.len, 0.04, RACK.halfZ * 2), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
  frame.position.y = RACK.thick / 2 - 0.04; obj.add(frame);
  for (const s of [-1, 1]) {
    const w = cyl(0.03, RACK.len, M.wire, 6); w.rotation.z = Math.PI / 2; w.position.set(0, RACK.thick / 2 + 0.24, s * (RACK.halfZ - 0.03)); obj.add(w);
    for (let x = -RACK.len / 2; x <= RACK.len / 2 + 1e-6; x += 0.6) {
      const p = cyl(wireR, 0.24, M.wire, 6); p.position.set(x, RACK.thick / 2 + 0.12, s * (RACK.halfZ - 0.03)); obj.add(p);
    }
  }
  world.addBody(body);
  link(body, obj);
  return { body, attachLocal: V(lay.x - cx, RACK.thick / 2, lay.z) };
}

function buildHook(lay) {
  // 原点＝台座の中心（アクリル板の上面）。柱が上へ伸び、上端が dir 側へアーチ状に曲がって
  // 先端が下に垂れる「？」形。アーチの外側に落ちたリングは外へ滑って傾き、
  // 先端の下からリングがくぐると、引き上げ時にアーチの内側に掛かる。
  const d = lay.dir, { stemTop, apexY, apexZ, endY, endZ, tipY, w } = HOOK;
  const body = new CANNON.Body({
    mass: 0.6, material: mat.hook, fixedRotation: true, position: V(lay.x, SHELF.topY, lay.z),
    collisionFilterGroup: GR.HOOK, collisionFilterMask: GR.SHELF | GR.RING | GR.HEAD,
    linearDamping: 0.2,
  });
  body.quaternion.copy(yawQ(eff.hookYaw));   // バーで設定した向き（縦軸まわり）
  const P = [V(0, 0.08, 0), V(0, stemTop, 0), V(0, apexY, d * apexZ), V(0, endY, d * endZ), V(0, tipY, d * endZ)];
  body.addShape(new CANNON.Box(V(0.2, 0.04, 0.2)), V(0, 0.04, 0));   // 台座
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1], dir = b.vsub(a), len = dir.length();
    dir.normalize();
    const q = new CANNON.Quaternion().setFromVectors(V(0, 0, 1), dir);
    body.addShape(new CANNON.Box(V(w, w, len / 2)), a.vadd(b).scale(0.5), q);
    body.addShape(new CANNON.Sphere(w * (i === P.length - 2 ? 1.3 : 1.15)), b);
  }
  body.updateMassProperties();

  const obj = new THREE.Group();
  const baseM = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 24), M.gold)); baseM.position.y = 0.04; obj.add(baseM);
  // 曲がったフックを TubeGeometry で
  const pts = [
    new THREE.Vector3(0, 0.08, 0),
    new THREE.Vector3(0, stemTop - 0.05, 0),
    new THREE.Vector3(0, apexY, d * apexZ),
    new THREE.Vector3(0, endY - 0.02, d * endZ),
    new THREE.Vector3(0, tipY, d * endZ),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  obj.add(shadowy(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, w, 10), M.gold)));
  const tipBall = shadowy(new THREE.Mesh(new THREE.SphereGeometry(w * 1.25, 12, 8), M.gold));
  tipBall.position.set(0, tipY, d * endZ); obj.add(tipBall);
  world.addBody(body);
  link(body, obj);
  return body;
}

// チェーンの見た目（毎フレーム両端を結び直す）
function makeChainMesh(n, material, r = 0.05) {
  const obj = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const l = shadowy(new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.32, 6, 12), material));
    l.rotation.y = i % 2 ? Math.PI / 2 : 0;
    obj.add(l);
  }
  scene.add(obj);
  return obj;
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function placeChainMesh(obj, a, b) {
  _a.set(a.x, a.y, a.z); _b.set(b.x, b.y, b.z);
  const len = _a.distanceTo(_b);
  obj.position.copy(_a).add(_b).multiplyScalar(0.5);
  if (len > 1e-4) obj.quaternion.setFromUnitVectors(_up, _d.copy(_a).sub(_b).normalize());
  const n = obj.children.length;
  obj.children.forEach((l, i) => { l.position.y = len * (-0.5 + (i + 0.5) / n); l.scale.set(1, Math.max(0.5, len / n / (l.geometry.parameters.radius * 2)), 1); });
}
const _p = new CANNON.Vec3();
function updateChainVisual() {
  if (!round) return;
  placeChainMesh(round.chain, round.hook.position, round.rack.pointToWorldFrame(round.attachLocal, _p));
  head.pointToWorldFrame(V(0, -HEAD_HY, 0), _p);
  placeChainMesh(armChain, _p, shackle.position);
}

// 網台の角度をフックの高さから決め、フックには台の重さ分の下向きの力をかける
function updateRack(dt) {
  const { rack, hook, lay } = round;
  // フックはチェーンが板の穴を通っているので水平には動かない
  hook.position.x = lay.x; hook.position.z = lay.z;
  hook.velocity.x = 0; hook.velocity.z = 0;
  const lever = lay.x - CHUTE_X;
  let rise = hook.position.y - SHELF.topY;
  const maxRise = lever * Math.sin(MAX_TILT);
  if (rise > maxRise) { hook.position.y = SHELF.topY + maxRise; hook.velocity.y = Math.min(0, hook.velocity.y); rise = maxRise; }
  const theta = Math.asin(Math.max(0, rise) / lever);
  const w = (theta - round.theta) / dt;
  round.theta = theta;
  // 台の重さ（＋景品の重さを少し）→ チェーンの張力としてフックを下に引く
  const comLever = RACK.len / 2;
  hook.force.y -= RACK_MASS * G * comLever / lever;
  const c = Math.cos(theta), s = Math.sin(theta);
  const rx = comLever * c, ry = comLever * s;
  rack.position.set(HINGE.x + rx, HINGE.y + ry, 0);
  rack.quaternion.setFromAxisAngle(Z_AXIS, theta);
  rack.velocity.set(-w * ry, w * rx, 0);
  rack.angularVelocity.set(0, 0, w);
  // 網台の上の景品は傾くと滑り落ちる（ソルバーの静止摩擦が強すぎるので斜面方向の力で補う）
  const p = round.prize;
  if (theta > 8 * DEG && p.position.x > CHUTE_X - 0.2 && p.position.y > RACK.topY - 0.5) {
    const f = p.mass * G * Math.sin(theta) * 0.7;
    p.force.x -= f * c; p.force.y -= f * s;
  }
}

// 景品: ころんとしたぬいぐるみマスコット（ねこ・くま・うさぎ・ひよこ）
const PLUSH_TYPES = [
  { kind: 'cat', body: 0xfff4ea, accent: 0xffc7a1, ribbon: 0xff7eb6 },
  { kind: 'bear', body: 0xe8c39e, accent: 0xfff0dc, ribbon: 0x7fc8ff },
  { kind: 'rabbit', body: 0xffffff, accent: 0xffd0e0, ribbon: 0xa98bff },
  { kind: 'chick', body: 0xffe27a, accent: 0xfff6c8, ribbon: 0xff8fa3 },
];
function buildPlush(t) {
  const g = new THREE.Group();
  const soft = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });
  const mBody = soft(t.body), mAccent = soft(t.accent), mRibbon = new THREE.MeshStandardMaterial({ color: t.ribbon, roughness: 0.5 });
  const mEye = new THREE.MeshStandardMaterial({ color: 0x2b2230, roughness: 0.3 });
  const mShine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mCheek = new THREE.MeshStandardMaterial({ color: 0xff9db8, roughness: 0.9, transparent: true, opacity: 0.85 });
  const ball = (r, m, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const b = shadowy(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), m));
    b.position.set(x, y, z); b.scale.set(sx, sy, sz); g.add(b); return b;
  };
  // 胴体・おなか・手足・しっぽ
  ball(0.34, mBody, 0, -0.3, 0, 1.05, 0.92, 0.9);
  ball(0.22, mAccent, 0, -0.32, 0.16, 1, 1, 0.6);
  for (const sx of [-1, 1]) {
    ball(0.1, mBody, sx * 0.3, -0.2, 0.12, 1, 1.2, 1);              // 手
    ball(0.11, mBody, sx * 0.16, -0.56, 0.22, 1.1, 0.7, 1.3);        // 足
    ball(0.055, mAccent, sx * 0.16, -0.55, 0.34, 1, 1, 0.5);         // 肉球
  }
  ball(t.kind === 'rabbit' ? 0.11 : 0.08, t.kind === 'rabbit' ? mAccent : mBody, 0, -0.42, -0.3);   // しっぽ
  // 大きな頭
  const hy = 0.36, hr = 0.4;
  ball(hr, mBody, 0, hy, 0, 1.12, 0.95, 1);
  // 耳
  if (t.kind === 'cat') {
    for (const sx of [-1, 1]) {
      const e = shadowy(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.22, 16), mBody));
      e.position.set(sx * 0.26, hy + 0.36, 0); e.rotation.z = -sx * 0.35; g.add(e);
      const ei = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.13, 12), mAccent);
      ei.position.set(sx * 0.255, hy + 0.34, 0.06); ei.rotation.z = -sx * 0.35; g.add(ei);
    }
  } else if (t.kind === 'bear') {
    for (const sx of [-1, 1]) { ball(0.12, mBody, sx * 0.3, hy + 0.3, 0); ball(0.07, mAccent, sx * 0.3, hy + 0.3, 0.07, 1, 1, 0.5); }
    ball(0.13, mAccent, 0, hy - 0.1, hr * 0.85, 1.2, 0.85, 0.6);     // マズル
  } else if (t.kind === 'rabbit') {
    for (const sx of [-1, 1]) {
      const e = shadowy(new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.36, 6, 14), mBody));
      e.position.set(sx * 0.15, hy + 0.5, -0.02); e.rotation.z = -sx * 0.18; g.add(e);
      const ei = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.28, 4, 10), mAccent);
      ei.position.set(sx * 0.15, hy + 0.5, 0.05); ei.rotation.z = -sx * 0.18; g.add(ei);
    }
  } else {   // ひよこ: 頭のぴょこ毛とくちばし
    for (const a of [-0.4, 0, 0.4]) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.14, 8), mBody);
      f.position.set(Math.sin(a) * 0.06, hy + 0.42, 0); f.rotation.z = a; g.add(f);
    }
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 12), new THREE.MeshStandardMaterial({ color: 0xffa040, roughness: 0.6 }));
    beak.rotation.x = Math.PI / 2; beak.position.set(0, hy - 0.08, hr * 0.98); g.add(beak);
  }
  // 顔: キラキラの目・ほっぺ・鼻
  for (const sx of [-1, 1]) {
    ball(0.062, mEye, sx * 0.15, hy + 0.02, hr * 0.9, 0.9, 1.15, 0.6);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), mShine);
    shine.position.set(sx * 0.15 + 0.02, hy + 0.06, hr * 0.94); g.add(shine);
    ball(0.06, mCheek, sx * 0.27, hy - 0.1, hr * 0.78, 1.2, 0.7, 0.4);
  }
  if (t.kind !== 'chick') ball(0.03, new THREE.MeshStandardMaterial({ color: 0xff7f9e }), 0, hy - 0.07, hr * (t.kind === 'bear' ? 1.04 : 0.96));
  // 首のリボン
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 12), mRibbon);
    r.rotation.z = sx * Math.PI / 2; r.position.set(sx * 0.08, hy - 0.36, 0.26); g.add(r);
  }
  ball(0.045, mRibbon, 0, hy - 0.36, 0.28);
  return g;
}

// 景品「おすがた」フィギュア
function buildPrize(prizeZ) {
  const body = new CANNON.Body({
    mass: 0.8, material: mat.prize,
    position: V(-1.3, RACK.topY + 0.62, prizeZ),
    collisionFilterGroup: GR.PRIZE, collisionFilterMask: GR.STATIC | GR.RACK | GR.PRIZE | GR.HEAD | GR.RING | GR.SHELF,
    angularDamping: 0.1,
  });
  body.addShape(new CANNON.Box(V(0.4, 0.06, 0.4)), V(0, -0.56, 0));
  body.addShape(new CANNON.Box(V(0.28, 0.42, 0.24)), V(0, -0.08, 0));
  body.addShape(new CANNON.Sphere(0.34), V(0, 0.62, 0));
  const obj = buildPlush(PLUSH_TYPES[Math.floor(Math.random() * PLUSH_TYPES.length)]);
  world.addBody(body);
  link(body, obj);
  return body;
}

// ---------------------------------------------------------------- アーム＋ぶら下がりリング
const carriage = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, position: V(HOME.x, CARRIAGE_Y, HOME.z) });
carriage.collisionFilterGroup = 0; carriage.collisionFilterMask = 0;
world.addBody(carriage);

// アーム本体はガントリーに固定（キネマティック）。揺れるのはチェーンの先のリングだけ
const head = new CANNON.Body({
  mass: 0, type: CANNON.Body.KINEMATIC, position: V(HOME.x, CARRIAGE_Y - L_HOME, HOME.z),
  collisionFilterGroup: GR.HEAD, collisionFilterMask: GR.STATIC | GR.SHELF | GR.HOOK | GR.PRIZE,
});
head.addShape(new CANNON.Box(V(0.42, HEAD_HY, 0.34)));
head.updateMassProperties();
world.addBody(head);
{
  const g = new THREE.Group();
  g.add(box(0.84, HEAD_HY * 2, 0.68, M.head));
  const cap = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.25, 20), M.pink)); cap.position.y = HEAD_HY + 0.12; g.add(cap);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff5fa8 })); lamp.position.set(0, 0, 0.35); g.add(lamp);
  // 飾りの閉じた爪
  for (const s of [-1, 1]) {
    const c = box(0.07, 0.5, 0.12, M.metal); c.position.set(s * 0.3, -HEAD_HY - 0.22, 0); c.rotation.z = s * 0.25; g.add(c);
  }
  link(head, g);
}

// チェーン: ヘッド → シャックル（リングの吊り金具）を「張ったときだけ効く」ロープで結ぶ。
// ゆるむとリングはアクリル板やフックの上で自由に倒れる。
const shackle = new CANNON.Body({ mass: 0.1, linearDamping: 0.02 });
shackle.addShape(new CANNON.Sphere(0.06));
// 付け根の金具もフックと板には当たる（フックを突き抜けないように）
shackle.collisionFilterGroup = GR.RING; shackle.collisionFilterMask = GR.HOOK | GR.SHELF;
shackle.material = mat.ring;
shackle.updateMassProperties();
world.addBody(shackle);
const rope = new CANNON.DistanceConstraint(head, shackle, chainDrop());
rope.distanceEquation.maxForce = 0;          // 押す力は出さない（ロープ）
rope.distanceEquation.minForce = -1e6;
world.addConstraint(rope);
const armChain = makeChainMesh(24, M.metal, 0.055);
let ring = null, ringR = 0, ringJoint = null;

function buildRing() {
  shackle.collisionFilterMask = GR.HOOK | GR.SHELF;
  if (ring) { world.removeConstraint(ringJoint); unlink(ring); }
  const R = RING_SIZES[settings.size].R;
  ringR = R;
  const body = new CANNON.Body({
    mass: 0.6, material: mat.ring,
    collisionFilterGroup: GR.RING, collisionFilterMask: GR.STATIC | GR.SHELF | GR.HOOK | GR.PRIZE | GR.RACK,
  });
  // x-y 平面の輪（正面から丸く見える）。断面が丸くなるよう小球を円周に並べて近似。
  const N = Math.ceil((2 * Math.PI * R) / (TUBE * 1.5));
  const ball = new CANNON.Sphere(TUBE);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    body.addShape(ball, V(R * Math.cos(a), R * Math.sin(a), 0));
  }
  body.updateMassProperties();
  world.addBody(body);
  const obj = shadowy(new THREE.Mesh(new THREE.TorusGeometry(R, TUBE, 14, 56), M.ring));
  link(body, obj);
  ring = body;
  ringJoint = new CANNON.PointToPointConstraint(shackle, V(0, 0, 0), ring, V(0, R, 0));
  world.addConstraint(ringJoint);
}

// アームを真下にぶら下がった状態で置き直す
function placeArm(x, z, L) {
  carriage.position.set(x, CARRIAGE_Y, z); carriage.velocity.setZero();
  head.position.set(x, CARRIAGE_Y - L, z); head.velocity.setZero();
  rope.distance = chainDrop();
  const y = head.position.y - rope.distance;
  shackle.position.set(x, y, z); shackle.velocity.setZero();
  ring.position.set(x, y - ringR, z); ring.quaternion.copy(yawQ(eff.ringYaw));
  ring.velocity.setZero(); ring.angularVelocity.setZero();
}

// ワイヤー表示
const wireGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
scene.add(new THREE.Line(wireGeo, new THREE.LineBasicMaterial({ color: 0x888888 })));
const carriageMesh = box(0.8, 0.3, 0.8, M.metal); scene.add(carriageMesh);
const crossRail = box(0.14, 0.12, RANGE.zMax - RANGE.zMin + 0.8, M.metal); scene.add(crossRail);

// ---------------------------------------------------------------- 難易度「高」
// 難易度はリングサイズと独立。大=高（ランダム向き・速い・揺れ最大）、中=設定値、小=遅い・揺れ控えめ
const eff = { hookYaw: 0, ringYaw: 0 };
const isHighDifficulty = () => settings.difficulty === 'high';
const isEasyDifficulty = () => settings.difficulty === 'easy';
const swingResponse = value => {
  const v = Math.max(0, Math.min(1, value));
  return 1 - (1 - v) ** 2;
};
const effSwing = () => isHighDifficulty() ? 1 : swingResponse(isEasyDifficulty() ? Math.min(settings.swing, 0.35) : settings.swing);
const effTwist = () => isHighDifficulty() ? 1 : isEasyDifficulty() ? 0 : settings.twist;
function rollAngles() {
  eff.hookYaw = isHighDifficulty() ? Math.round(Math.random() * 72) * 5 - 180 : settings.hookYaw;
  eff.ringYaw = isHighDifficulty() ? Math.round(Math.random() * 72) * 5 - 180 : settings.ringYaw;
}

// ---------------------------------------------------------------- 落下予測地点（赤い印）
// 今リングを真下に下ろしたら、リングの一番下が板（または床）に着く位置
const marker = new THREE.Group();
{
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0.9, depthWrite: false }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.21, 32), new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0.55, depthWrite: false }));
  for (const m of [dot, halo]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 5; marker.add(m); }
  scene.add(marker);
}
function updateMarker() {
  marker.visible = !!(settings.marker && !isHighDifficulty() && ring && ['idle', 'fixed1', 'fixed2', 'free', 'wait', 'descend'].includes(game.state));
  if (!marker.visible) return;
  const p = ringLowest().p;
  const onShelf = p.x > SHELF.xMin && p.x < SHELF.xMax && p.z > SHELF.zMin && p.z < SHELF.zMax;
  marker.position.set(p.x, (onShelf ? SHELF.topY : 0) + 0.012, p.z);
}

// ---------------------------------------------------------------- ゲーム状態
const game = {
  state: 'idle', t: 0, L: L_HOME,
  vel: { x: 0, z: 0 }, moved: false, timer: FREE_TIME, won: false, finished: false, Ltarget: 3, maxTilt: 0, twistDir: 1,
};
const input = { b1: false, b2: false, stick: { x: 0, z: 0 }, keys: new Set(), drop: false, start: false };

function setState(s) { game.state = s; game.t = 0; game.moved = false; updateUI(); }

function resetRound({ keepLayout = false } = {}) {
  rollAngles();
  if (round) {
    for (const b of [round.rack, round.hook, round.prize]) unlink(b);
    scene.remove(round.chain);
  }
  const lay = keepLayout && round ? { ...round.lay } : randomLayout();
  lay.prizeZ ??= settings.random ? (Math.random() * 2 - 1) * 0.3 : 0;
  const rack = buildRack(lay);
  const hook = buildHook(lay);
  const prize = buildPrize(lay.prizeZ);
  round = { rack: rack.body, attachLocal: rack.attachLocal, hook, chain: makeChainMesh(16, M.gold), prize, lay, theta: 0 };

  buildRing();
  // 下降停止位置（台ごとの固定設定）: アーム（チェーンの支点）が板から armStop() の高さまで下りる。
  // チェーンの長さに関係なく支点は同じ所まで下りるので、長いチェーンほどリングは板の上で大きく倒れて滑る
  const headY = SHELF.topY + armStop();
  game.Ltarget = CARRIAGE_Y - headY;
  game.L = L_HOME;
  placeArm(HOME.x, HOME.z, L_HOME);
  game.vel = { x: 0, z: 0 }; game.timer = FREE_TIME; game.won = false; game.finished = false; game.maxTilt = 0;
  game.restYaw = eff.ringYaw * DEG; game.twistDir = Math.random() < 0.5 ? 1 : -1;
  applyPhysicsSettings();
  hideBanner();
  setState('idle');
}

function applyPhysicsSettings() {
  // 向きのバーは待機中ならその場で反映
  if (round && game.state === 'idle') {
    rollAngles();
    round.hook.quaternion.copy(yawQ(eff.hookYaw));
    game.restYaw = eff.ringYaw * DEG;
    placeArm(carriage.position.x, carriage.position.z, game.L);
  }
  applyRingDamping();
}

function applyRingDamping() {
  if (!ring) return;
  const swing = effSwing();
  const liftDamping = ['lift', 'hold'].includes(game.state);
  // 下降中は設定に応じて揺らす。引き上げ中は、板の上で傾いていたリングが付け根の真下へ戻るときの
  // 振り子運動を、チェーンのコマ同士の摩擦で吸収するイメージで強めに減衰させる（動画のように静かに上がる）
  const early = liftDamping && game.state === 'lift' && game.t < 1.2;
  ring.angularDamping = liftDamping ? (early ? 0.9 : 0.6) : 0.3 - 0.29 * swing;
  ring.linearDamping = liftDamping ? (early ? 0.6 : 0.35) : 0.25 - 0.245 * swing;
  shackle.linearDamping = liftDamping ? 0.4 : 0.08 - 0.078 * swing;
}

const rackTilt = () => round ? 2 * Math.atan2(round.rack.quaternion.z, round.rack.quaternion.w) * 180 / Math.PI : 0;

// リングの最下点（傾いていても輪の一番低いところ）
function ringLowest() {
  const n = ring.quaternion.vmult(V(0, 0, 1));
  const down = V(n.x * n.y, -1 + n.y * n.y, n.z * n.y);   // 下向きベクトルを輪の面へ射影
  if (down.length() < 1e-3) down.set(0, -1, 0);
  down.normalize();
  return { p: ring.position.vadd(down.scale(ringR)), n };
}
// ---------------------------------------------------------------- 床の摩擦（自前のクーロン摩擦）
// 前のステップで解いた接触の力（multiplier = 垂直抗力）を使い、リングの接触点の滑り速度に逆らう力をかける。
// 速度が小さければ静止摩擦で止め（最大 μs·N）、滑っていれば動摩擦 μk·N。合力を接触点の重心にかけるので
// 先端側だけが滑る・倒れ込むといった回転も自然に出る
function applyRingFloorFriction(dt) {
  if (!ring) return;
  let N = 0;
  const pc = V(0, 0, 0);
  for (const c of world.contacts) {
    let r;
    if (c.bi === ring && c.bj.material === mat.shelf) r = c.ri;
    else if (c.bj === ring && c.bi.material === mat.shelf) r = c.rj;
    else continue;
    const f = Math.abs(c.multiplier);
    if (!(f > 0)) continue;
    N += f;
    pc.x += r.x * f; pc.y += r.y * f; pc.z += r.z * f;
  }
  if (N <= 1e-6) return;
  pc.scale(1 / N, pc);   // リング中心からの接触点（力の重み付き平均）
  // 接触点の速度（水平成分＝板に沿った滑り）
  const vp = ring.velocity.vadd(ring.angularVelocity.cross(pc));
  const vt = V(vp.x, 0, vp.z), sp = vt.length();
  if (sp < 1e-6) return;
  const muK = settings.floorMuK, muS = floorMuS();
  // 接触点での実効質量（回転しやすさを含む）。これを超える力をかけると逆向きに弾いてしまう
  const t = V(vt.x / sp, 0, vt.z / sp);
  const rxt = pc.cross(t);
  const k = ring.invMass + rxt.dot(ring.invInertiaWorld.vmult(rxt));
  const stopF = sp / dt / k;   // このステップで滑りをちょうど止める力
  // 静止摩擦: 遅ければ止め切る（上限 μs·N）。滑っていれば動摩擦 μk·N（止め切る力を超えない）
  const F = sp < FLOOR_MU.stickSpeed ? Math.min(stopF, muS * N) : Math.min(stopF, muK * N);
  if (F <= 0) return;
  const fx = -vt.x / sp * F, fz = -vt.z / sp * F;
  ring.applyForce(V(fx, 0, fz), pc);   // cannon-es の applyForce は重心からの相対位置
}

// ---------------------------------------------------------------- 制御（物理 1 ステップごと）
function control(dt) {
  game.t += dt;
  let want = { x: 0, z: 0 };
  const cx = carriage.position.x, cz = carriage.position.z;
  const drop = input.drop; input.drop = false;
  const start = input.start; input.start = false;
  game.maxTilt = Math.max(game.maxTilt, rackTilt());

  switch (game.state) {
    case 'idle':
      if (settings.mode === 'fixed' && input.b1) setState('fixed1');
      if (settings.mode === 'free' && (start || drop || Math.hypot(input.stick.x, input.stick.z) > 0.2)) setState('free');
      break;
    case 'fixed1':
      if (input.b1) { want.x = 1; game.moved = true; }
      if (game.moved && (!input.b1 || cx >= RANGE.xMax - 1e-3)) setState('fixed2');
      break;
    case 'fixed2':
      if (input.b2) { want.z = -1; game.moved = true; }
      if (game.moved && (!input.b2 || cz <= RANGE.zMin + 1e-3)) setState('wait');
      break;
    case 'free':
      want = { ...input.stick };
      game.timer -= dt;
      if (drop || game.timer <= 0) { game.timer = Math.max(0, game.timer); setState('wait'); }
      break;
    case 'wait':      // 移動停止 → 少し間をおいて下降開始（この間もリングは揺れている）
      if (game.t > 0.5) setState('descend');
      break;
    case 'descend': {
      game.L = Math.min(game.Ltarget, game.L + DESCEND_SPEED * dt);
      if (game.L >= game.Ltarget || (settings.mode === 'free' && drop && game.t > 0.1)) setState('bottom');
      break;
    }
    case 'bottom':    // 下降停止 → 少し間をおいてから上昇
      if (game.t > BOTTOM_HOLD) {
        setState('lift');
      }
      break;
    case 'lift':
      // 引き上げはゆっくり動き出す（チェーンが一気に張ってリングが跳ねないように）
      game.L = Math.max(L_HOME, game.L - LIFT_SPEED * Math.min(1, 0.25 + game.t / 0.5) * dt);
      // 網台が上限まで上がったらそこで上昇停止（チェーンが張ってアームが止まる）
      if (game.L <= L_HOME || round.theta >= MAX_TILT - 1e-3) setState('hold');
      break;
    case 'hold':
      if (game.t > 1.8) setState('return');   // リングが外れて網台が戻る
      break;
    case 'return': {
      const dx = HOME.x - cx, dz = HOME.z - cz;
      want.x = Math.sign(dx) * Math.min(1, Math.abs(dx) * 4);
      want.z = Math.sign(dz) * Math.min(1, Math.abs(dz) * 4);
      if (Math.abs(dx) < 0.02 && Math.abs(dz) < 0.02 && Math.hypot(game.vel.x, game.vel.z) < 0.1) setState('result');
      break;
    }
    case 'result':
      if (!game.finished) { game.finished = true; finishRound(); }
      // 結果表示中でも①／START／スティックですぐ次のプレイへ
      if (game.t > 0.3 && (input.b1 || start || drop || Math.hypot(input.stick.x, input.stick.z) > 0.2)) { resetRound(); break; }
      if (game.t > 2.4) resetRound();
      break;
  }

  applyRingDamping();
  applyRingFloorFriction(dt);

  // キャリッジ（ガントリー）の移動。急停止すると吊られたアームとリングが振り子のように揺れる
  for (const k of ['x', 'z']) {
    const targetSpeed = isHighDifficulty() ? 1 : isEasyDifficulty() ? 0 : settings.speed;
    const target = (want[k] || 0) * SPEEDS[targetSpeed];
    const dv = target - game.vel[k];
    game.vel[k] += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, dv));
  }
  let vx = game.vel.x, vz = game.vel.z;
  if (cx + vx * dt > RANGE.xMax) { vx = (RANGE.xMax - cx) / dt; game.vel.x = 0; }
  if (cx + vx * dt < RANGE.xMin) { vx = (RANGE.xMin - cx) / dt; game.vel.x = 0; }
  if (cz + vz * dt > RANGE.zMax) { vz = (RANGE.zMax - cz) / dt; game.vel.z = 0; }
  if (cz + vz * dt < RANGE.zMin) { vz = (RANGE.zMin - cz) / dt; game.vel.z = 0; }
  carriage.velocity.set(vx, 0, vz);
  // ヘッドはキャリッジの真下、ワイヤー長 L の位置へ（速度で動かして接触も正しく）
  const ty = CARRIAGE_Y - game.L;
  head.velocity.set(vx, (ty - head.position.y) / dt, vz);
  head.position.x = cx; head.position.z = cz;
  updateRack(dt);
  // 下ろしてチェーンがたるんだら、リングの付け根はアームの真下（落ちた位置）に留まる
  // 引き上げの初め（リングが板から離れて少しの間）も、ゆっくり巻き上げるチェーンは真下に垂れたまま。
  // 付け根が振り子のように振られないよう、アームの真下へ寄せ続ける
  const liftPin = game.state === 'lift' && (game.t < 0.8 || ringLowest().p.y - SHELF.topY < 0.6);
  if ((['descend', 'bottom'].includes(game.state) && head.position.distanceTo(shackle.position) < rope.distance - 0.03) || liftPin) {
    // 位置を直接動かすとフックをすり抜けるので、速度で落ちた位置へ寄せる（フックに当たればそこで止まる）
    const k = 8;
    shackle.velocity.x = (head.position.x - shackle.position.x) * k;
    shackle.velocity.z = (head.position.z - shackle.position.z) * k;
  }

  // 実機の微振動。チェーンがたるんで縁で立ったリングは、わずかな揺れでどちらかへ倒れる
  if (ring) {
    const vibration = NOISE * effSwing();
    ring.angularVelocity.x += (Math.random() - 0.5) * vibration;
    ring.angularVelocity.z += (Math.random() - 0.5) * vibration;
    // 移動中の揺れでチェーンがねじれ、リングの向きが少しずつ回ってしまう（オプション）
    const sp = Math.hypot(game.vel.x, game.vel.z);
    if (effTwist() > 0) {
      if (sp < 0.05 && Math.random() < dt * 0.5) game.twistDir = Math.random() < 0.5 ? 1 : -1;
      game.restYaw += effTwist() * dt * sp * (0.18 * game.twistDir + (Math.random() - 0.5) * 0.4);
    }
    // チェーンのねじれ剛性: 吊られている間はリングの向きを restYaw に戻そうとする
    const up = ring.quaternion.vmult(V(0, 1, 0));
    if (up.y > 0.7) {
      const f = ring.quaternion.vmult(V(0, 0, 1));
      let err = Math.atan2(f.x, f.z) - game.restYaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      ring.angularVelocity.y += (-40 * err - 4 * ring.angularVelocity.y) * dt;
    }
  }

  // 獲得判定
  const p = round?.prize;
  if (p && !game.won && p.position.y < 0.9 && p.position.x < CHUTE_X) {
    game.won = true; showBanner('GET!!', 'win');
  }
}

function finishRound() {
  const s = loadStats();
  s.tries++;
  if (game.won) { s.wins++; s.streak++; s.best = Math.max(s.best, s.streak); }
  else { s.streak = 0; showBanner(game.maxTilt > 3 ? '掛かったけど落ちず…' : 'ざんねん…', 'lose'); }
  saveStats(s);
  renderStats();
}

// ---------------------------------------------------------------- UI
const $ = id => document.getElementById(id);
const ui = {
  status: $('status'), timer: $('timer'), banner: $('banner'), stats: $('stats'), help: $('help'),
  stickArea: $('stickArea'), btn1: $('btn1'), btn2: $('btn2'), btnStart: $('btnStart'), btnDrop: $('btnDrop'),
};

function showBanner(text, cls) { ui.banner.textContent = text; ui.banner.className = `show ${cls}`; }
function hideBanner() { ui.banner.className = ''; }

const STATUS = {
  idle: () => settings.mode === 'fixed' ? '①ボタンを押している間 → 右へ移動' : 'STARTまたはスティックで開始（制限時間 15秒）',
  fixed1: () => '①を離すと停止',
  fixed2: () => '②ボタンを押している間 ↑ 奥へ移動',
  free: () => 'スティックで移動 → 降下ボタン',
  wait: () => 'アーム停止…',
  descend: () => settings.mode === 'free' ? '降下中（降下ボタンで下降停止）' : '降下中…',
  bottom: () => '下降停止', lift: () => '上昇！', hold: () => '…',
  return: () => '戻り中', result: () => '',
};
function updateUI() {
  ui.status.textContent = STATUS[game.state]?.() ?? '';
  const fixed = settings.mode === 'fixed';
  ui.btn1.classList.toggle('hidden', !fixed);
  ui.btn2.classList.toggle('hidden', !fixed);
  ui.stickArea.style.display = fixed ? 'none' : '';
  ui.btnStart.classList.toggle('hidden', fixed);
  ui.btnDrop.classList.toggle('hidden', fixed);
  ui.btn1.disabled = !['idle', 'fixed1'].includes(game.state);
  ui.btn2.disabled = game.state !== 'fixed2';
  ui.btnStart.disabled = game.state !== 'idle';
  ui.btnDrop.disabled = !['free', 'descend'].includes(game.state);
  $('btnReset').textContent = game.state === 'result' ? '次へ' : 'リセット';
  ui.help.innerHTML = (fixed
    ? '<b>キーボード</b><br>① : → / D / 1 （押し続ける）<br>② : ↑ / W / 2 （押し続ける）'
    : '<b>キーボード</b><br>移動 : 矢印 / WASD（↑が奥）<br>開始 : Enter　降下 / 下降停止 : Space')
    + '<br>視点切替 : V　やり直し : R<br><br><b>コツ</b><br>フックの<b>開いている側</b>にリングを下ろす。アームは止まってもリングは振れ続けるので、<b>フックの穴に向かって振れながら着地する</b>タイミングで離すと掛かりやすい。横からの小窓で奥行きと振れを確認。';
}
function renderStats() {
  const s = loadStats();
  const rate = s.tries ? Math.round((s.wins / s.tries) * 100) : 0;
  ui.stats.innerHTML =
    `<div>${settings.mode === 'fixed' ? '固定ボタン' : 'フリースティック'} / 難易度<b>${difficultyLabel()}</b> / リング<b>${RING_SIZES[settings.size].label}</b></div>` +
    `<div class="dim">物理版</div>` +
    `<div>挑戦 <b>${s.tries}</b>　成功 <b>${s.wins}</b>　成功率 <b>${rate}%</b></div>` +
    `<div>連続 <b>${s.streak}</b>　最高連続 <b>${s.best}</b></div>` +
    `<div class="dim">視点: ${VIEWS[viewIdx].name}</div>`;
}

// 設定パネル
// リングの大きさに合わせてチェーンの調整範囲を変え、範囲外なら収める
function updateChainRange() {
  const ch = $('chain'), min = chainMin(settings.size);
  ch.min = min; ch.max = CHAIN_MAX;
  settings.chain = Math.min(CHAIN_MAX, Math.max(min, settings.chain));
  ch.value = settings.chain;
  $('chainVal').textContent = `${Math.round(settings.chain * 10)} cm`;
}
function bindSettings() {
  $('settingsToggle').onclick = () => $('settings').classList.toggle('collapsed');
  if (innerWidth < 700) $('settings').classList.add('collapsed');
  const mode = $('mode'); mode.value = settings.mode;
  mode.onchange = () => { setMode(mode.value); mode.blur(); };
  for (const r of document.querySelectorAll('input[name=size]')) {
    r.checked = r.value === settings.size;
    r.onchange = () => {
      setRingSize(r.value); r.blur();
    };
  }
  const slider = (id, key, fmt) => {
    const el = $(id), out = $(id + 'Val');
    el.value = settings[key]; out.textContent = fmt(settings[key]);
    el.oninput = () => { settings[key] = parseFloat(el.value); out.textContent = fmt(settings[key]); saveSettings(); applyPhysicsSettings(); };
    el.onchange = () => el.blur();
  };
  slider('speed', 'speed', v => ['小（遅い）', '中', '大（速い）'][v * 2]);
  slider('swing', 'swing', v => ['ほぼ無し', '小', '中', '大', '最大'][Math.round(v * 4)]);
  slider('floorMuK', 'floorMuK', v => `μ=${v.toFixed(2)}${v <= 0.05 ? '（よく滑る）' : v >= 0.4 ? '（滑らない）' : ''}`);
  const ch = $('chain'), chOut = $('chainVal');
  updateChainRange();
  ch.oninput = () => { settings.chain = parseFloat(ch.value); chOut.textContent = `${Math.round(settings.chain * 10)} cm`; saveSettings(); };
  ch.onchange = () => { ch.blur(); resetRound(); };
  const angleFmt = v => v === 0 ? '0°（正面向き）' : `${Math.abs(v)}° ${v > 0 ? '⟲ 反時計回り' : '⟳ 時計回り'}`;   // 上から見て
  slider('hookYaw', 'hookYaw', angleFmt);
  slider('ringYaw', 'ringYaw', angleFmt);
  slider('twist', 'twist', v => v === 0 ? 'なし' : ['', '少し', '中', '大', '最大'][Math.ceil(v * 4)]);
  const hd = $('hookDir'); hd.value = settings.hookDir;
  hd.onchange = () => { settings.hookDir = hd.value; saveSettings(); resetRound(); hd.blur(); };
  const rnd = $('random'); rnd.checked = settings.random;
  rnd.onchange = () => { settings.random = rnd.checked; saveSettings(); resetRound(); rnd.blur(); };
  const pip = $('pip'); pip.checked = settings.pip; document.body.classList.toggle('pip', settings.pip);
  pip.onchange = () => { settings.pip = pip.checked; saveSettings(); document.body.classList.toggle('pip', settings.pip); resize(); pip.blur(); };
  for (const key of ['reflect', 'grid', 'marker']) {
    const el = $(key); el.checked = settings[key];
    el.onchange = () => { settings[key] = el.checked; saveSettings(); applyShelfOptions(); el.blur(); };
  }
  applyShelfOptions();
  $('resetStats').onclick = () => { localStorage.removeItem(statKey()); renderStats(); };
}

// 入力：ボタン（押しっぱなし対応）
function holdButton(el) {
  const on = e => { e.preventDefault(); if (!el.disabled) el.classList.add('pressed'); };
  const off = () => el.classList.remove('pressed');
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('pointercancel', off);
}
holdButton(ui.btn1);
holdButton(ui.btn2);
ui.btnStart.addEventListener('pointerdown', e => { e.preventDefault(); input.start = true; });
ui.btnDrop.addEventListener('pointerdown', e => { e.preventDefault(); input.drop = true; });
// リセットは現在の配置を保ってやり直す。「次へ」は新しい配置（記録には数えない）
// 難易度ボタン: 大（高）→ 中（設定値）→ 小（易）を切り替え
const DIFFICULTIES = [
  { value: 'high', label: '大' },
  { value: 'normal', label: '中' },
  { value: 'easy', label: '小' },
];
const difficultyLabel = () => DIFFICULTIES.find(level => level.value === settings.difficulty)?.label ?? '中';
function refreshDifficultyButton() {
  $('btnLevel').innerHTML = `難易度<br><b>${difficultyLabel()}</b>`;
  $('btnLevel').classList.toggle('hard', isHighDifficulty());
}
function setDifficulty(level) {
  settings.difficulty = level;
  saveSettings(); renderStats(); resetRound(); refreshDifficultyButton();
}
function setRingSize(size) {
  settings.size = size;
  for (const r of document.querySelectorAll('input[name=size]')) r.checked = r.value === size;
  updateChainRange(); saveSettings(); renderStats(); resetRound();
}
$('btnLevel').addEventListener('click', e => {
  e.currentTarget.blur();
  const currentIndex = DIFFICULTIES.findIndex(level => level.value === settings.difficulty);
  setDifficulty(DIFFICULTIES[(currentIndex + 1) % DIFFICULTIES.length].value);
});
refreshDifficultyButton();
// 操作モード切替ボタン（左下）: 押すと固定ボタン ⇔ フリースティックを切り替えてリセット
function setMode(m) {
  settings.mode = m; $('mode').value = m;
  $('btnMode').innerHTML = m === 'fixed' ? 'ボタン<br>操作' : 'フリー<br>操作';
  saveSettings(); renderStats(); resetRound();
}
$('btnMode').addEventListener('click', e => { e.currentTarget.blur(); setMode(settings.mode === 'fixed' ? 'free' : 'fixed'); });
$('btnMode').innerHTML = settings.mode === 'fixed' ? 'ボタン<br>操作' : 'フリー<br>操作';
$('btnReset').addEventListener('click', e => {
  e.currentTarget.blur();
  resetRound({ keepLayout: game.state !== 'result' });
});
$('btnView').addEventListener('click', () => { viewIdx = (viewIdx + 1) % VIEWS.length; applyView(); renderStats(); });

// バーチャルスティック
const stickEl = $('stick'), knob = $('knob');
let stickPointer = null, stickVec = { x: 0, z: 0 };
function stickMove(e) {
  const r = stickEl.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2, max = r.width / 2 - 20;
  let dx = e.clientX - cx, dy = e.clientY - cy;
  const d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  stickVec = { x: dx / max, z: dy / max };   // 画面上方向 = 奥 (-z)
}
stickEl.addEventListener('pointerdown', e => { stickPointer = e.pointerId; stickEl.setPointerCapture(e.pointerId); stickMove(e); });
stickEl.addEventListener('pointermove', e => { if (e.pointerId === stickPointer) stickMove(e); });
const stickEnd = e => { if (e.pointerId === stickPointer) { stickPointer = null; stickVec = { x: 0, z: 0 }; knob.style.transform = ''; } };
stickEl.addEventListener('pointerup', stickEnd);
stickEl.addEventListener('pointercancel', stickEnd);

// キーボード
const KEYMAP = { arrowleft: 'l', a: 'l', arrowright: 'r', d: 'r', arrowup: 'u', w: 'u', arrowdown: 'dn', s: 'dn', 1: 'r', 2: 'u' };
addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT') return;
  const k = KEYMAP[e.key.toLowerCase()];
  if (k) { input.keys.add(k); e.preventDefault(); }
  if (e.repeat) return;
  if (e.key === ' ') { input.drop = true; e.preventDefault(); }
  if (e.key === 'Enter') input.start = true;
  if (e.key === 'v' || e.key === 'V') { viewIdx = (viewIdx + 1) % VIEWS.length; applyView(); renderStats(); }
  if (e.key === 'r' || e.key === 'R') resetRound({ keepLayout: true });
});
addEventListener('keyup', e => { const k = KEYMAP[e.key.toLowerCase()]; if (k) input.keys.delete(k); });
addEventListener('blur', () => input.keys.clear());

function pollInput() {
  const K = input.keys;
  input.b1 = ui.btn1.classList.contains('pressed') || K.has('r');
  input.b2 = ui.btn2.classList.contains('pressed') || K.has('u');
  let x = (K.has('r') ? 1 : 0) - (K.has('l') ? 1 : 0);
  let z = (K.has('dn') ? 1 : 0) - (K.has('u') ? 1 : 0);
  if (x || z) { const n = Math.hypot(x, z); x /= n; z /= n; } else { x = stickVec.x; z = stickVec.z; }
  input.stick = { x, z };
  ui.btn1.disabled = !['idle', 'fixed1'].includes(game.state);
  ui.btn2.disabled = game.state !== 'fixed2';
}

// ---------------------------------------------------------------- ループ
// 画面レイアウト: スマホ縦持ちで小窓を出すときは、メイン画面を小窓の上に詰めて重ならないようにする
//   下から [操作ボタン 150px] [成績 | 横からの小窓] [メイン画面]
const CTRL_H = 150;
let viewRects = null;
function computeLayout() {
  const W = innerWidth, H = innerHeight, mobile = W <= 700;
  if (mobile && settings.pip) {
    // スマホ: メイン画面と横からの別視点を左右に並べ、操作ボタンの上に置く（重ならない）
    const pw = Math.round(W * 0.38);
    viewRects = { main: { x: 0, y: CTRL_H, w: W - pw, h: H - CTRL_H }, pip: { x: W - pw, y: CTRL_H, w: pw, h: H - CTRL_H - 60 } };
  } else {
    const pw = Math.round(Math.min(W * 0.32, 300)), ph = Math.round(pw * 0.75);
    viewRects = { main: { x: 0, y: 0, w: W, h: H }, pip: { x: W - pw - 10, y: H - ph - 10, w: pw, h: ph } };
  }
}
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  computeLayout();
  camMain.aspect = viewRects.main.w / viewRects.main.h;
  camPip.aspect = viewRects.pip.w / viewRects.pip.h; camPip.updateProjectionMatrix();
  camMain.fov = camMain.aspect < 1.3 ? 48 : 42;   // 縦長・正方形に近い画面は少し広角に（足りない分は placeCamera で引く）
  camMain.updateProjectionMatrix();
  applyView();
}
addEventListener('resize', resize);

let last = performance.now(), acc = 0, lastState = null;
function stepSim(dt) {
  acc += dt;
  while (acc >= DT) { control(DT); world.step(DT); acc -= DT; }
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  pollInput();
  if (!game.paused) stepSim(dt);
  if (game.state !== lastState) { lastState = game.state; updateUI(); }

  for (const { body, obj } of synced) { obj.position.copy(body.position); obj.quaternion.copy(body.quaternion); }
  updateChainVisual();
  updateMarker();
  carriageMesh.position.set(carriage.position.x, CARRIAGE_Y + 0.15, carriage.position.z);
  crossRail.position.set(carriage.position.x, CARRIAGE_Y + 0.35, (RANGE.zMin + RANGE.zMax) / 2);
  const pos = wireGeo.attributes.position;
  pos.setXYZ(0, carriage.position.x, CARRIAGE_Y, carriage.position.z);
  pos.setXYZ(1, head.position.x, head.position.y + 0.4, head.position.z);
  pos.needsUpdate = true;
  ui.timer.textContent = settings.mode === 'free' && ['idle', 'free'].includes(game.state) ? Math.ceil(game.timer) : '';

  const { main: m, pip: p } = viewRects;
  renderer.setScissorTest(false);
  renderer.setViewport(m.x, m.y, m.w, m.h);
  renderer.render(scene, camMain);
  if (settings.pip) {
    const px = p.x, py = p.y, pw = p.w, ph = p.h;
    camPip.aspect = pw / ph; camPip.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(px, py, pw, ph); renderer.setViewport(px, py, pw, ph);
    renderer.render(scene, camPip);
    renderer.setScissorTest(false);
  }
  requestAnimationFrame(frame);
}

bindSettings();
applyView();
resize();
resetRound();
renderStats();
requestAnimationFrame(frame);

// デバッグ用（ブラウザのコンソールから物理を早送りして検証できる）
window.__ufo = { camMain, input, setNoise: v => (NOISE = v), game, world, head, carriage, settings, resetRound, rackTilt, placeArm, stepSim, get round() { return round; }, get ring() { return ring; } };
