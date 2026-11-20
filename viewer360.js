// Vista 360° del carro con sus detalles (golpes, rayones) marcados.
// Prototipo: el carro es un modelo 3D ilustrativo según su tipo y color, y los detalles son SIMULADOS
// a partir de la inspección (año y kilometraje). En producción se reemplaza por fotos 360° reales del
// alistamiento, con los mismos marcadores.
// three.js se carga solo cuando el cliente abre el visor (assets/vendor/three, licencia MIT).

let THREE = null;
const loadThree = async () => (THREE ||= await import("/assets/vendor/three/three.module.min.js"));

// ---------- Detalles simulados (deterministas por carro) ----------
function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export const ZONES = {
  puerta_del_izq: "Puerta delantera izquierda", puerta_tras_izq: "Puerta trasera izquierda", puerta_del_der: "Puerta delantera derecha", puerta_tras_der: "Puerta trasera derecha",
  guardachoque_del: "Guardachoque delantero", guardachoque_tras: "Guardachoque trasero", capo: "Capó", techo: "Techo",
  guardafango_del_der: "Guardafango delantero derecho", guardafango_tras_izq: "Guardafango trasero izquierdo", aro_del_izq: "Aro delantero izquierdo", aro_tras_der: "Aro trasero derecho", parabrisas: "Parabrisas"
};
const TYPES = {
  rayon: { label: "Rayón superficial", zones: ["puerta_del_izq", "puerta_tras_izq", "puerta_del_der", "puerta_tras_der", "guardachoque_tras", "guardachoque_del", "guardafango_tras_izq"] },
  golpe: { label: "Golpe pequeño (abolladura)", zones: ["puerta_del_der", "puerta_tras_izq", "guardafango_del_der", "guardachoque_tras", "puerta_del_izq"] },
  pintura: { label: "Desgaste de pintura", zones: ["capo", "techo", "guardachoque_del"] },
  aro: { label: "Rayón en el aro", zones: ["aro_del_izq", "aro_tras_der"] },
  piquete: { label: "Piquete en el parabrisas", zones: ["parabrisas"] }
};
export function simulatedFindings(car, now = new Date()) {
  if (car.condition === "nuevos" || Number(car.mileage) < 1000) return [];
  const age = Math.max(0, now.getFullYear() - Number(car.year)), r = rng(Number(car.id) * 97 + Number(car.year));
  const count = Math.max(1, Math.min(5, Math.round(age * 0.35 + Number(car.mileage) / 70000 + r() * 1.2)));
  const pool = ["rayon", "rayon", "golpe", "pintura", "aro", "piquete", "rayon", "golpe"], used = new Set(), out = [];
  for (let i = 0; out.length < count && i < 40; i++) {
    const type = pool[Math.floor(r() * pool.length)], zone = TYPES[type].zones[Math.floor(r() * TYPES[type].zones.length)];
    if (used.has(zone)) continue; used.add(zone);
    const severity = type === "golpe" && r() > 0.55 ? "moderado" : "leve";
    const size = type === "piquete" ? `${Math.round(3 + r() * 6)} mm` : `${Math.round(type === "pintura" ? 15 + r() * 20 : 4 + r() * 14)} cm`;
    const fixed = type === "golpe" ? severity === "moderado" || r() > 0.5 : type === "pintura" ? r() > 0.6 : r() > 0.7;
    const status = fixed ? (type === "golpe" ? "Reparado con PDR (sin repintar) en el alistamiento" : type === "piquete" ? "Sellado con resina; no afecta la visibilidad" : "Pulido en el alistamiento; casi no se nota") : "Se mantiene: detalle estético, ya considerado en el precio";
    out.push({ n: out.length + 1, type, label: TYPES[type].label, zone, zoneLabel: ZONES[zone], severity, size, fixed, status });
  }
  return out;
}

// ---------- Modelo 3D ----------
const COLORS = { blanco: 0xf2f3f5, negro: 0x16181b, plomo: 0x6f767e, gris: 0x7d848c, plata: 0xb9bec5, plateado: 0xb9bec5, rojo: 0xa50f18, azul: 0x1d3f8f, verde: 0x2f6b3f, beige: 0xd8c9a8, cafe: 0x5a3d2b, naranja: 0xe46b1c, amarillo: 0xe8c21b };
const norm = v => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function bodyType(car) {
  const c = norm(car.category), m = norm(car.model);
  if (c === "camioneta" || /hilux|d-max|luv|dmax|ranger|navara|bt-50|n200|montana|l200|frontier/.test(m)) return /n200/.test(m) ? "van" : "pickup";
  if (c === "van") return "van";
  if (c === "suv") return "suv";
  if (/hatch|spark|swift|matiz|yaris|joy|picanto|rio stylus|i10|sail full|208|corsa|soluto/.test(m) && !/sedan|sedán/.test(m)) return "hatch";
  return "sedan";
}
const PROFILES = { // [x (fracción del largo, frente = +0,5), y (fracción del alto)]
  sedan: { L: 4.55, W: 1.78, H: 1.45, pts: [[-0.5, 0.24], [0.5, 0.24], [0.5, 0.5], [0.47, 0.6], [0.22, 0.66], [0.07, 0.96], [-0.2, 1.0], [-0.36, 0.7], [-0.5, 0.65]], belt: 0.66 },
  hatch: { L: 4.0, W: 1.73, H: 1.5, pts: [[-0.5, 0.25], [0.5, 0.25], [0.5, 0.5], [0.46, 0.6], [0.25, 0.65], [0.09, 0.97], [-0.37, 1.0], [-0.48, 0.82], [-0.5, 0.62]], belt: 0.65 },
  suv: { L: 4.55, W: 1.85, H: 1.68, pts: [[-0.5, 0.22], [0.5, 0.22], [0.5, 0.52], [0.46, 0.62], [0.27, 0.66], [0.13, 0.96], [-0.44, 1.0], [-0.5, 0.9], [-0.5, 0.55]], belt: 0.66 },
  pickup: { L: 5.3, W: 1.85, H: 1.8, pts: [[-0.5, 0.3], [0.5, 0.3], [0.5, 0.58], [0.46, 0.66], [0.28, 0.7], [0.17, 0.98], [-0.1, 1.0], [-0.13, 0.69], [-0.5, 0.69]], belt: 0.69 },
  van: { L: 4.4, W: 1.7, H: 1.9, pts: [[-0.5, 0.2], [0.5, 0.2], [0.5, 0.52], [0.44, 0.6], [0.32, 0.66], [0.2, 0.98], [-0.48, 1.0], [-0.5, 0.95]], belt: 0.62 }
};
// Altura del perfil (techo / capó) en una posición x (fracción del largo).
function topAt(spec, xf) {
  const top = spec.pts.slice(2); // contorno superior, de adelante hacia atrás
  for (let i = 0; i < top.length - 1; i++) { const [x1, y1] = top[i], [x2, y2] = top[i + 1]; if ((xf <= x1 && xf >= x2) || (xf >= x1 && xf <= x2)) { const t = x1 === x2 ? 0 : (xf - x1) / (x2 - x1); return (y1 + (y2 - y1) * t) * spec.H; } }
  return spec.H * 0.6;
}
function canvasTexture(draw, size = 128) { const c = document.createElement("canvas"); c.width = c.height = size; draw(c.getContext("2d"), size); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }

function buildCar(car) {
  const type = bodyType(car), spec = PROFILES[type], { L, W, H } = spec, group = new THREE.Group();
  const color = COLORS[norm(car.color).split(" ")[0]] ?? 0x9ea4ab;
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d1724, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.88, clearcoat: 1 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.75 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.2 });
  const bevel = 0.07;
  // Perfil lateral: la parte baja (hasta la línea de cintura) es carrocería; arriba va la cabina de vidrio y el techo.
  const belt = spec.belt * H, P = spec.pts.map(([x, y]) => [x * L, y * H]), topPts = P.slice(2);
  const cross = (a, b) => { const t = (belt - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, belt]; };
  let fi = topPts.findIndex(([, y]) => y > belt + 1e-6), li = topPts.length - 1 - [...topPts].reverse().findIndex(([, y]) => y > belt + 1e-6);
  const front = topPts[fi - 1][1] === belt ? topPts[fi - 1] : cross(topPts[fi - 1], topPts[fi]);
  const rear = li + 1 < topPts.length ? (topPts[li + 1][1] === belt ? topPts[li + 1] : cross(topPts[li], topPts[li + 1])) : [topPts[li][0], belt];
  const upper = topPts.slice(fi, li + 1);
  const lower = [...P.slice(0, 2), ...topPts.slice(0, fi).filter(([, y]) => y <= belt), front, rear, ...topPts.slice(li + 1).filter(([, y]) => y <= belt)];
  const extrude = (raw, depth, opts, mat) => { const pts = raw.filter((p, i) => { const q = raw[(i + raw.length - 1) % raw.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4; }); const m = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), { depth, bevelEnabled: true, curveSegments: 8, ...opts }), mat); m.position.z = -depth / 2; group.add(m); return m; };
  extrude(lower, W - 2 * bevel, { bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5 }, paint);
  const cabin = [front, ...upper, rear].map(([x, y]) => [x * 0.985, y]);
  extrude(cabin, W - 0.32, { bevelThickness: 0.07, bevelSize: 0.03, bevelSegments: 4 }, glass);
  // Techo pintado: la franja de arriba de la cabina.
  const roofTop = upper.filter(([, y]) => y >= Math.max(...upper.map(p => p[1])) - 0.09 * H);
  const roof = [...roofTop.map(([x, y]) => [x * 0.97, y + 0.012]), ...roofTop.slice().reverse().map(([x, y]) => [x * 0.97, y - 0.07])];
  extrude(roof, W - 0.3, { bevelThickness: 0.08, bevelSize: 0.035, bevelSegments: 4 }, paint);
  // Pilar central (B).
  const pillarX = (front[0] + rear[0]) / 2 + (rear[0] - front[0]) * -0.02, pillarTop = topAt(spec, pillarX / L);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.09, pillarTop - belt - 0.03, W - 0.12), paint); pillar.position.set(pillarX, (pillarTop + belt) / 2 - 0.015, 0); group.add(pillar);
  // Ruedas.
  const r = type === "pickup" || type === "suv" ? 0.37 : 0.32, wheelX = L * (type === "pickup" ? 0.33 : 0.32);
  const tireGeo = new THREE.CylinderGeometry(r, r, 0.24, 36), rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.25, 24), hubGeo = new THREE.CylinderGeometry(r * 0.18, r * 0.18, 0.26, 12);
  const wheels = [];
  for (const [x, z] of [[wheelX, 1], [wheelX, -1], [-wheelX, 1], [-wheelX, -1]]) {
    const w = new THREE.Group(); w.add(new THREE.Mesh(tireGeo, black)); w.add(new THREE.Mesh(rimGeo, chrome)); w.add(new THREE.Mesh(hubGeo, black));
    for (let k = 0; k < 5; k++) { const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 0.1, 0.255, r * 1.1), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 })); spoke.rotation.y = (k / 5) * Math.PI; w.add(spoke); }
    w.rotation.x = Math.PI / 2; w.position.set(x, r, z * (W / 2 - 0.08)); group.add(w); wheels.push(w);
    const arch = new THREE.Mesh(new THREE.TorusGeometry(r + 0.06, 0.045, 8, 24, Math.PI), black); arch.position.set(x, r, z * (W / 2 + 0.005)); group.add(arch);
  }
  // Luces, parrilla, espejos, manijas.
  const frontX = L / 2 + bevel, rearX = -L / 2 - bevel, lightY = spec.pts[2][1] * H - 0.06;
  const head = new THREE.MeshStandardMaterial({ color: 0xf6f8ff, emissive: 0xdfe8ff, emissiveIntensity: 0.6, roughness: 0.1 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xb3121b, emissive: 0x8a0a10, emissiveIntensity: 0.7, roughness: 0.2 });
  for (const z of [1, -1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.34), head); h.position.set(frontX - 0.02, lightY, z * (W / 2 - 0.25)); group.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.3), tail); t.position.set(rearX + 0.02, (spec.pts.at(-1)[1] * H) - 0.12, z * (W / 2 - 0.22)); group.add(t);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.12), paint); mirror.position.set(front[0] - 0.12, belt + 0.06, z * (W / 2 + 0.05)); group.add(mirror);
    for (const hx of [L * 0.04, -L * 0.2]) { const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.02), chrome); handle.position.set(hx, belt - 0.12, z * (W / 2 + 0.005)); group.add(handle); }
    for (const dx of [L * 0.16, -L * 0.09, ...(type === "pickup" || type === "van" ? [] : [-L * 0.32])]) { const seam = new THREE.Mesh(new THREE.BoxGeometry(0.008, belt - spec.pts[0][1] * H - 0.08, 0.004), black); seam.position.set(dx, (belt + spec.pts[0][1] * H) / 2, z * (W / 2 + 0.002)); group.add(seam); }
  }
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, W * 0.5), black); grille.position.set(frontX - 0.01, lightY - 0.12, 0); group.add(grille);
  const plateMat = new THREE.MeshStandardMaterial({ map: canvasTexture((ctx, s) => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s); ctx.fillStyle = "#0a3b91"; ctx.fillRect(0, 0, s, s * 0.22); ctx.fillStyle = "#111"; ctx.font = `bold ${s * 0.3}px sans-serif`; ctx.textAlign = "center"; ctx.fillText("1001", s / 2, s * 0.7); }, 128) });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), plateMat); plate.position.set(rearX - 0.005, spec.pts[0][1] * H + 0.18, 0); plate.rotation.y = -Math.PI / 2; group.add(plate);
  if (type === "pickup") { const bedX = (-0.13 * L - 0.5 * L) / 2, bed = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(-0.13 * L + 0.5 * L) - 0.2, 0.02, W - 0.2), black); bed.position.set(bedX, spec.belt * H + 0.075, 0); group.add(bed); }
  return { group, spec, type, wheels, bevel, r, wheelX, paintColor: color };
}

// Punto y normal de cada zona sobre la carrocería.
function zoneAnchor(zone, m) {
  const { spec, bevel, r, wheelX } = m, { L, W, H } = spec, side = W / 2 + bevel, V = (x, y, z) => new THREE.Vector3(x, y, z);
  const midY = (spec.belt * H + spec.pts[0][1] * H) / 2;
  const map = {
    puerta_del_izq: [V(L * 0.05, midY, side), V(0, 0, 1)], puerta_tras_izq: [V(-L * 0.2, midY, side), V(0, 0, 1)],
    puerta_del_der: [V(L * 0.05, midY, -side), V(0, 0, -1)], puerta_tras_der: [V(-L * 0.2, midY, -side), V(0, 0, -1)],
    guardachoque_del: [V(L / 2 + bevel, spec.pts[0][1] * H + 0.12, W * 0.24), V(1, 0, 0)], guardachoque_tras: [V(-L / 2 - bevel, spec.pts[0][1] * H + 0.14, -W * 0.22), V(-1, 0, 0)],
    capo: [V(L * 0.36, topAt(spec, 0.36) + bevel * 0.9, W * 0.1), V(0.15, 1, 0).normalize()], techo: [V(-L * 0.08, topAt(spec, -0.08) + bevel - 0.01, -W * 0.12), V(0, 1, 0)],
    guardafango_del_der: [V(wheelX + 0.05, r * 2 + 0.12, -side), V(0, 0, -1)], guardafango_tras_izq: [V(-wheelX - 0.08, r * 2 + 0.1, side), V(0, 0, 1)],
    aro_del_izq: [V(wheelX, r, W / 2 + 0.05), V(0, 0, 1)], aro_tras_der: [V(-wheelX, r, -W / 2 - 0.05), V(0, 0, -1)],
    parabrisas: [V(L * 0.15, (spec.belt * H + spec.H * 0.96) / 2, -W * 0.15), V(0.75, 0.66, 0).normalize()]
  };
  return map[zone];
}
function damageMesh(f, anchor, light = true) {
  const [p, n] = anchor, g = new THREE.Group();
  const ink = light ? "rgba(55,60,70,0.9)" : "rgba(232,235,240,0.95)", haze = light ? "rgba(120,110,95," : "rgba(255,255,255,";
  const tex = {
    rayon: () => canvasTexture((c, s) => { c.strokeStyle = ink; c.lineCap = "round"; for (let i = 0; i < 4; i++) { c.lineWidth = 1.5 + (i % 2); c.beginPath(); c.moveTo(s * 0.06, s * (0.42 + i * 0.05)); c.bezierCurveTo(s * 0.35, s * (0.36 + i * 0.06), s * 0.6, s * (0.5 + i * 0.03), s * 0.94, s * (0.44 + i * 0.05)); c.stroke(); } }),
    golpe: () => canvasTexture((c, s) => { const g1 = c.createRadialGradient(s * 0.45, s * 0.45, 2, s / 2, s / 2, s / 2); g1.addColorStop(0, "rgba(0,0,0,0.7)"); g1.addColorStop(0.45, "rgba(0,0,0,0.38)"); g1.addColorStop(0.75, "rgba(255,255,255,0.18)"); g1.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = g1; c.fillRect(0, 0, s, s); }),
    pintura: () => canvasTexture((c, s) => { for (let i = 0; i < 60; i++) { c.fillStyle = `${haze}${0.1 + Math.random() * 0.25})`; c.beginPath(); c.arc(s / 2 + (Math.random() - 0.5) * s * 0.7, s / 2 + (Math.random() - 0.5) * s * 0.5, 2 + Math.random() * 8, 0, 7); c.fill(); } }),
    aro: () => canvasTexture((c, s) => { c.strokeStyle = "rgba(60,60,60,0.9)"; c.lineWidth = 3; c.beginPath(); c.arc(s / 2, s / 2, s * 0.38, 0.3, 1.6); c.stroke(); c.lineWidth = 2; c.beginPath(); c.arc(s / 2, s / 2, s * 0.33, 0.5, 1.2); c.stroke(); }),
    piquete: () => canvasTexture((c, s) => { c.strokeStyle = "rgba(255,255,255,0.95)"; c.lineWidth = 1.5; for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; c.beginPath(); c.moveTo(s / 2, s / 2); c.lineTo(s / 2 + Math.cos(a) * s * (0.15 + Math.random() * 0.25), s / 2 + Math.sin(a) * s * (0.15 + Math.random() * 0.25)); c.stroke(); } c.fillStyle = "#fff"; c.beginPath(); c.arc(s / 2, s / 2, 3, 0, 7); c.fill(); })
  }[f.type]();
  const size = { rayon: [0.5, 0.25], golpe: [f.severity === "moderado" ? 0.34 : 0.24, f.severity === "moderado" ? 0.34 : 0.24], pintura: [0.5, 0.35], aro: [0.55, 0.55], piquete: [0.16, 0.16] }[f.type];
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  mesh.position.copy(p).addScaledVector(n, 0.012); mesh.lookAt(p.clone().addScaledVector(n, 1)); g.add(mesh);
  return g;
}

// ---------- Visor ----------
export async function mountViewer(container, car, { findings = simulatedFindings(car), onSelect = () => {} } = {}) {
  try { await loadThree(); } catch { container.innerHTML = '<p class="v360-fallback">No pudimos cargar la vista 3D en este navegador.</p>'; return null; }
  const canvas = document.createElement("canvas"); canvas.className = "v360-canvas";
  let renderer; try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { container.innerHTML = '<p class="v360-fallback">Tu navegador no permite ver modelos 3D. Revisa la lista de detalles.</p>'; return null; }
  container.append(canvas);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  // Luz de estudio: cielo, sol y un entorno sencillo para los reflejos de la pintura.
  scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x8a8f99, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(4, 7, 5); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.9); fill.position.set(-5, 3, -4); scene.add(fill);
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x9aa6b8);
  const panel = (w, h, c, pos, rotY = 0, rotX = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(...pos); m.rotation.set(rotX, rotY, 0); envScene.add(m); };
  panel(12, 3, 0xffffff, [0, 6, 0], 0, Math.PI / 2); panel(8, 2, 0xf3f6ff, [0, 2.5, -6]); panel(8, 2, 0xe8edf8, [0, 2.5, 6], Math.PI); panel(2, 6, 0xfff7e8, [6, 3, 0], -Math.PI / 2);
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  const model = buildCar(car); scene.add(model.group);
  // Sombra suave en el piso.
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(model.spec.L * 1.5, model.spec.W * 2.2), new THREE.MeshBasicMaterial({ map: canvasTexture((c, s) => { const g = c.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s / 2); g.addColorStop(0, "rgba(10,20,40,0.45)"); g.addColorStop(1, "rgba(10,20,40,0)"); c.fillStyle = g; c.fillRect(0, 0, s, s); }, 256), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; scene.add(shadow);
  const damages = new THREE.Group(); scene.add(damages);
  const light = new THREE.Color(model.paintColor).getHSL({}).l > 0.45;
  const anchors = findings.map(f => { const a = zoneAnchor(f.zone, model); damages.add(damageMesh(f, a, light)); return a; });
  // Marcadores HTML sobre el canvas.
  const markers = findings.map((f, i) => { const b = document.createElement("button"); b.type = "button"; b.className = `v360-marker ${f.severity}`; b.textContent = String(f.n); b.setAttribute("aria-label", `${f.n}. ${f.label} en ${f.zoneLabel}`); b.addEventListener("click", e => { e.stopPropagation(); select(i); }); container.append(b); return b; });
  const target = new THREE.Vector3(0, model.spec.H * 0.45, 0);
  const view = { yaw: 0.7, pitch: 0.22, dist: model.spec.L * 1.75, auto: true, showDamage: true, anim: null, selected: -1 };
  const resize = () => { const w = container.clientWidth, h = container.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(container); resize();
  // Girar con el mouse o el dedo; acercar con la rueda o pellizcando.
  let drag = null; const pointers = new Map();
  canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, dist: view.dist, pinch: null }; view.auto = false; view.anim = null; container.classList.add("touched"); });
  canvas.addEventListener("pointermove", e => { if (!drag || !pointers.has(e.pointerId)) return; pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); drag.pinch ??= d; view.dist = Math.min(model.spec.L * 2.6, Math.max(model.spec.L * 0.9, drag.dist * drag.pinch / d)); return; }
    view.yaw = drag.yaw - (e.clientX - drag.x) * 0.008; view.pitch = Math.min(1.25, Math.max(0.02, drag.pitch + (e.clientY - drag.y) * 0.005)); });
  const up = e => { pointers.delete(e.pointerId); if (!pointers.size) drag = null; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", e => { e.preventDefault(); view.dist = Math.min(model.spec.L * 2.6, Math.max(model.spec.L * 0.9, view.dist * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
  const goTo = (yaw, pitch, dist = view.dist) => { const twoPi = Math.PI * 2; let dy = ((yaw - view.yaw) % twoPi + twoPi * 1.5) % twoPi - Math.PI; view.anim = { from: { yaw: view.yaw, pitch: view.pitch, dist: view.dist }, to: { yaw: view.yaw + dy, pitch, dist }, t: 0 }; view.auto = false; };
  function select(i) {
    view.selected = i; markers.forEach((m, k) => m.classList.toggle("active", k === i));
    if (i >= 0) { const [, n] = anchors[i]; const yaw = Math.atan2(n.z, n.x); goTo(Math.abs(n.y) > 0.9 ? view.yaw : yaw, n.y > 0.5 ? 0.95 : 0.25, model.spec.L * 1.55); }
    onSelect(i);
  }
  const tmp = new THREE.Vector3(), camDir = new THREE.Vector3();
  let running = true, last = performance.now();
  const frame = now => {
    if (!running) return; const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (view.anim) { const a = view.anim; a.t = Math.min(1, a.t + dt * 1.6); const k = 1 - Math.pow(1 - a.t, 3); view.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k; view.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k; view.dist = a.from.dist + (a.to.dist - a.from.dist) * k; if (a.t >= 1) view.anim = null; }
    else if (view.auto) view.yaw += dt * 0.35;
    const fit = Math.pow(Math.max(1, 1.5 / Math.max(0.3, camera.aspect)), 0.9), dist = view.dist * fit;
    camera.position.set(target.x + Math.cos(view.pitch) * Math.cos(view.yaw) * dist, target.y + Math.sin(view.pitch) * dist, target.z + Math.cos(view.pitch) * Math.sin(view.yaw) * dist);
    camera.lookAt(target); renderer.render(scene, camera);
    camera.getWorldDirection(camDir); const w = container.clientWidth, h = container.clientHeight;
    anchors.forEach(([p, n], i) => { const m = markers[i], facing = n.dot(camDir) < -0.12; tmp.copy(p).addScaledVector(n, 0.08); tmp.y += 0.26; tmp.project(camera); const visible = view.showDamage && facing && tmp.z < 1;
      m.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%,-50%)`; m.classList.toggle("hidden", !visible); m.tabIndex = visible ? 0 : -1; });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return {
    select, findings,
    setView(name) { const v = { frente: [0, 0.18], lado: [Math.PI / 2, 0.15], atras: [Math.PI, 0.18], arriba: [view.yaw, 1.2] }[name]; if (v) goTo(v[0], v[1], model.spec.L * 1.75); },
    toggleDamage(on) { view.showDamage = on; damages.visible = on; },
    autoRotate(on) { view.auto = on; view.anim = null; },
    destroy() { running = false; ro.disconnect(); renderer.dispose(); pmrem.dispose(); container.innerHTML = ""; }
  };
}
