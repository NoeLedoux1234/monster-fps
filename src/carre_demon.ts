import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './style.css';

// ============================================================
// SCENE - on cree la scene 3D avec un fond sombre et du brouillard
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0008); // fond quasi noir avec teinte rouge
scene.fog = new THREE.FogExp2(0x0a0008, 0.06); // brouillard exponentiel pour l'ambiance

// ============================================================
// CAMERA - camera perspective (vision humaine) positionnee en recul
// ============================================================
const camera = new THREE.PerspectiveCamera(
  75,                                      // champ de vision en degres
  window.innerWidth / window.innerHeight,  // ratio largeur/hauteur
  0.1,                                     // distance min de rendu
  1000,                                    // distance max de rendu
);
camera.position.z = 5; // recule la camera pour voir la scene

// ============================================================
// RENDERER - moteur de rendu WebGL qui dessine la scene dans le navigateur
// ============================================================
const renderer = new THREE.WebGLRenderer({
  antialias: true, // lissage des bords pour eviter l'effet escalier
});

renderer.setSize(window.innerWidth, window.innerHeight); // taille = fenetre entiere
renderer.setPixelRatio(window.devicePixelRatio);          // gere les ecrans retina
renderer.shadowMap.enabled = true;                        // active les ombres
document.body.appendChild(renderer.domElement);           // ajoute le canvas au DOM

// ============================================================
// ORBIT CONTROLS - deplacement libre de la camera a la souris
// ============================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;  // inertie fluide
controls.dampingFactor = 0.08;
controls.enablePan = true;      // deplacement lateral (clic droit)
controls.minDistance = 2;       // zoom min
controls.maxDistance = 50;      // zoom max

// ============================================================
// SYSTEME D'ECLAIRAGE - 5 modes differents switchables via l'UI
// ============================================================
type LightMode = 'ambient' | 'directional' | 'point' | 'spot' | 'hemisphere';
let currentMode: LightMode = 'point'; // mode par defaut : Point Light (enfer)

// lumiere ambiante de base toujours active (tres faible, teinte sombre)
const ambientLight = new THREE.AmbientLight(0x110008, 1.5);
scene.add(ambientLight);

// -- Mode Ambient : eclairage uniforme partout, pas de direction --
const ambientMain = new THREE.AmbientLight(0xff2200, 3);   // lueur rouge/orange
ambientMain.visible = false;
scene.add(ambientMain);

const ambientFill = new THREE.AmbientLight(0x4400aa, 1.5); // lueur violette complementaire
ambientFill.visible = false;
scene.add(ambientFill);

// -- Mode Directional : lumiere parallele comme le soleil, cree des ombres nettes --
const dirLight = new THREE.DirectionalLight(0xff4400, 4); // lumiere principale orange
dirLight.position.set(3, 4, 2);
dirLight.visible = false;
scene.add(dirLight);

const dirBackLight = new THREE.DirectionalLight(0x6600ff, 2); // contre-jour violet
dirBackLight.position.set(-3, -1, -3);
dirBackLight.visible = false;
scene.add(dirBackLight);

const dirRimLight = new THREE.DirectionalLight(0x0044ff, 1.5); // lisere bleu sur le cote
dirRimLight.position.set(4, 0, -1);
dirRimLight.visible = false;
scene.add(dirRimLight);

// -- Mode Point : lumiere ponctuelle qui rayonne dans toutes les directions (mode enfer) --
const fireLight = new THREE.PointLight(0xff2200, 4, 15); // feu principal orange
fireLight.position.set(3, 2, 3);
scene.add(fireLight);

const underLight = new THREE.PointLight(0xff0000, 3, 10); // lueur rouge par en-dessous
underLight.position.set(0, -3, 0);
scene.add(underLight);

const purpleLight = new THREE.PointLight(0x6600ff, 3, 15); // lumiere violette arriere
purpleLight.position.set(-3, 1, -4);
scene.add(purpleLight);

const rimLight = new THREE.PointLight(0x0033ff, 2, 12); // lumiere bleue froide sur le cote
rimLight.position.set(4, 0, -2);
scene.add(rimLight);

// -- Mode Spot : projecteur cone de lumiere dirige vers une cible --
const spotMain = new THREE.SpotLight(0xff3300, 8, 15, Math.PI / 6, 0.5, 1); // spot principal
spotMain.position.set(0, 5, 3);
spotMain.target.position.set(0, 0, 0); // pointe vers le centre (le demon)
spotMain.visible = false;
scene.add(spotMain);
scene.add(spotMain.target);

const spotBack = new THREE.SpotLight(0x8800ff, 5, 12, Math.PI / 5, 0.6, 1); // spot arriere violet
spotBack.position.set(-2, 3, -4);
spotBack.target.position.set(0, 0, 0);
spotBack.visible = false;
scene.add(spotBack);
scene.add(spotBack.target);

const spotFloor = new THREE.SpotLight(0xff0000, 4, 10, Math.PI / 4, 0.8, 1); // spot rouge par en-dessous
spotFloor.position.set(0, -4, 0);
spotFloor.target.position.set(0, 0, 0);
spotFloor.visible = false;
scene.add(spotFloor);
scene.add(spotFloor.target);

// -- Mode Hemisphere : simule ciel + sol avec 2 couleurs (haut = feu, bas = violet) --
const hemiLight = new THREE.HemisphereLight(0xff4400, 0x4400ff, 3);
hemiLight.visible = false;
scene.add(hemiLight);

const hemiAccent = new THREE.PointLight(0xff0000, 2, 10); // accent rouge supplementaire
hemiAccent.position.set(0, -2, 2);
hemiAccent.visible = false;
scene.add(hemiAccent);

// ============================================================
// CONFIGURATION DES MODES - chaque mode a ses lumieres, couleur de fond, brouillard
// ============================================================
interface ModeConfig {
  lights: THREE.Light[];
  bg: number;
  fog: number;
  fogDensity: number;
  ambientIntensity: number;
}

const modes: Record<LightMode, ModeConfig> = {
  ambient: {
    lights: [ambientMain, ambientFill],
    bg: 0x150008, fog: 0x150008, fogDensity: 0.04, ambientIntensity: 0.5,
  },
  directional: {
    lights: [dirLight, dirBackLight, dirRimLight],
    bg: 0x080010, fog: 0x080010, fogDensity: 0.05, ambientIntensity: 0.8,
  },
  point: {
    lights: [fireLight, underLight, purpleLight, rimLight],
    bg: 0x0a0008, fog: 0x0a0008, fogDensity: 0.06, ambientIntensity: 1.5,
  },
  spot: {
    lights: [spotMain, spotBack, spotFloor],
    bg: 0x050008, fog: 0x050008, fogDensity: 0.07, ambientIntensity: 0.6,
  },
  hemisphere: {
    lights: [hemiLight, hemiAccent],
    bg: 0x0c0510, fog: 0x0c0510, fogDensity: 0.04, ambientIntensity: 0.8,
  },
};

// liste a plat de toutes les lumieres pour pouvoir toutes les eteindre d'un coup
const allModeLights: THREE.Light[] = Object.values(modes).flatMap((m) => m.lights);

// fonction qui switch entre les modes : eteint tout, allume le mode choisi
function setLightMode(mode: LightMode): void {
  currentMode = mode;
  const config = modes[mode];

  allModeLights.forEach((l) => { l.visible = false; });  // eteint toutes les lumieres
  config.lights.forEach((l) => { l.visible = true; });   // allume celles du mode

  scene.background = new THREE.Color(config.bg);         // change le fond
  (scene.fog as THREE.FogExp2).color.set(config.fog);    // change la couleur du brouillard
  (scene.fog as THREE.FogExp2).density = config.fogDensity; // change la densite du brouillard
  ambientLight.intensity = config.ambientIntensity;       // ajuste la lumiere ambiante de base

  // met a jour le style actif des boutons dans l'UI
  document.querySelectorAll('#light-panel button').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
  });
}

// ============================================================
// UI - panneau de boutons en haut a droite pour changer de mode d'eclairage
// ============================================================
const panel = document.createElement('div');
panel.id = 'light-panel';

const modeLabels: Record<LightMode, string> = {
  ambient: 'Ambient Light',
  directional: 'Directional Light',
  point: 'Point Light',
  spot: 'Spot Light',
  hemisphere: 'Hemisphere Light',
};

// cree un bouton par mode et l'ajoute au panneau
(Object.keys(modeLabels) as LightMode[]).forEach((mode) => {
  const btn = document.createElement('button');
  btn.textContent = modeLabels[mode];
  btn.dataset.mode = mode;
  if (mode === currentMode) btn.classList.add('active');
  btn.addEventListener('click', () => setLightMode(mode));
  panel.appendChild(btn);
});

document.body.appendChild(panel);

// ============================================================
// PARTICULES DE FEU - petits points orange qui montent dans l'air
// ============================================================
const particleCount = 200;
const particleGeo = new THREE.BufferGeometry();
const particlePositions = new Float32Array(particleCount * 3); // x,y,z pour chaque particule
const particleSpeeds = new Float32Array(particleCount);        // vitesse de montee individuelle

// position aleatoire de depart pour chaque particule
for (let i = 0; i < particleCount; i++) {
  particlePositions[i * 3] = (Math.random() - 0.5) * 12;     // x aleatoire
  particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 12; // y aleatoire
  particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 12; // z aleatoire
  particleSpeeds[i] = 0.5 + Math.random() * 1.5;             // vitesse aleatoire
}

particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
const particleMat = new THREE.PointsMaterial({ color: 0xff4400, size: 0.04, transparent: true, opacity: 0.8 });
const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);

// ============================================================
// PENTAGRAMME AU SOL - deux anneaux pentagonaux lumineux rouges
// ============================================================
const pentaRingMat = new THREE.MeshStandardMaterial({
  color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 1.5,
  transparent: true, opacity: 0.3, side: THREE.DoubleSide,
});

// anneau exterieur (5 cotes = pentagone)
const pentaRing = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.0, 5), pentaRingMat);
pentaRing.rotation.x = -Math.PI / 2; // a plat sur le sol
pentaRing.position.y = -2.5;
scene.add(pentaRing);

// anneau interieur (tourne en decale pour former l'etoile)
const pentaRingInner = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.15, 5), pentaRingMat);
pentaRingInner.rotation.x = -Math.PI / 2;
pentaRingInner.position.y = -2.5;
pentaRingInner.rotation.z = Math.PI / 5; // decale de 36 degres pour croiser l'anneau exterieur
scene.add(pentaRingInner);

// ============================================================
// COLONNES DE FEU - 6 flammes en cone disposees en cercle autour du demon
// ============================================================
const flameColumns: THREE.Mesh[] = [];
const flameMat = new THREE.MeshStandardMaterial({
  color: 0xff4400,
  emissive: 0xff2200,        // auto-eclairage orange
  emissiveIntensity: 2,
  transparent: true,
  opacity: 0.6,
  side: THREE.DoubleSide,
});

for (let i = 0; i < 6; i++) {
  const angle = (i / 6) * Math.PI * 2; // repartition en cercle (360 / 6 = 60 degres)
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.25, 1.8, 8, 1, true), // cone ouvert (forme de flamme)
    flameMat.clone(), // clone le materiau pour animer chaque flamme independamment
  );
  flame.position.set(Math.cos(angle) * 2.5, -1.8, Math.sin(angle) * 2.5);
  scene.add(flame);
  flameColumns.push(flame);
}

// ============================================================
// SOL DE LAVE - plan sombre avec lueur rouge emissive
// ============================================================
const lavaMat = new THREE.MeshStandardMaterial({
  color: 0x330000,
  emissive: 0x440000,      // auto-eclairage rouge sombre
  emissiveIntensity: 0.8,
  roughness: 0.9,          // surface rugueuse (lave refroidie)
  side: THREE.DoubleSide,
});
const lavaGround = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), lavaMat);
lavaGround.rotation.x = -Math.PI / 2; // a plat
lavaGround.position.y = -2.6;         // juste sous le pentagramme
scene.add(lavaGround);

// ============================================================
// FISSURES DE LAVE - lignes rouges aleatoires sur le sol
// ============================================================
const crackMat = new THREE.LineBasicMaterial({ color: 0xff3300, transparent: true, opacity: 0.7 });
const cracks: THREE.Line[] = [];

for (let i = 0; i < 15; i++) {
  const crackPoints: THREE.Vector3[] = [];
  let cx = (Math.random() - 0.5) * 8; // point de depart aleatoire
  let cz = (Math.random() - 0.5) * 8;
  crackPoints.push(new THREE.Vector3(cx, -2.55, cz));

  // chaque fissure a 4 segments avec direction aleatoire
  for (let j = 0; j < 4; j++) {
    cx += (Math.random() - 0.5) * 1.5;
    cz += (Math.random() - 0.5) * 1.5;
    crackPoints.push(new THREE.Vector3(cx, -2.55, cz));
  }

  const crackGeo = new THREE.BufferGeometry().setFromPoints(crackPoints);
  const crack = new THREE.Line(crackGeo, crackMat.clone());
  scene.add(crack);
  cracks.push(crack);
}

// ============================================================
// FUMEE - particules sombres qui montent lentement du sol
// ============================================================
const smokeCount = 150;
const smokeGeo = new THREE.BufferGeometry();
const smokePositions = new Float32Array(smokeCount * 3);
const smokeSpeeds = new Float32Array(smokeCount);

for (let i = 0; i < smokeCount; i++) {
  smokePositions[i * 3] = (Math.random() - 0.5) * 10;
  smokePositions[i * 3 + 1] = -2.5 + Math.random() * 4; // demarre pres du sol
  smokePositions[i * 3 + 2] = (Math.random() - 0.5) * 10;
  smokeSpeeds[i] = 0.2 + Math.random() * 0.5;
}

smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePositions, 3));
const smokeMat = new THREE.PointsMaterial({ color: 0x220000, size: 0.15, transparent: true, opacity: 0.4 });
const smoke = new THREE.Points(smokeGeo, smokeMat);
scene.add(smoke);

// ============================================================
// CRANES VOLANTS - 5 petits cranes aux yeux rouges qui orbitent autour du demon
// ============================================================
const skulls: THREE.Group[] = [];
const skullMat = new THREE.MeshStandardMaterial({ color: 0xccbb99, emissive: 0x220000, emissiveIntensity: 0.3, roughness: 0.8 });
const skullEyeMat = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 3 });

for (let i = 0; i < 5; i++) {
  const skull = new THREE.Group(); // groupe pour assembler les parties du crane

  // tete (sphere legerement ecrasee sur z)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), skullMat);
  head.scale.set(1, 1.1, 0.9);
  skull.add(head);

  // machoire (petit cube)
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.12), skullMat);
  jaw.position.set(0, -0.12, 0.02);
  skull.add(jaw);

  // oeil gauche (sphere rouge emissive)
  const lEye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), skullEyeMat);
  lEye.position.set(-0.05, 0.03, 0.13);
  skull.add(lEye);

  // oeil droit
  const rEye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), skullEyeMat);
  rEye.position.set(0.05, 0.03, 0.13);
  skull.add(rEye);

  skull.position.set(0, (Math.random() - 0.5) * 3, 0);
  scene.add(skull);
  skulls.push(skull);
}

// ============================================================
// GEOMETRIES FLOTTANTES - 6 formes differentes en orbite autour du demon
// ============================================================
const geoMat = new THREE.MeshStandardMaterial({
  color: 0x991111, emissive: 0x440000, emissiveIntensity: 0.8,
  roughness: 0.3, metalness: 0.6, wireframe: true, // wireframe pour voir la structure
});

// BoxGeometry - cube
const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), geoMat.clone());
scene.add(boxMesh);

// SphereGeometry - sphere
const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), geoMat.clone());
scene.add(sphereMesh);

// CylinderGeometry - cylindre
const cylinderMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.6, 16), geoMat.clone());
scene.add(cylinderMesh);

// TorusGeometry - anneau
const torusMesh = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 12, 32), geoMat.clone());
scene.add(torusMesh);

// PlaneGeometry - plan
const planeMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(0.6, 0.6),
  new THREE.MeshStandardMaterial({
    color: 0x991111, emissive: 0x440000, emissiveIntensity: 0.8,
    roughness: 0.3, metalness: 0.6, wireframe: true, side: THREE.DoubleSide,
  }),
);
scene.add(planeMesh);

// TorusKnotGeometry - noeud torique (forme complexe)
const knotMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.25, 0.07, 64, 8), geoMat.clone());
scene.add(knotMesh);

// tableau pour animer toutes les geometries ensemble
const floatingGeos = [boxMesh, sphereMesh, cylinderMesh, torusMesh, planeMesh, knotMesh];

// ============================================================
// ECLAIR - lumiere blanche intense qui flash aleatoirement
// ============================================================
const lightningLight = new THREE.PointLight(0xffffff, 0, 30);
lightningLight.position.set(0, 8, 0); // position haute (comme un orage)
scene.add(lightningLight);

// ============================================================
// LUNE SOUL EATER - modele 3D charge depuis GLTF
// ============================================================
const soulMoon = new THREE.Group();
soulMoon.position.set(4, 12, -10);
scene.add(soulMoon);

// lumiere emanant de la lune
const moonGlow = new THREE.PointLight(0xf5d060, 3, 50);
moonGlow.position.set(4, 12, -8);
scene.add(moonGlow);

// chargement du modele GLTF
const gltfLoader = new GLTFLoader();
gltfLoader.load(
  '/models/soul-eater-moon/scene.gltf',
  (gltf) => {
    const model = gltf.scene;

    // calcul de la bounding box pour centrer et normaliser la taille
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // centrer le modele sur l'origine du groupe
    model.position.sub(center);

    // normaliser la taille (cible ~21 unites - x3)
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      const scale = 21 / maxDim;
      model.scale.multiplyScalar(scale);
    }

    // convertir en MeshBasicMaterial pour afficher les textures sans dependre de l'eclairage
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const oldMat = child.material as THREE.MeshStandardMaterial;
        const newMat = new THREE.MeshBasicMaterial({
          map: oldMat.map,
          color: oldMat.map ? 0xffffff : 0xd4b030, // jaune pour le mesh sans texture (croissant)
          side: THREE.DoubleSide,
          fog: false,
          transparent: oldMat.transparent,
          opacity: oldMat.opacity,
        });
        child.material = newMat;
        oldMat.dispose();
      }
    });

    soulMoon.add(model);

    // --- cascade de sang (nappe epaisse et organique) ---
    const bloodStreams: THREE.Mesh[] = [];

    // nappe principale : forme large qui coule en s'elargissant
    const curtainLayers = [
      { z: 0.3, color: 0x660000, opacity: 0.9, widthTop: 1.8, widthBot: 3.5, xOff: 0 },
      { z: 0.5, color: 0x880000, opacity: 0.75, widthTop: 1.4, widthBot: 2.8, xOff: 0.15 },
      { z: 0.7, color: 0xaa0000, opacity: 0.6, widthTop: 1.0, widthBot: 2.0, xOff: -0.1 },
    ];

    const cascadeLen = 25;
    curtainLayers.forEach(({ z, color, opacity, widthTop, widthBot, xOff }) => {
      // forme de la nappe : etroite en haut (bouche), large en bas
      const curtainShape = new THREE.Shape();
      curtainShape.moveTo(-widthTop / 2 + xOff, 0);
      // bord gauche qui s'evase avec ondulation
      curtainShape.bezierCurveTo(
        -widthTop / 2 - 0.3 + xOff, -cascadeLen * 0.3,
        -widthBot / 2 + 0.5 + xOff, -cascadeLen * 0.6,
        -widthBot / 2 + xOff, -cascadeLen,
      );
      // bas (bord irregulier)
      curtainShape.bezierCurveTo(
        -widthBot / 3 + xOff, -cascadeLen - 0.8,
        widthBot / 3 + xOff, -cascadeLen - 0.5,
        widthBot / 2 + xOff, -cascadeLen,
      );
      // bord droit qui remonte
      curtainShape.bezierCurveTo(
        widthBot / 2 - 0.5 + xOff, -cascadeLen * 0.6,
        widthTop / 2 + 0.3 + xOff, -cascadeLen * 0.3,
        widthTop / 2 + xOff, 0,
      );
      curtainShape.lineTo(-widthTop / 2 + xOff, 0);

      const curtainMesh = new THREE.Mesh(
        new THREE.ShapeGeometry(curtainShape),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity, side: THREE.DoubleSide, fog: false,
        }),
      );
      curtainMesh.position.set(0.6, 0.35, z);
      soulMoon.add(curtainMesh);
      bloodStreams.push(curtainMesh);
    });

    // filaments plus fins sur les bords (donnent un aspect baveux)
    const filamentMat = new THREE.MeshBasicMaterial({
      color: 0x770000, transparent: true, opacity: 0.7, side: THREE.DoubleSide, fog: false,
    });
    [
      { x: -1.2, curve: -0.8, len: 20 },
      { x: 1.3, curve: 1.0, len: 18 },
      { x: -0.6, curve: -0.4, len: 22 },
      { x: 0.8, curve: 0.6, len: 16 },
    ].forEach(({ x, curve: c, len }) => {
      const path = new THREE.CubicBezierCurve3(
        new THREE.Vector3(x, 0, 0.4),
        new THREE.Vector3(x + c * 0.2, -len * 0.3, 0.4),
        new THREE.Vector3(x + c * 0.7, -len * 0.7, 0.3),
        new THREE.Vector3(x + c, -len, 0.2),
      );
      const filament = new THREE.Mesh(
        new THREE.TubeGeometry(path, 16, 0.08, 5, false),
        filamentMat.clone(),
      );
      filament.position.set(0.6, 0.35, 0);
      soulMoon.add(filament);
      bloodStreams.push(filament);
    });

    // flaque en bas
    const splatShape = new THREE.Shape();
    splatShape.moveTo(-3.0, 0);
    splatShape.quadraticCurveTo(-3.6, -1.2, -2.4, -2.1);
    splatShape.quadraticCurveTo(-0.9, -3.0, 0.6, -2.4);
    splatShape.quadraticCurveTo(2.1, -1.5, 2.7, -0.6);
    splatShape.quadraticCurveTo(2.4, 0.3, 0.9, 0.45);
    splatShape.quadraticCurveTo(-0.9, 0.6, -3.0, 0);
    const splatMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(splatShape),
      new THREE.MeshBasicMaterial({ color: 0x550000, transparent: true, opacity: 0.8, side: THREE.DoubleSide, fog: false }),
    );
    splatMesh.position.set(0.6, 0.35 - cascadeLen, 0.3);
    soulMoon.add(splatMesh);

    // gouttes qui se detachent
    const dripMat = new THREE.MeshBasicMaterial({ color: 0x990000, transparent: true, opacity: 0.8, fog: false });
    const drips: THREE.Mesh[] = [];
    for (let i = 0; i < 15; i++) {
      const drip = new THREE.Mesh(new THREE.SphereGeometry(0.12 + Math.random() * 0.2, 6, 6), dripMat);
      drip.position.set(
        (Math.random() - 0.5) * 4,
        0.35 - Math.random() * cascadeLen,
        0.5 + Math.random() * 0.5,
      );
      soulMoon.add(drip);
      drips.push(drip);
    }

    soulMoon.userData.bloodStreams = bloodStreams;
    soulMoon.userData.bloodDrips = drips;
  },
  undefined,
  (error) => {
    console.error('Erreur chargement lune GLTF:', error);
  },
);

// ============================================================
// DEMON - le personnage principal, un groupe de meshes assembles
// ============================================================
const demon = new THREE.Group();

// --- Corps : cube rouge ---
const bodyGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcc1111, roughness: 0.4 });
const body = new THREE.Mesh(bodyGeo, bodyMat);
demon.add(body);

// --- Yeux : spheres jaunes luminescentes ---
const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffaa00, emissiveIntensity: 1.5 });

const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), eyeMat);
leftEye.position.set(-0.25, 0.2, 0.61); // devant le cube, decale a gauche
demon.add(leftEye);

const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), eyeMat);
rightEye.position.set(0.25, 0.2, 0.61);
demon.add(rightEye);

// --- Pupilles : petites spheres noires devant les yeux ---
const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000 });

const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), pupilMat);
leftPupil.position.set(-0.25, 0.2, 0.73); // un peu devant l'oeil
demon.add(leftPupil);

const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), pupilMat);
rightPupil.position.set(0.25, 0.2, 0.73);
demon.add(rightPupil);

// --- Cornes : cones noirs inclines sur le dessus du cube ---
const hornMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3 });

const leftHorn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6, 8), hornMat);
leftHorn.position.set(-0.35, 0.9, 0);
leftHorn.rotation.z = 0.3; // incline vers l'exterieur
demon.add(leftHorn);

const rightHorn = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6, 8), hornMat);
rightHorn.position.set(0.35, 0.9, 0);
rightHorn.rotation.z = -0.3;
demon.add(rightHorn);

// --- Bouche : courbe elliptique (sourire malefique) ---
const smileCurve = new THREE.EllipseCurve(
  0, 0,           // centre
  0.25, 0.1,      // rayon x, rayon y
  Math.PI * 0.1,  // angle de debut
  Math.PI * 0.9,  // angle de fin (demi-cercle)
  false, 0,
);
const smilePoints = smileCurve.getPoints(20); // 20 points pour lisser la courbe
const smileGeo = new THREE.BufferGeometry().setFromPoints(smilePoints);
const smileMat = new THREE.LineBasicMaterial({ color: 0xffaa00 });
const smile = new THREE.Line(smileGeo, smileMat);
smile.position.set(0, -0.15, 0.62);
demon.add(smile);

// --- Crocs : petits cones blancs pointe vers le bas ---
const fangMat = new THREE.MeshStandardMaterial({ color: 0xffffff });

const leftFang = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 6), fangMat);
leftFang.position.set(-0.15, -0.25, 0.62);
leftFang.rotation.z = Math.PI; // retourne pour que la pointe soit vers le bas
demon.add(leftFang);

const rightFang = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 6), fangMat);
rightFang.position.set(0.15, -0.25, 0.62);
rightFang.rotation.z = Math.PI;
demon.add(rightFang);

// --- Collier : torus violet luminescent autour du "cou" ---
const collarMat = new THREE.MeshStandardMaterial({
  color: 0x8b00ff, emissive: 0x4400aa, emissiveIntensity: 0.5, roughness: 0.2,
});
const collar = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.06, 8, 32), collarMat);
collar.position.set(0, -0.55, 0);
collar.rotation.x = Math.PI / 2; // horizontal
demon.add(collar);

// --- Pics du collier : 8 petits cones metalliques repartis autour du collier ---
const spikeMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.15, 6), spikeMat);
  spike.position.set(Math.cos(angle) * 0.7, -0.55, Math.sin(angle) * 0.7);
  spike.rotation.x = Math.PI / 2;
  spike.lookAt(new THREE.Vector3(Math.cos(angle) * 2, -0.55, Math.sin(angle) * 2)); // pointe vers l'exterieur
  demon.add(spike);
}

// --- Gemme pendante : octaedre rouge emissif sous le collier ---
const gemMat = new THREE.MeshStandardMaterial({
  color: 0xff0044, emissive: 0xff0022, emissiveIntensity: 2, roughness: 0.1,
});
const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), gemMat);
gem.position.set(0, -0.75, 0.65);
demon.add(gem);

// --- Ailes : formes 2D (Shape) de chauve-souris placees de chaque cote ---
const wingMat = new THREE.MeshStandardMaterial({ color: 0x880000, side: THREE.DoubleSide, roughness: 0.6 });

// dessin de la forme d'aile avec des courbes de bezier quadratiques
const wingShape = new THREE.Shape();
wingShape.moveTo(0, 0);
wingShape.quadraticCurveTo(0.8, 0.6, 0.5, 1.0);  // pointe haute
wingShape.quadraticCurveTo(0.6, 0.5, 0.9, 0.3);  // encoche
wingShape.quadraticCurveTo(0.5, 0.2, 0.7, -0.2); // pointe basse
wingShape.quadraticCurveTo(0.3, 0.0, 0, 0);       // retour a l'origine

const wingGeo = new THREE.ShapeGeometry(wingShape);

// aile gauche
const leftWing = new THREE.Mesh(wingGeo, wingMat);
leftWing.position.set(-0.6, 0.1, -0.2);
leftWing.rotation.y = -Math.PI / 2 - 0.3; // perpendiculaire au corps + legere ouverture
leftWing.scale.set(0.8, 0.8, 0.8);
demon.add(leftWing);

// aile droite (meme geometrie, rotation miroir)
const rightWing = new THREE.Mesh(wingGeo, wingMat);
rightWing.position.set(0.6, 0.1, -0.2);
rightWing.rotation.y = Math.PI / 2 + 0.3;
rightWing.scale.set(0.8, 0.8, 0.8);
demon.add(rightWing);

// --- Queue : tube courbe (bezier cubique) avec pointe en fleche ---
const tailCurve = new THREE.CubicBezierCurve3(
  new THREE.Vector3(0, -0.6, -0.6),     // depart (bas arriere du corps)
  new THREE.Vector3(0, -1.2, -1.0),     // point de controle 1 (descend vers l'arriere)
  new THREE.Vector3(0.5, -1.4, -0.5),   // point de controle 2 (courbe vers la droite)
  new THREE.Vector3(0.6, -1.0, -0.3),   // arrivee (remonte legerement)
);
const tailGeo = new THREE.TubeGeometry(tailCurve, 20, 0.04, 8, false); // tube le long de la courbe
const tailMat = new THREE.MeshStandardMaterial({ color: 0xcc1111, roughness: 0.4 });
const tail = new THREE.Mesh(tailGeo, tailMat);
demon.add(tail);

// pointe de la queue (cone 4 faces = forme de fleche/losange)
const tailTip = new THREE.Mesh(
  new THREE.ConeGeometry(0.1, 0.2, 4),
  new THREE.MeshStandardMaterial({ color: 0x1a1a1a }),
);
tailTip.position.set(0.6, -1.0, -0.3); // au bout de la queue
tailTip.rotation.z = -Math.PI / 4;
demon.add(tailTip);

// ajoute le groupe demon a la scene
scene.add(demon);

// ============================================================
// BOUCLE D'ANIMATION - tourne 60 fois par seconde (requestAnimationFrame)
// ============================================================
let time = 0;

function animate(): void {
  requestAnimationFrame(animate); // demande la prochaine frame au navigateur
  time += 0.016; // ~60fps (1/60 = 0.016s)

  // --- rotation continue du demon ---
  demon.rotation.y += 0.008;

  // --- flottement : mouvement sinusoidal vertical ---
  demon.position.y = Math.sin(time * 2) * 0.15;

  // --- battement des ailes : oscillation de la rotation Y ---
  leftWing.rotation.y = -Math.PI / 2 - 0.3 + Math.sin(time * 4) * 0.15;
  rightWing.rotation.y = Math.PI / 2 + 0.3 - Math.sin(time * 4) * 0.15;

  // --- pulsation de la gemme : grossit/retrecit ---
  gem.scale.setScalar(1 + Math.sin(time * 3) * 0.15);

  // ============================================================
  // ANIMATIONS SPECIFIQUES A CHAQUE MODE D'ECLAIRAGE
  // ============================================================
  if (currentMode === 'point') {
    // le feu orbite autour du demon et vacille en intensite
    fireLight.position.x = Math.sin(time * 0.7) * 4;
    fireLight.position.z = Math.cos(time * 0.7) * 4;
    fireLight.intensity = 3.5 + Math.sin(time * 12) * 1.5 + Math.sin(time * 7.3) * 0.8;
    // la lumiere violette tourne en sens inverse
    purpleLight.position.x = Math.sin(-time * 0.4) * 4;
    purpleLight.position.z = Math.cos(-time * 0.4) * 4;
    purpleLight.intensity = 2.5 + Math.sin(time * 5) * 0.8;
    // le lisere bleu clignote de maniere aleatoire
    rimLight.intensity = 1.5 + Math.sin(time * 15) * 0.7 + Math.cos(time * 9) * 0.5;
    // la lueur rouge du dessous pulse comme une respiration
    underLight.intensity = 2.5 + Math.sin(time * 1.5) * 1.5;
  } else if (currentMode === 'ambient') {
    // pulsation douce des lumieres ambiantes
    ambientMain.intensity = 2.5 + Math.sin(time * 1.5) * 1.0;
    ambientFill.intensity = 1.0 + Math.sin(time * 2.5) * 0.5;
  } else if (currentMode === 'directional') {
    // la lumiere directionnelle orbite lentement
    dirLight.position.x = Math.sin(time * 0.5) * 5;
    dirLight.position.z = Math.cos(time * 0.5) * 5;
    dirLight.intensity = 3.5 + Math.sin(time * 3) * 1.0;
    dirBackLight.intensity = 1.5 + Math.sin(time * 4) * 0.8;
    dirRimLight.intensity = 1.0 + Math.sin(time * 6) * 0.5;
  } else if (currentMode === 'spot') {
    // le spot bouge et change d'ouverture (effet stroboscopique)
    spotMain.angle = Math.PI / 6 + Math.sin(time * 2) * 0.1;
    spotMain.intensity = 6 + Math.sin(time * 8) * 3;
    spotMain.position.x = Math.sin(time * 0.3) * 2;
    spotBack.intensity = 4 + Math.sin(time * 5) * 2;
    spotFloor.intensity = 3 + Math.sin(time * 1.5) * 2;
  } else if (currentMode === 'hemisphere') {
    // hemisphere pulse doucement, accent rouge orbite
    hemiLight.intensity = 2.5 + Math.sin(time * 1.8) * 1.0;
    hemiAccent.intensity = 1.5 + Math.sin(time * 4) * 1.0;
    hemiAccent.position.x = Math.sin(time * 0.8) * 3;
    hemiAccent.position.z = Math.cos(time * 0.8) * 3;
  }

  // --- geometries flottantes : orbitent autour du demon et tournent sur elles-memes ---
  floatingGeos.forEach((mesh, i) => {
    const orbitRadius = 4.5;                                    // rayon de l'orbite
    const angle = (i / floatingGeos.length) * Math.PI * 2;     // reparties a 60 degres d'ecart
    const speed = 0.2;                                          // vitesse de l'orbite
    mesh.position.x = Math.cos(time * speed + angle) * orbitRadius;
    mesh.position.z = Math.sin(time * speed + angle) * orbitRadius;
    mesh.position.y = Math.sin(time * 1.5 + i * 1.2) * 0.8;   // mouvement vertical sinusoidal
    mesh.rotation.x += 0.015;                                   // rotation sur soi-meme axe X
    mesh.rotation.y += 0.02;                                    // rotation sur soi-meme axe Y
    // pulsation de l'emissive
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.5 + Math.sin(time * 3 + i) * 0.5;
  });

  // --- pulsation des yeux du demon ---
  const eyeIntensity = 1.2 + Math.sin(time * 3) * 0.8;
  eyeMat.emissiveIntensity = eyeIntensity;

  // --- pulsation et rotation du pentagramme ---
  pentaRingMat.emissiveIntensity = 1.0 + Math.sin(time * 2) * 0.8;
  pentaRingMat.opacity = 0.2 + Math.sin(time * 2) * 0.15;
  pentaRing.rotation.z += 0.002;       // tourne lentement dans un sens
  pentaRingInner.rotation.z -= 0.003;  // tourne dans l'autre sens

  // --- les particules de feu montent et se recyclent ---
  const positions = particleGeo.attributes.position.array as Float32Array;
  for (let i = 0; i < particleCount; i++) {
    positions[i * 3 + 1] += particleSpeeds[i] * 0.01; // monte
    if (positions[i * 3 + 1] > 6) {
      // quand une particule sort par le haut, elle reapparait en bas a une position aleatoire
      positions[i * 3 + 1] = -6;
      positions[i * 3] = (Math.random() - 0.5) * 12;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 12;
    }
  }
  particleGeo.attributes.position.needsUpdate = true; // dit a Three.js de mettre a jour le GPU

  // scintillement de l'opacite des particules
  particleMat.opacity = 0.5 + Math.sin(time * 8) * 0.3;

  // --- animation des colonnes de feu (taille, opacite, intensite) ---
  flameColumns.forEach((flame, i) => {
    const offset = i * 1.2; // decalage pour que chaque flamme bouge differemment
    flame.scale.y = 0.8 + Math.sin(time * 6 + offset) * 0.4 + Math.sin(time * 10 + offset) * 0.2;
    flame.scale.x = 0.8 + Math.sin(time * 5 + offset) * 0.2;
    flame.scale.z = flame.scale.x;
    flame.position.y = -1.8 + flame.scale.y * 0.4; // la flamme monte quand elle grandit
    const mat = flame.material as THREE.MeshStandardMaterial;
    mat.opacity = 0.4 + Math.sin(time * 8 + offset) * 0.25;
    mat.emissiveIntensity = 1.5 + Math.sin(time * 7 + offset) * 1.0;
  });

  // --- pulsation des fissures de lave ---
  cracks.forEach((crack, i) => {
    const mat = crack.material as THREE.LineBasicMaterial;
    mat.opacity = 0.3 + Math.sin(time * 2 + i * 0.8) * 0.4;
  });

  // --- respiration du sol de lave ---
  lavaMat.emissiveIntensity = 0.5 + Math.sin(time * 1.2) * 0.4;

  // --- la fumee monte lentement avec un leger mouvement lateral ---
  const smokePos = smokeGeo.attributes.position.array as Float32Array;
  for (let i = 0; i < smokeCount; i++) {
    smokePos[i * 3 + 1] += smokeSpeeds[i] * 0.008;       // monte
    smokePos[i * 3] += Math.sin(time + i) * 0.002;        // leger mouvement lateral
    if (smokePos[i * 3 + 1] > 5) {
      // recyclage : reapparait au sol
      smokePos[i * 3 + 1] = -2.5;
      smokePos[i * 3] = (Math.random() - 0.5) * 10;
      smokePos[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
  }
  smokeGeo.attributes.position.needsUpdate = true;
  smokeMat.opacity = 0.25 + Math.sin(time * 3) * 0.15;

  // --- les cranes orbitent autour du demon et le regardent ---
  skulls.forEach((skull, i) => {
    const orbitRadius = 3.5 + i * 0.5;   // chaque crane a un rayon different
    const orbitSpeed = 0.3 + i * 0.08;   // et une vitesse differente
    const orbitY = Math.sin(time * 0.8 + i * 2) * 1.5; // mouvement vertical sinusoidal
    skull.position.x = Math.cos(time * orbitSpeed + i * 1.25) * orbitRadius;
    skull.position.z = Math.sin(time * orbitSpeed + i * 1.25) * orbitRadius;
    skull.position.y = orbitY;
    skull.lookAt(demon.position); // le crane regarde toujours le demon
    skull.rotation.z = Math.sin(time * 2 + i) * 0.2; // leger balancement
  });

  // --- eclairs aleatoires (0.5% de chance par frame) ---
  if (Math.random() < 0.005) {
    lightningLight.intensity = 15 + Math.random() * 10; // flash intense
  } else {
    lightningLight.intensity *= 0.85; // decroissance rapide apres le flash
  }

  // --- animation de la lune Soul Eater ---
  moonGlow.intensity = 1.5 + Math.sin(time * 0.5) * 0.5;
  soulMoon.rotation.y = Math.sin(time * 0.3) * 0.1;

  // animation cascade de sang
  if (soulMoon.userData.bloodStreams) {
    const streams = soulMoon.userData.bloodStreams as THREE.Mesh[];
    streams.forEach((s, i) => {
      const mat = s.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.7 + Math.sin(time * 2 + i * 1.3) * 0.15;
    });

    const dripsList = soulMoon.userData.bloodDrips as THREE.Mesh[];
    dripsList.forEach((d, i) => {
      d.position.y -= 0.015 + Math.random() * 0.01;
      d.position.x += Math.sin(time * 3 + i) * 0.002;
      if (d.position.y < -24.65) {
        d.position.y = 0.35;
        d.position.x = (Math.random() - 0.5) * 1.2;
      }
    });
  }

  // mise a jour des controles orbitaux
  controls.update();

  // rendu final de la frame
  renderer.render(scene, camera);
}

// lance la boucle d'animation
animate();

// ============================================================
// RESIZE - adapte la scene quand la fenetre change de taille
// ============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix(); // recalcule la matrice de projection
  renderer.setSize(window.innerWidth, window.innerHeight);
});
