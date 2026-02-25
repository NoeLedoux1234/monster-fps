import * as THREE from 'three'
import Peer from 'peerjs'
import type { DataConnection } from 'peerjs'
import './style.css'

// =============================================================
//  NETWORK TYPES
// =============================================================
type GameMode = 'solo' | 'host' | 'guest'

interface NetState {
  type: 'state'
  x: number; z: number; y: number; angle: number; pitch: number
  hp: number; weaponLevel: number; ammo: number
  isReloading: boolean; isCrouching: boolean; isDead: boolean
}

interface NetShoot {
  type: 'shoot'
  originX: number; originY: number; originZ: number
  dirX: number; dirY: number; dirZ: number
  weapon: number
}

interface NetHit {
  type: 'hit'
  damage: number
  weaponLevel: number
}

interface NetKill {
  type: 'kill'
  killerWeaponLevel: number
}

interface NetRestart {
  type: 'restart'
}

type NetMessage = NetState | NetShoot | NetHit | NetKill | NetRestart

let peer: Peer | null = null
let conn: DataConnection | null = null
let isMultiplayer = false
let remoteState: NetState | null = null
let netSendTimer = 0
let gameStarted = false

// --- Scene (horror) ---
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x020206)
scene.fog = new THREE.Fog(0x020206, 6, 32)

scene.add(new THREE.AmbientLight(0x0a0a18, 0.08))

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
document.getElementById('app')!.appendChild(renderer.domElement)

// =============================================================
//  WEAPONS
// =============================================================
interface WeaponDef {
  name: string
  damage: number
  cooldown: number
  magSize: number
  reloadTime: number
  auto: boolean
  range: number
  recoil: number
  bulletSpeed: number
  melee: boolean
  color: number
}

const WEAPONS: WeaponDef[] = [
  {
    name: 'AK-47',
    damage: 28, cooldown: 0.1, magSize: 30, reloadTime: 2.5,
    auto: true, range: 80, recoil: 0.03, bulletSpeed: 120, melee: false, color: 0x8B6914
  },
  {
    name: 'DMR',
    damage: 42, cooldown: 0.22, magSize: 15, reloadTime: 2.0,
    auto: false, range: 100, recoil: 0.015, bulletSpeed: 160, melee: false, color: 0x556B2F
  },
  {
    name: 'Glock-18',
    damage: 18, cooldown: 0.08, magSize: 20, reloadTime: 1.5,
    auto: true, range: 45, recoil: 0.04, bulletSpeed: 80, melee: false, color: 0x2F2F2F
  },
  {
    name: 'Desert Eagle',
    damage: 78, cooldown: 0.7, magSize: 7, reloadTime: 2.5,
    auto: false, range: 70, recoil: 0.02, bulletSpeed: 130, melee: false, color: 0xC0C0C0
  },
  {
    name: 'Couteau',
    damage: 55, cooldown: 0.5, magSize: 0, reloadTime: 0,
    auto: false, range: 3.5, recoil: 0, bulletSpeed: 0, melee: true, color: 0xA0A0A0
  },
  {
    name: 'RPG-7',
    damage: 150, cooldown: 1.5, magSize: 1, reloadTime: 3.0,
    auto: false, range: 100, recoil: 0.06, bulletSpeed: 40, melee: false, color: 0x4a5a2a
  },
]

// =============================================================
//  PHYSICS
// =============================================================
const ACCEL = 96
const FRICTION = 12
const MAX_SPEED = 8
const CROUCH_SPEED_MULT = 0.5
const JUMP_FORCE = 7.0
const GRAVITY = -18.0
const STAND_HEIGHT = 1.5
const CROUCH_HEIGHT = 0.9
const CROUCH_TRANSITION = 8.0
const MAX_PITCH = Math.PI / 3
let mouseSensitivity = 0.002
let gamePaused = false

const settings = { masterVolume: 0.5 }
const HEADSHOT_MULT = 2.0
const BODY_MULT = 1.0
const LEG_MULT = 0.65
const BULLET_DROP = 12
const BULLET_MAX_AGE = 3

// =============================================================
//  MAP
// =============================================================
const ARENA_W = 60
const ARENA_D = 40
const halfW = ARENA_W / 2
const halfD = ARENA_D / 2
const WH = 4

const wallMeshes: THREE.Mesh[] = []
interface Box { min: THREE.Vector2; max: THREE.Vector2 }
const obstacles: Box[] = []

// --- Procedural textures ---
function makeTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  return t
}

const brickTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#a0623a'
  ctx.fillRect(0, 0, 128, 128)
  for (let row = 0; row < 8; row++) {
    const y = row * 16
    ctx.fillStyle = '#7a4a2a'
    ctx.fillRect(0, y, 128, 2)
    const off = (row % 2) * 32
    for (let x = off; x < 128; x += 64) ctx.fillRect(x, y, 2, 16)
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(${100 + Math.random() * 80},${40 + Math.random() * 40},${20 + Math.random() * 30},0.2)`
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2)
  }
})

const concreteTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#888888'
  ctx.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 500; i++) {
    const g = 100 + Math.random() * 60
    ctx.fillStyle = `rgba(${g},${g},${g},0.12)`
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 3, 1 + Math.random() * 3)
  }
  ctx.strokeStyle = 'rgba(60,60,60,0.15)'
  for (let i = 0; i < 3; i++) {
    ctx.beginPath()
    ctx.moveTo(Math.random() * 128, Math.random() * 128)
    ctx.lineTo(Math.random() * 128, Math.random() * 128)
    ctx.stroke()
  }
})

const woodTex = makeTex(64, 64, ctx => {
  ctx.fillStyle = '#a08060'
  ctx.fillRect(0, 0, 64, 64)
  for (let y = 0; y < 64; y += 3) {
    ctx.fillStyle = `rgba(${80 + Math.random() * 40},${50 + Math.random() * 30},${30 + Math.random() * 20},0.25)`
    ctx.fillRect(0, y, 64, 2)
  }
})

const metalTex = makeTex(64, 64, ctx => {
  ctx.fillStyle = '#5a6a7a'
  ctx.fillRect(0, 0, 64, 64)
  for (let y = 0; y < 64; y += 6) {
    ctx.fillStyle = 'rgba(100,120,140,0.15)'
    ctx.fillRect(0, y, 64, 1)
  }
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgba(${150 + Math.random() * 60},${150 + Math.random() * 60},${160 + Math.random() * 60},0.1)`
    ctx.fillRect(Math.random() * 64, Math.random() * 64, 1, 1)
  }
})

const floorTex = makeTex(256, 256, ctx => {
  ctx.fillStyle = '#4a4a42'
  ctx.fillRect(0, 0, 256, 256)
  ctx.strokeStyle = 'rgba(60,60,55,0.4)'
  ctx.lineWidth = 1
  for (let x = 0; x <= 256; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke() }
  for (let y = 0; y <= 256; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke() }
  for (let i = 0; i < 800; i++) {
    const g = 50 + Math.random() * 40
    ctx.fillStyle = `rgba(${g},${g},${g - 5},0.08)`
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2)
  }
})
floorTex.repeat.set(4, 3)

const sandTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#b8a88a'
  ctx.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 600; i++) {
    const g = 150 + Math.random() * 50
    ctx.fillStyle = `rgba(${g},${g - 15},${g - 35},0.12)`
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1)
  }
})
sandTex.repeat.set(4, 3)

const matConcrete  = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xaaaaaa })
const matConcreteD = new THREE.MeshStandardMaterial({ map: concreteTex, color: 0x777777 })
const matBrick     = new THREE.MeshStandardMaterial({ map: brickTex })
const matMetal     = new THREE.MeshStandardMaterial({ map: metalTex, metalness: 0.3, roughness: 0.7 })
const matCrate     = new THREE.MeshStandardMaterial({ map: woodTex, color: 0xd4a860 })
const matGreen     = new THREE.MeshStandardMaterial({ color: 0x3d6b1f, roughness: 0.9 })
const matRed       = new THREE.MeshStandardMaterial({ color: 0xaa2222, roughness: 0.8 })
const matBlue      = new THREE.MeshStandardMaterial({ color: 0x1a4a8a, roughness: 0.8 })
const matSand      = new THREE.MeshStandardMaterial({ map: sandTex })
const matDarkFloor = new THREE.MeshStandardMaterial({ map: floorTex })

const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_D), matSand)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)

function floorZone(w: number, d: number, x: number, z: number, mat: THREE.Material) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
  m.rotation.x = -Math.PI / 2
  m.position.set(x, 0.01, z)
  m.receiveShadow = true
  scene.add(m)
}
floorZone(18, 16, -21, -8, matDarkFloor)
floorZone(18, 16, 21, 8, matDarkFloor)
floorZone(8, 14, 0, 0, matDarkFloor)

function wall(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  scene.add(mesh)
  wallMeshes.push(mesh)
  obstacles.push({
    min: new THREE.Vector2(x - w / 2 - 0.3, z - d / 2 - 0.3),
    max: new THREE.Vector2(x + w / 2 + 0.3, z + d / 2 + 0.3)
  })
}

function crate(x: number, z: number, size = 1.5) {
  wall(size, size, size, x, size / 2, z, matCrate)
}

function doubleCrate(x: number, z: number) {
  wall(1.5, 1.5, 1.5, x, 0.75, z, matCrate)
  wall(1.5, 1.5, 1.5, x, 2.25, z, matCrate)
}

function barrel(x: number, z: number) {
  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 8)
  const mesh = new THREE.Mesh(geo, matMetal)
  mesh.position.set(x, 0.6, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  scene.add(mesh)
  wallMeshes.push(mesh)
  obstacles.push({ min: new THREE.Vector2(x - 0.8, z - 0.8), max: new THREE.Vector2(x + 0.8, z + 0.8) })
}

// --- Decorative props (no collision) ---
const flickerLights: THREE.PointLight[] = []
const flickerBulbs: THREE.Mesh[] = []

function streetLight(x: number, z: number) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 4.5, 6), matMetal)
  pole.position.set(x, 2.25, z); scene.add(pole)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.04), matMetal)
  arm.position.set(x + 0.5, 4.4, z); scene.add(arm)
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.8 }))
  bulb.position.set(x + 1.1, 4.3, z); scene.add(bulb)
  flickerBulbs.push(bulb)
  const pl = new THREE.PointLight(0xff3311, 0.25, 10)
  pl.position.set(x + 1, 4.2, z); scene.add(pl)
  flickerLights.push(pl)
}

function trafficCone(x: number, z: number) {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0xff6600 }))
  cone.position.set(x, 0.175, z); scene.add(cone)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }))
  band.position.set(x, 0.22, z); scene.add(band)
}

function tireStack(x: number, z: number, count = 3) {
  for (let i = 0; i < count; i++) {
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.1, 8, 12), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }))
    tire.position.set(x, 0.28 + i * 0.22, z)
    tire.rotation.x = Math.PI / 2
    scene.add(tire)
  }
}

function sandbags(x: number, z: number, rotY = 0) {
  const sb = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.7, 0.7), new THREE.MeshStandardMaterial({ color: 0x9e8b6e, roughness: 1 }))
  sb.position.set(x, 0.35, z); sb.rotation.y = rotY; scene.add(sb)
  wallMeshes.push(sb)
  const isRot = Math.abs(rotY) > 0.1
  const hw = isRot ? 0.65 : 1.55
  const hd = isRot ? 1.55 : 0.65
  obstacles.push({ min: new THREE.Vector2(x - hw, z - hd), max: new THREE.Vector2(x + hw, z + hd) })
}

// === PERIMETER ===
wall(ARENA_W, WH, 0.5, 0, WH / 2, -halfD, matConcrete)
wall(ARENA_W, WH, 0.5, 0, WH / 2, halfD, matConcrete)
wall(0.5, WH, ARENA_D, -halfW, WH / 2, 0, matConcrete)
wall(0.5, WH, ARENA_D, halfW, WH / 2, 0, matConcrete)

// === SITE A (Northwest) ===
wall(16, WH, 0.5, -22, WH / 2, -1, matBrick)
wall(16, WH, 0.5, -22, WH / 2, -15, matBrick)
wall(0.5, WH, 5, -14, WH / 2, -3.5, matBrick)
wall(0.5, WH, 5, -14, WH / 2, -12.5, matBrick)
crate(-24, -12); crate(-22, -5)
doubleCrate(-18, -10)
wall(4, 1.5, 0.5, -16, 0.75, -8, matMetal)
barrel(-26, -8); barrel(-12, -3)

// === SITE B (Southeast) ===
wall(16, WH, 0.5, 22, WH / 2, 1, matBrick)
wall(16, WH, 0.5, 22, WH / 2, 15, matBrick)
wall(0.5, WH, 5, 14, WH / 2, 3.5, matBrick)
wall(0.5, WH, 5, 14, WH / 2, 12.5, matBrick)
crate(24, 12); crate(22, 5)
doubleCrate(18, 10)
wall(4, 1.5, 0.5, 16, 0.75, 8, matMetal)
barrel(26, 8); barrel(12, 3)

// === MID CORRIDOR ===
wall(0.5, WH, 7, -3, WH / 2, -3.5, matConcreteD)
wall(0.5, WH, 7, 3, WH / 2, 3.5, matConcreteD)
wall(0.5, WH, 3, -3, WH / 2, 5.5, matConcreteD)
wall(0.5, WH, 3, 3, WH / 2, -5.5, matConcreteD)
crate(0, 0)
wall(2, 1, 0.5, -1, 0.5, 3, matMetal)

// === CONNECTORS ===
wall(8, WH, 0.5, -6, WH / 2, -15, matConcreteD)
wall(0.5, WH, 5, -2, WH / 2, -12.5, matConcreteD)
wall(8, WH, 0.5, 6, WH / 2, 15, matConcreteD)
wall(0.5, WH, 5, 2, WH / 2, 12.5, matConcreteD)

// === CONTAINERS ===
wall(5, 2.8, 2.5, -20, 1.4, 8, matBlue)
wall(5, 2.8, 2.5, 20, 1.4, -8, matRed)
wall(2.5, 2.8, 5, -5, 1.4, 12, matGreen)
wall(2.5, 2.8, 5, 5, 1.4, -12, matGreen)

// === LOW WALLS ===
wall(5, 1.2, 0.5, -12, 0.6, 10, matConcrete)
wall(0.5, 1.2, 5, 12, 0.6, -10, matConcrete)
wall(4, 1.2, 0.5, 8, 0.6, -16, matConcrete)
wall(0.5, 1.2, 4, -8, 0.6, 16, matConcrete)

// === PILLARS ===
wall(0.5, WH, 0.5, -4, WH / 2, -8, matConcreteD)
wall(0.5, WH, 0.5, 4, WH / 2, 8, matConcreteD)

// === BARRELS ===
barrel(-16, 5); barrel(16, -5)
barrel(-27, 14); barrel(27, -14)
barrel(-7, -17); barrel(7, 17)

// === SCATTERED CRATES ===
crate(-25, 15); crate(25, -15)
crate(-8, 10); crate(8, -10)
crate(0, -16, 2); crate(0, 16, 2)

// === SANDBAGS ===
sandbags(-14, 3)
sandbags(14, -3)
sandbags(-6, -11, Math.PI / 2)
sandbags(6, 11, Math.PI / 2)

// === DECORATIVE PROPS ===
streetLight(-25, -17)
streetLight(25, 17)
streetLight(-25, 17)
streetLight(25, -17)

trafficCone(-9, -2); trafficCone(9, 2)
trafficCone(-22, 13); trafficCone(22, -13)
trafficCone(15, 16); trafficCone(-15, -16)

tireStack(-28, 0)
tireStack(28, 0)
tireStack(-5, -18, 2)
tireStack(5, 18, 4)

// =============================================================
//  AVATAR
// =============================================================
const originalColors = new Map<THREE.MeshStandardMaterial, number>()

function createAvatar(color: number, layerNum: number) {
  const group = new THREE.Group()
  const darkSkin = 0x4a3a2a
  const fleshRot = 0x6b4a3a
  function skin() { const m = new THREE.MeshStandardMaterial({ color: darkSkin, roughness: 0.95 }); originalColors.set(m, darkSkin); return m }
  function body() { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 }); originalColors.set(m, color); return m }
  function legMat() { const m = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 }); originalColors.set(m, 0x1a1a1a); return m }

  // --- Monstrous head ---
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.45), skin())
  head.position.y = 1.52; head.name = 'head'; group.add(head)

  // Glowing eyes
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff1100 })
  const eyeGeo = new THREE.SphereGeometry(0.06, 6, 6)
  const lEye = new THREE.Mesh(eyeGeo, eyeMat); lEye.position.set(-0.12, 1.56, -0.2); group.add(lEye)
  const rEye = new THREE.Mesh(eyeGeo, eyeMat); rEye.position.set(0.12, 1.56, -0.2); group.add(rEye)

  // Eye glow light
  const eyeGlow = new THREE.PointLight(0xff1100, 0.3, 3)
  eyeGlow.position.set(0, 1.56, -0.25); group.add(eyeGlow)

  // Jaw / mouth
  const jawMat = new THREE.MeshStandardMaterial({ color: 0x220000, roughness: 1 })
  originalColors.set(jawMat, 0x220000)
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.12), jawMat)
  jaw.position.set(0, 1.28, -0.18); group.add(jaw)

  // Teeth (jagged)
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xcccc88, roughness: 0.5 })
  originalColors.set(toothMat, 0xcccc88)
  for (let i = -2; i <= 2; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 4), toothMat)
    tooth.position.set(i * 0.06, 1.3, -0.22)
    tooth.rotation.x = Math.PI
    group.add(tooth)
  }

  // Horns
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.7 })
  originalColors.set(hornMat, 0x2a1a0a)
  const lHorn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.25, 6), hornMat)
  lHorn.position.set(-0.2, 1.82, -0.05); lHorn.rotation.z = 0.3; group.add(lHorn)
  const rHorn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.25, 6), hornMat)
  rHorn.position.set(0.2, 1.82, -0.05); rHorn.rotation.z = -0.3; group.add(rHorn)

  // --- Grotesque torso ---
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.35), body())
  torso.position.y = 1.05; torso.name = 'torso'; group.add(torso)

  // Exposed ribs
  const ribMat = new THREE.MeshStandardMaterial({ color: fleshRot, roughness: 1 })
  originalColors.set(ribMat, fleshRot)
  for (let i = 0; i < 3; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.08), ribMat)
    rib.position.set(0, 0.9 + i * 0.12, -0.18)
    group.add(rib)
  }

  // Spine bumps (back)
  const spineMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 })
  originalColors.set(spineMat, 0x3a2a1a)
  for (let i = 0; i < 4; i++) {
    const bump = new THREE.Mesh(new THREE.SphereGeometry(0.04, 4, 4), spineMat)
    bump.position.set(0, 0.85 + i * 0.1, 0.19)
    group.add(bump)
  }

  // --- Arms (elongated, claw-like) ---
  const armGeo = new THREE.BoxGeometry(0.16, 0.6, 0.18)
  const lArm = new THREE.Mesh(armGeo, skin()); lArm.position.set(-0.36, 1.0, 0); lArm.name = 'arm'; group.add(lArm)
  const rArm = new THREE.Mesh(armGeo, skin()); rArm.position.set(0.36, 1.0, 0); rArm.name = 'arm'; group.add(rArm)

  // Claws
  const clawMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 })
  originalColors.set(clawMat, 0x1a1a1a)
  for (const side of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.015, 0.1, 4), clawMat)
      claw.position.set(side * 0.36 + i * 0.04, 0.65, -0.06)
      claw.rotation.x = 0.3
      group.add(claw)
    }
  }

  // --- Legs (bulky, monster-like) ---
  const legGeo = new THREE.BoxGeometry(0.22, 0.55, 0.28)
  const lLeg = new THREE.Mesh(legGeo, legMat()); lLeg.position.set(-0.14, 0.48, 0); lLeg.name = 'leg'; group.add(lLeg)
  const rLeg = new THREE.Mesh(legGeo, legMat()); rLeg.position.set(0.14, 0.48, 0); rLeg.name = 'leg'; group.add(rLeg)

  group.traverse(obj => {
    obj.layers.set(layerNum)
    if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true }
  })
  scene.add(group)
  return group
}

const p1Body = createAvatar(0x3498db, 1)
const p2Body = createAvatar(0xe74c3c, 2)

// --- Cameras ---
const camera1 = new THREE.PerspectiveCamera(80, 1, 0.1, 200)
camera1.layers.enable(0); camera1.layers.enable(2); camera1.layers.enable(3)
// camera2 kept for bot raycasting (not rendered)
const camera2 = new THREE.PerspectiveCamera(80, 1, 0.1, 200)
camera2.layers.enable(0); camera2.layers.enable(1); camera2.layers.enable(4)

// --- Viewmodel ---
const skinMaterial = () => new THREE.MeshStandardMaterial({ color: 0xf5cba7 })

function buildAK47() {
  const g = new THREE.Group()
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.35), new THREE.MeshStandardMaterial({ color: 0x5c4033 }))
  g.add(receiver)
  const brl = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.35), new THREE.MeshStandardMaterial({ color: 0x3a3a3a }))
  brl.position.set(0, 0.01, -0.33)
  g.add(brl)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.06), new THREE.MeshStandardMaterial({ color: 0x8B6914 }))
  mag.position.set(0, -0.1, -0.05); mag.rotation.x = 0.2
  g.add(mag)
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.2), new THREE.MeshStandardMaterial({ color: 0x8B6914 }))
  stock.position.set(0, -0.02, 0.26)
  g.add(stock)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.04), new THREE.MeshStandardMaterial({ color: 0x5c4033 }))
  grip.position.set(0, -0.09, 0.1)
  g.add(grip)
  const fSight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.015), new THREE.MeshStandardMaterial({ color: 0x222222 }))
  fSight.position.set(0, 0.05, -0.45)
  g.add(fSight)
  return g
}

function buildDMR() {
  const g = new THREE.Group()
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.4), new THREE.MeshStandardMaterial({ color: 0x556B2F }))
  g.add(receiver)
  const brl = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.4), new THREE.MeshStandardMaterial({ color: 0x2a2a2a }))
  brl.position.set(0, 0.01, -0.38)
  g.add(brl)
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }))
  scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.06, -0.1)
  g.add(scope)
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.005, 8), new THREE.MeshStandardMaterial({ color: 0x4488ff, emissive: 0x2244aa }))
  lens.rotation.x = Math.PI / 2; lens.position.set(0, 0.06, -0.175)
  g.add(lens)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0x444444 }))
  mag.position.set(0, -0.08, 0)
  g.add(mag)
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.07, 0.22), new THREE.MeshStandardMaterial({ color: 0x3d5229 }))
  stock.position.set(0, -0.01, 0.3)
  g.add(stock)
  const leg1 = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.08, 0.01), new THREE.MeshStandardMaterial({ color: 0x333333 }))
  leg1.position.set(-0.03, -0.07, -0.3); leg1.rotation.x = 0.3
  g.add(leg1)
  const leg2 = leg1.clone(); leg2.position.x = 0.03
  g.add(leg2)
  return g
}

function buildGlock() {
  const g = new THREE.Group()
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.18), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }))
  slide.position.y = 0.01
  g.add(slide)
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.04, 0.14), new THREE.MeshStandardMaterial({ color: 0x2c2c2c }))
  frame.position.set(0, -0.025, 0.02)
  g.add(frame)
  const brl = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.06), new THREE.MeshStandardMaterial({ color: 0x333333 }))
  brl.position.set(0, 0.01, -0.12)
  g.add(brl)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.12, 0.05), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }))
  grip.position.set(0, -0.1, 0.05); grip.rotation.x = 0.15
  g.add(grip)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.08, 0.035), new THREE.MeshStandardMaterial({ color: 0x222222 }))
  mag.position.set(0, -0.14, 0.04)
  g.add(mag)
  const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.015, 0.01), new THREE.MeshStandardMaterial({ color: 0x111111 }))
  rSight.position.set(0, 0.04, 0.03)
  g.add(rSight)
  return g
}

function buildDeagle() {
  const g = new THREE.Group()
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.24), new THREE.MeshStandardMaterial({ color: 0xb0b0b0, metalness: 0.8, roughness: 0.2 }))
  slide.position.y = 0.01
  g.add(slide)
  const brl = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.1), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9 }))
  brl.position.set(0, 0.01, -0.16)
  g.add(brl)
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.03, 8), new THREE.MeshStandardMaterial({ color: 0x666666 }))
  muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.01, -0.22)
  g.add(muzzle)
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, 0.18), new THREE.MeshStandardMaterial({ color: 0x888888 }))
  frame.position.set(0, -0.03, 0.03)
  g.add(frame)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.055), new THREE.MeshStandardMaterial({ color: 0x222222 }))
  grip.position.set(0, -0.12, 0.07); grip.rotation.x = 0.2
  g.add(grip)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.04), new THREE.MeshStandardMaterial({ color: 0x777777 }))
  mag.position.set(0, -0.16, 0.05)
  g.add(mag)
  const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.015), new THREE.MeshStandardMaterial({ color: 0x444444 }))
  rSight.position.set(0, 0.05, 0.05)
  g.add(rSight)
  return g
}

function buildKnife() {
  const g = new THREE.Group()
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.28), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.15 }))
  blade.position.set(0, 0.01, -0.18)
  g.add(blade)
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.025, 0.06), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9 }))
  tip.position.set(0, 0.005, -0.34); tip.rotation.x = 0.15
  g.add(tip)
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x555555 }))
  guard.position.set(0, 0, -0.03)
  g.add(guard)
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.12), new THREE.MeshStandardMaterial({ color: 0x3e2723 }))
  handle.position.set(0, -0.01, 0.04)
  g.add(handle)
  const pommel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.02), new THREE.MeshStandardMaterial({ color: 0x555555 }))
  pommel.position.set(0, -0.01, 0.1)
  g.add(pommel)
  return g
}

function buildRPG() {
  const g = new THREE.Group()
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x4a5a2a }))
  tube.rotation.x = Math.PI / 2; g.add(tube)
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0x3a4a1a }))
  flare.rotation.x = Math.PI / 2; flare.position.z = -0.34; g.add(flare)
  const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.06, 8), new THREE.MeshStandardMaterial({ color: 0x3a4a1a }))
  rear.rotation.x = Math.PI / 2; rear.position.z = 0.33; g.add(rear)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0x3e2723 }))
  grip.position.set(0, -0.1, 0.05); g.add(grip)
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.06), new THREE.MeshStandardMaterial({ color: 0x333333 }))
  guard.position.set(0, -0.06, 0.05); g.add(guard)
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.015), new THREE.MeshStandardMaterial({ color: 0x222222 }))
  sight.position.set(0, 0.06, -0.1); g.add(sight)
  const warhead = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 8), new THREE.MeshStandardMaterial({ color: 0x6a6a5a }))
  warhead.rotation.x = -Math.PI / 2; warhead.position.z = -0.44; g.add(warhead)
  return g
}

const weaponBuilders = [buildAK47, buildDMR, buildGlock, buildDeagle, buildKnife, buildRPG]

function createViewmodel(layerNum: number, cam: THREE.PerspectiveCamera) {
  const container = new THREE.Group()
  container.name = 'vmContainer'

  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.15), skinMaterial())
  hand.position.set(0, -0.08, 0.12); hand.name = 'hand'
  container.add(hand)

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), skinMaterial())
  arm.position.set(0, -0.1, 0.3); arm.name = 'arm'
  container.add(arm)

  const weaponSlot = new THREE.Group()
  weaponSlot.name = 'weaponSlot'
  container.add(weaponSlot)

  container.position.set(0.25, -0.22, -0.4)
  container.traverse(obj => obj.layers.set(layerNum))
  cam.add(container)

  const vmLight = new THREE.PointLight(0xffffff, 0.8, 3)
  vmLight.position.set(0.2, 0, -0.3)
  vmLight.layers.set(layerNum)
  cam.add(vmLight)

  container.userData.layerNum = layerNum
  return container
}

scene.add(camera1); scene.add(camera2)

// Flashlight (horror mode)
const flashlight = new THREE.SpotLight(0xddeeff, 5, 22, 0.45, 0.35, 1.2)
flashlight.position.set(0, 0, 0)
flashlight.castShadow = true
flashlight.shadow.mapSize.set(1024, 1024)
flashlight.shadow.camera.near = 0.3
flashlight.shadow.camera.far = 22
const flashTarget = new THREE.Object3D()
flashTarget.position.set(0, -0.1, -1)
camera1.add(flashlight)
camera1.add(flashTarget)
flashlight.target = flashTarget

const vm1 = createViewmodel(3, camera1)
const vm2 = createViewmodel(4, camera2)

function updateViewmodelForWeapon(vm: THREE.Group, weapon: WeaponDef) {
  const slot = vm.getObjectByName('weaponSlot') as THREE.Group
  const layerNum = vm.userData.layerNum as number

  while (slot.children.length > 0) {
    slot.remove(slot.children[0])
  }

  const idx = WEAPONS.indexOf(weapon)
  const model = weaponBuilders[idx]()
  slot.add(model)
  slot.traverse(obj => obj.layers.set(layerNum))
}

// =============================================================
//  PLAYERS
// =============================================================
interface PlayerState {
  x: number; z: number; angle: number
  hp: number; isDead: boolean
  weaponLevel: number
  ammo: number
  isReloading: boolean
  reloadTimer: number
  fireCooldown: number
  body: THREE.Group
  camera: THREE.PerspectiveCamera
  viewmodel: THREE.Group
  firedThisPress: boolean
  vx: number; vz: number
  y: number; vy: number
  isGrounded: boolean
  landPenalty: number
  isCrouching: boolean
  crouchLerp: number
  pitch: number
  smoothedSpeed: number
}

interface Projectile {
  mesh: THREE.Mesh
  position: THREE.Vector3
  velocity: THREE.Vector3
  owner: PlayerState
  target: PlayerState
  weapon: WeaponDef
  age: number
}
const projectiles: Projectile[] = []

const SPAWN_POINTS = [
  { x: -20, z: -17, angle: Math.PI / 4 },
  { x: 20, z: 17, angle: -Math.PI * 3 / 4 },
  { x: -25, z: 5, angle: 0 },
  { x: 25, z: -5, angle: Math.PI },
  { x: 0, z: -18, angle: Math.PI / 2 },
  { x: 0, z: 18, angle: -Math.PI / 2 },
  { x: -15, z: -10, angle: 0 },
  { x: 15, z: 10, angle: Math.PI },
]

function randomSpawn(other?: PlayerState) {
  let best = SPAWN_POINTS[0]
  let bestDist = 0
  for (const sp of SPAWN_POINTS) {
    if (other) {
      const d = Math.hypot(sp.x - other.x, sp.z - other.z)
      if (d > bestDist) { bestDist = d; best = sp }
    } else {
      best = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)]
      break
    }
  }
  return best
}

function makePlayer(body: THREE.Group, cam: THREE.PerspectiveCamera, vm: THREE.Group): PlayerState {
  const sp = SPAWN_POINTS[0]
  return {
    x: sp.x, z: sp.z, angle: sp.angle,
    hp: 100, isDead: false,
    weaponLevel: 0, ammo: WEAPONS[0].magSize,
    isReloading: false, reloadTimer: 0, fireCooldown: 0,
    body, camera: cam, viewmodel: vm,
    firedThisPress: false,
    vx: 0, vz: 0,
    y: 0, vy: 0, isGrounded: true, landPenalty: 0,
    isCrouching: false, crouchLerp: 0,
    pitch: 0,
    smoothedSpeed: 0
  }
}

const player1 = makePlayer(p1Body, camera1, vm1)
const player2 = makePlayer(p2Body, camera2, vm2) // bot

const sp1 = randomSpawn()
player1.x = sp1.x; player1.z = sp1.z; player1.angle = sp1.angle
const sp2 = randomSpawn(player1)
player2.x = sp2.x; player2.z = sp2.z; player2.angle = sp2.angle

function getWeapon(p: PlayerState): WeaponDef {
  return WEAPONS[p.weaponLevel]
}

function respawnPlayer(p: PlayerState, other?: PlayerState) {
  const sp = randomSpawn(other)
  p.x = sp.x; p.z = sp.z; p.angle = sp.angle
  p.hp = 100; p.isDead = false
  p.ammo = getWeapon(p).magSize
  p.isReloading = false; p.reloadTimer = 0; p.fireCooldown = 0
  p.firedThisPress = false
  p.vx = 0; p.vz = 0
  p.y = 0; p.vy = 0; p.isGrounded = true; p.landPenalty = 0
  p.isCrouching = false; p.crouchLerp = 0
  p.pitch = 0; p.smoothedSpeed = 0
}

// =============================================================
//  TRACER / EFFECTS
// =============================================================
let tracerMesh: THREE.Mesh | null = null
let tracerTimer = 0

function showTracer(from: THREE.Vector3, to: THREE.Vector3, hit: boolean) {
  if (tracerMesh) { scene.remove(tracerMesh); tracerMesh.geometry.dispose() }
  const direction = new THREE.Vector3().subVectors(to, from)
  const length = direction.length()
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
  const geo = new THREE.CylinderGeometry(0.025, 0.025, length, 6)
  tracerMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: hit ? 0xff4444 : 0xffaa00 }))
  tracerMesh.position.copy(mid)
  tracerMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize())
  scene.add(tracerMesh)
  tracerTimer = 0.3

  if (hit) {
    const fg = new THREE.SphereGeometry(0.15, 8, 8)
    const fm = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    const f = new THREE.Mesh(fg, fm); f.position.copy(to); scene.add(f)
    setTimeout(() => { scene.remove(f); fg.dispose(); fm.dispose() }, 300)
  }
  const mg = new THREE.SphereGeometry(0.08, 6, 6)
  const mm = new THREE.MeshBasicMaterial({ color: 0xffff44 })
  const m = new THREE.Mesh(mg, mm); m.position.copy(from); scene.add(m)
  setTimeout(() => { scene.remove(m); mg.dispose(); mm.dispose() }, 100)
}

// Aim detection
const aimRaycaster = new THREE.Raycaster()
aimRaycaster.far = 100
aimRaycaster.layers.enableAll()

function isAimingAt(shooter: PlayerState, target: PlayerState): boolean {
  if (shooter.isDead || target.isDead) return false
  const wq = new THREE.Quaternion(); shooter.camera.getWorldQuaternion(wq)
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(wq)
  const origin = new THREE.Vector3(); shooter.camera.getWorldPosition(origin)
  aimRaycaster.set(origin, dir)
  const ph = aimRaycaster.intersectObjects(target.body.children, true)
  if (ph.length === 0) return false
  const wh = aimRaycaster.intersectObjects(wallMeshes, true)
  return ph[0].distance < (wh.length > 0 ? wh[0].distance : Infinity)
}

// =============================================================
//  INPUT
// =============================================================
const keys: Record<string, boolean> = {}
window.addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if (gamePaused) closePauseMenu()
    return
  }
  keys[e.code] = true
  e.preventDefault()
})
window.addEventListener('keyup', e => { keys[e.code] = false })

let mouseDeltaX = 0
let mouseDeltaY = 0
let mouseDown = false
let isADS = false
let adsFov = 80
let inspecting = false
let inspectTimer = 0
let inspectKeyPressed = false

// Kill cam
let killCamActive = false
let killCamTimer = 0
let killCamKiller: PlayerState | null = null
let killCamVictim: PlayerState | null = null
const KILL_CAM_DURATION = 5

renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock()
  }
})

document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return
  mouseDeltaX += e.movementX
  mouseDeltaY += e.movementY
})

renderer.domElement.addEventListener('mousedown', e => {
  if (e.button === 0) mouseDown = true
  if (e.button === 2) isADS = true
})
renderer.domElement.addEventListener('mouseup', e => {
  if (e.button === 0) mouseDown = false
  if (e.button === 2) isADS = false
})
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault())
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement) {
    isADS = false
    mouseDown = false
    // Auto-open pause menu when pointer lock is lost during gameplay
    if (gameStarted && !gamePaused && !gameOver) {
      gamePaused = true
      pauseMenu.classList.add('visible')
    }
  }
})

// Collision
function canMoveTo(x: number, z: number): boolean {
  const margin = 0.3
  if (x < -halfW + margin || x > halfW - margin || z < -halfD + margin || z > halfD - margin) return false
  for (const ob of obstacles) {
    if (x > ob.min.x && x < ob.max.x && z > ob.min.y && z < ob.max.y) return false
  }
  return true
}

// =============================================================
//  MOVEMENT
// =============================================================
function updatePlayerMovement(
  p: PlayerState,
  forward: boolean, backward: boolean,
  strafeLeft: boolean, strafeRight: boolean,
  jump: boolean, crouch: boolean,
  dt: number
) {
  if (p.isDead) { p.vx = 0; p.vz = 0; p.vy = 0; return }

  const sinA = Math.sin(p.angle)
  const cosA = Math.cos(p.angle)

  let inputFwd = 0
  if (forward) inputFwd = 1
  if (backward) inputFwd = -1

  let inputRight = 0
  if (strafeRight) inputRight = 1
  if (strafeLeft) inputRight = -1

  const inputLen = Math.hypot(inputFwd, inputRight)
  if (inputLen > 1) { inputFwd /= inputLen; inputRight /= inputLen }

  const desiredX = -sinA * inputFwd + cosA * inputRight
  const desiredZ = -cosA * inputFwd - sinA * inputRight

  let speedMult = 1.0
  if (p.isCrouching) speedMult *= CROUCH_SPEED_MULT
  if (p.landPenalty > 0) speedMult *= 0.6
  if (p === player1 && isADS) speedMult *= 0.8
  const maxSpd = MAX_SPEED * speedMult

  const hasInput = Math.abs(inputFwd) > 0 || Math.abs(inputRight) > 0
  if (hasInput) {
    p.vx += desiredX * ACCEL * dt
    p.vz += desiredZ * ACCEL * dt
  }

  const frictionMult = p.isGrounded ? FRICTION : FRICTION * 0.3
  p.vx -= p.vx * frictionMult * dt
  p.vz -= p.vz * frictionMult * dt

  const speed = Math.hypot(p.vx, p.vz)
  if (speed > maxSpd) {
    p.vx = (p.vx / speed) * maxSpd
    p.vz = (p.vz / speed) * maxSpd
  }

  const nx = p.x + p.vx * dt
  const nz = p.z + p.vz * dt
  if (canMoveTo(nx, p.z)) p.x = nx; else p.vx = 0
  if (canMoveTo(p.x, nz)) p.z = nz; else p.vz = 0

  if (jump && p.isGrounded && !p.isCrouching) {
    p.vy = JUMP_FORCE
    p.isGrounded = false
  }

  if (!p.isGrounded) {
    p.vy += GRAVITY * dt
    p.y += p.vy * dt
    if (p.y <= 0) {
      p.y = 0; p.vy = 0
      p.isGrounded = true
      p.landPenalty = 0.15
    }
  }

  if (p.landPenalty > 0) p.landPenalty -= dt

  p.isCrouching = crouch && p.isGrounded
  const targetCrouch = p.isCrouching ? 1 : 0
  p.crouchLerp += (targetCrouch - p.crouchLerp) * CROUCH_TRANSITION * dt
  p.crouchLerp = Math.max(0, Math.min(1, p.crouchLerp))
}

// =============================================================
//  SHOOTING
// =============================================================
let killfeedText = ''
let killfeedTimer = 0

function shoot(shooter: PlayerState, target: PlayerState) {
  const wpn = getWeapon(shooter)
  if (shooter.isDead || shooter.isReloading) return
  if (shooter.fireCooldown > 0) return
  if (!wpn.melee && shooter.ammo <= 0) return
  if (shooter === player1 && inspecting) { inspecting = false; return }

  shooter.fireCooldown = wpn.cooldown

  const vmRef = shooter.viewmodel
  if (wpn.melee) {
    vmRef.rotation.x = -0.8
    setTimeout(() => { vmRef.rotation.x = 0 }, 200)
  } else {
    shooter.ammo--
    vmRef.position.z += 0.1
    vmRef.rotation.x = -0.15 * (1 + wpn.recoil * 10)
    setTimeout(() => { vmRef.rotation.x = 0 }, 80)
  }

  const worldQuat = new THREE.Quaternion()
  shooter.camera.getWorldQuaternion(worldQuat)
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(worldQuat)
  const spreadMult = (shooter === player1 && isADS) ? 0.4 : 1
  if (wpn.recoil > 0) {
    dir.x += (Math.random() - 0.5) * wpn.recoil * spreadMult
    dir.y += (Math.random() - 0.5) * wpn.recoil * spreadMult
    dir.normalize()
  }
  const origin = new THREE.Vector3()
  shooter.camera.getWorldPosition(origin)

  // Player ranged: create projectile instead of hitscan
  if (shooter === player1 && !wpn.melee) {
    const velocity = dir.clone().multiplyScalar(wpn.bulletSpeed)
    const isRocket = wpn.name === 'RPG-7'
    const bulletGeo = isRocket
      ? new THREE.ConeGeometry(0.08, 0.35, 8)
      : new THREE.CylinderGeometry(0.04, 0.04, 0.15, 6)
    const bulletMat = new THREE.MeshBasicMaterial({ color: isRocket ? 0xff6622 : 0xffcc00 })
    const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat)
    bulletMesh.position.copy(origin)
    bulletMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    scene.add(bulletMesh)
    projectiles.push({
      mesh: bulletMesh,
      position: origin.clone(),
      velocity,
      owner: shooter,
      target,
      weapon: wpn,
      age: 0
    })
    const mg = new THREE.SphereGeometry(0.08, 6, 6)
    const mm = new THREE.MeshBasicMaterial({ color: 0xffff44 })
    const mf = new THREE.Mesh(mg, mm); mf.position.copy(origin); scene.add(mf)
    setTimeout(() => { scene.remove(mf); mg.dispose(); mm.dispose() }, 100)
    // Network: send shoot event
    if (isMultiplayer) {
      sendNet({
        type: 'shoot',
        originX: origin.x, originY: origin.y, originZ: origin.z,
        dirX: dir.x, dirY: dir.y, dirZ: dir.z,
        weapon: shooter.weaponLevel
      })
    }
    if (shooter.ammo <= 0 && !shooter.isReloading) startReload(shooter)
    return
  }

  // Hitscan (melee + bot ranged)
  const raycaster = new THREE.Raycaster(origin, dir, 0, wpn.range)
  raycaster.layers.enableAll()

  const playerHits = raycaster.intersectObjects(target.body.children, true)
  const wallHits = raycaster.intersectObjects(wallMeshes, true)
  const playerDist = playerHits.length > 0 ? playerHits[0].distance : Infinity
  const wallDist = wallHits.length > 0 ? wallHits[0].distance : Infinity
  const end = origin.clone().add(dir.clone().multiplyScalar(wpn.range))

  if (playerHits.length > 0 && playerDist < wallDist) {
    // Hitzone damage
    const hitMesh = playerHits[0].object as THREE.Mesh
    const meshName = hitMesh.name
    let damageMult = BODY_MULT
    if (meshName === 'head') damageMult = HEADSHOT_MULT
    else if (meshName === 'leg') damageMult = LEG_MULT

    const damage = Math.round(wpn.damage * damageMult)

    if (isMultiplayer && shooter === player1) {
      // Send hit to remote — they apply damage on their side
      sendNet({ type: 'hit', damage, weaponLevel: shooter.weaponLevel })
    } else {
      target.hp -= damage
    }

    if (!wpn.melee) showTracer(origin, playerHits[0].point, true)

    // Hit marker (only for human player)
    if (shooter === player1) {
      if (meshName === 'head') {
        hit1El.textContent = 'HS'
        setTimeout(() => { hit1El.textContent = 'X' }, 500)
      }
      hit1El.classList.add('visible')
      setTimeout(() => hit1El.classList.remove('visible'), 400)
    }

    // Flash rouge
    target.body.children.forEach(child => {
      if (!(child instanceof THREE.Mesh)) return
      const mat = child.material
      if (!(mat instanceof THREE.MeshStandardMaterial)) return
      mat.color.setHex(0xff0000); mat.emissive.setHex(0xff0000)
      const origColor = originalColors.get(mat) ?? 0xffffff
      setTimeout(() => { mat.color.setHex(origColor); mat.emissive.setHex(0x000000) }, 200)
    })

    // In solo, handle kill locally. In multi, kills come via NetKill message.
    if (!isMultiplayer && target.hp <= 0) {
      target.hp = 0
      target.isDead = true
      const killerName = shooter === player1 ? 'Joueur' : 'Bot'
      const hsTag = meshName === 'head' ? ' [HEADSHOT]' : ''
      killfeedText = `${killerName} a tue avec ${wpn.name}${hsTag}`
      killfeedTimer = 3

      shooter.weaponLevel++
      if (shooter.weaponLevel >= WEAPONS.length) {
        showWin(shooter === player1 ? 'Victoire !' : 'Defaite...')
        gameOver = true
        return
      }

      const newWpn = getWeapon(shooter)
      shooter.ammo = newWpn.magSize
      shooter.isReloading = false
      shooter.fireCooldown = 0.5
      updateViewmodelForWeapon(shooter.viewmodel, newWpn)

      killCamActive = true
      killCamTimer = 0
      killCamKiller = shooter
      killCamVictim = target
    }
  } else if (!wpn.melee) {
    if (wallHits.length > 0) showTracer(origin, wallHits[0].point, false)
    else showTracer(origin, end, false)
  }

  if (!wpn.melee && shooter.ammo <= 0 && !shooter.isReloading) {
    startReload(shooter)
  }
}

function startReload(p: PlayerState) {
  const wpn = getWeapon(p)
  if (wpn.melee || p.isReloading || p.ammo >= wpn.magSize) return
  p.isReloading = true
  p.reloadTimer = wpn.reloadTime
}

function handleFire(p: PlayerState, target: PlayerState, fireKey: boolean) {
  const wpn = getWeapon(p)
  if (!fireKey) { p.firedThisPress = false; return }
  if (wpn.auto) {
    shoot(p, target)
  } else {
    if (!p.firedThisPress) { shoot(p, target); p.firedThisPress = true }
  }
}

function updateProjectiles(dt: number) {
  // Clear projectiles during kill cam to avoid race conditions
  if (killCamActive) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      scene.remove(projectiles[i].mesh)
      projectiles[i].mesh.geometry.dispose()
      ;(projectiles[i].mesh.material as THREE.Material).dispose()
    }
    projectiles.length = 0
    return
  }
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const proj = projectiles[i]
    proj.age += dt
    if (proj.age > BULLET_MAX_AGE) {
      scene.remove(proj.mesh)
      proj.mesh.geometry.dispose()
      ;(proj.mesh.material as THREE.Material).dispose()
      projectiles.splice(i, 1)
      continue
    }

    const oldPos = proj.position.clone()
    proj.velocity.y -= BULLET_DROP * dt
    proj.position.add(proj.velocity.clone().multiplyScalar(dt))

    // Rocket smoke trail
    if (proj.weapon.name === 'RPG-7') {
      const tick = Math.floor(proj.age * 15)
      const prev = Math.floor((proj.age - dt) * 15)
      if (tick !== prev) {
        const sg = new THREE.SphereGeometry(0.12, 4, 4)
        const sm = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.5 })
        const s = new THREE.Mesh(sg, sm)
        s.position.copy(proj.position)
        scene.add(s)
        setTimeout(() => { scene.remove(s); sg.dispose(); sm.dispose() }, 500)
      }
    }

    const moveDir = new THREE.Vector3().subVectors(proj.position, oldPos)
    const moveDist = moveDir.length()
    if (moveDist > 0) {
      moveDir.normalize()
      const ray = new THREE.Raycaster(oldPos, moveDir, 0, moveDist)
      ray.layers.enableAll()

      // In multiplayer, remote projectiles (owner=player2) are visual only — no hit detection
      const isRemoteProjectile = isMultiplayer && proj.owner === player2
      const target = proj.target

      if (!isRemoteProjectile && !target.isDead) {
        const playerHits = ray.intersectObjects(target.body.children, true)
        const wallHits = ray.intersectObjects(wallMeshes, true)
        const pDist = playerHits.length > 0 ? playerHits[0].distance : Infinity
        const wDist = wallHits.length > 0 ? wallHits[0].distance : Infinity

        if (playerHits.length > 0 && pDist < wDist) {
          const hitMesh = playerHits[0].object as THREE.Mesh
          const meshName = hitMesh.name
          let damageMult = BODY_MULT
          if (meshName === 'head') damageMult = HEADSHOT_MULT
          else if (meshName === 'leg') damageMult = LEG_MULT

          const damage = Math.round(proj.weapon.damage * damageMult)

          if (isMultiplayer) {
            // Send hit to remote — they apply damage on their side
            sendNet({ type: 'hit', damage, weaponLevel: proj.owner.weaponLevel })
          } else {
            target.hp -= damage
          }

          if (proj.owner === player1) {
            if (meshName === 'head') {
              hit1El.textContent = 'HS'
              setTimeout(() => { hit1El.textContent = 'X' }, 500)
            }
            hit1El.classList.add('visible')
            setTimeout(() => hit1El.classList.remove('visible'), 400)
          }

          target.body.children.forEach(child => {
            if (!(child instanceof THREE.Mesh)) return
            const mat = child.material
            if (!(mat instanceof THREE.MeshStandardMaterial)) return
            mat.color.setHex(0xff0000); mat.emissive.setHex(0xff0000)
            const origColor = originalColors.get(mat) ?? 0xffffff
            setTimeout(() => { mat.color.setHex(origColor); mat.emissive.setHex(0x000000) }, 200)
          })

          const fg = new THREE.SphereGeometry(0.15, 8, 8)
          const fm = new THREE.MeshBasicMaterial({ color: 0xff0000 })
          const f = new THREE.Mesh(fg, fm); f.position.copy(playerHits[0].point); scene.add(f)
          setTimeout(() => { scene.remove(f); fg.dispose(); fm.dispose() }, 300)

          // In solo, handle kill locally. In multi, kills come via NetKill message.
          if (!isMultiplayer && target.hp <= 0) {
            target.hp = 0
            target.isDead = true
            const killerName = proj.owner === player1 ? 'Joueur' : 'Bot'
            const hsTag = meshName === 'head' ? ' [HEADSHOT]' : ''
            killfeedText = `${killerName} a tue avec ${proj.weapon.name}${hsTag}`
            killfeedTimer = 3

            proj.owner.weaponLevel++
            if (proj.owner.weaponLevel >= WEAPONS.length) {
              showWin(proj.owner === player1 ? 'Victoire !' : 'Defaite...')
              gameOver = true
            } else {
              const newWpn = getWeapon(proj.owner)
              proj.owner.ammo = newWpn.magSize
              proj.owner.isReloading = false
              proj.owner.fireCooldown = 0.5
              updateViewmodelForWeapon(proj.owner.viewmodel, newWpn)
            }

            killCamActive = true
            killCamTimer = 0
            killCamKiller = proj.owner
            killCamVictim = target
          }

          scene.remove(proj.mesh)
          proj.mesh.geometry.dispose()
          ;(proj.mesh.material as THREE.Material).dispose()
          projectiles.splice(i, 1)
          continue
        }

        if (wallHits.length > 0 && wDist <= moveDist) {
          scene.remove(proj.mesh)
          proj.mesh.geometry.dispose()
          ;(proj.mesh.material as THREE.Material).dispose()
          projectiles.splice(i, 1)
          continue
        }
      } else {
        // Visual only or target dead — just check wall collision
        const wallHits = ray.intersectObjects(wallMeshes, true)
        if (wallHits.length > 0) {
          scene.remove(proj.mesh)
          proj.mesh.geometry.dispose()
          ;(proj.mesh.material as THREE.Material).dispose()
          projectiles.splice(i, 1)
          continue
        }
      }
    }

    proj.mesh.position.copy(proj.position)
    if (proj.velocity.length() > 0) {
      proj.mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        proj.velocity.clone().normalize()
      )
    }
  }
}

// =============================================================
//  UI
// =============================================================
const uiDiv = document.createElement('div')
uiDiv.id = 'game-ui'
uiDiv.innerHTML = `
  <div class="split-ui">
    <div class="hp-bar"><div class="hp-fill" id="hp1"></div></div>
    <div class="weapon-info" id="wpn1"></div>
    <div class="ammo-info" id="ammo1"></div>
    <div class="level-info" id="lvl1"></div>
    <div class="crosshair" id="cross1">+</div>
    <div class="hit-marker" id="hit1">X</div>
  </div>
`
document.body.appendChild(uiDiv)

const killfeedEl = document.createElement('div')
killfeedEl.id = 'killfeed'
document.body.appendChild(killfeedEl)

const legend = document.createElement('div')
legend.id = 'legend'
legend.innerHTML = `
  <div>ZQSD deplacer · Souris viser · Clic tirer · R recharger</div>
  <div>Espace sauter · Shift accroupir · Clic droit ADS · V inspecter</div>
  <div>Course a l'armement : AK → DMR → Glock → Deagle → Couteau → RPG · Headshot = x2</div>
`
document.body.appendChild(legend)

const winMsg = document.createElement('div')
winMsg.id = 'win-message'
winMsg.style.display = 'none'
document.body.appendChild(winMsg)

// =============================================================
//  PAUSE MENU
// =============================================================
const pauseMenu = document.createElement('div')
pauseMenu.id = 'pause-menu'
pauseMenu.innerHTML = `
  <h2>Pause</h2>
  <div class="pause-panel">
    <div class="pause-slider-group">
      <label>Volume <span id="volume-val">50%</span></label>
      <input type="range" id="volume-slider" min="0" max="100" value="50" />
    </div>
    <div class="pause-slider-group">
      <label>Sensibilite <span id="sens-val">50%</span></label>
      <input type="range" id="sens-slider" min="0" max="100" value="50" />
    </div>
    <button class="pause-btn" id="btn-resume">Reprendre</button>
    <button class="pause-btn danger" id="btn-quit">Quitter</button>
  </div>
`
document.body.appendChild(pauseMenu)

const volumeSlider = pauseMenu.querySelector('#volume-slider') as HTMLInputElement
const volumeVal = pauseMenu.querySelector('#volume-val') as HTMLSpanElement
const sensSlider = pauseMenu.querySelector('#sens-slider') as HTMLInputElement
const sensVal = pauseMenu.querySelector('#sens-val') as HTMLSpanElement
const btnResume = pauseMenu.querySelector('#btn-resume') as HTMLButtonElement
const btnQuit = pauseMenu.querySelector('#btn-quit') as HTMLButtonElement

// Sensitivity: slider 0-100 maps to 0.0005 - 0.005
const SENS_MIN = 0.0005
const SENS_MAX = 0.005
function sensFromSlider(v: number): number {
  return SENS_MIN + (v / 100) * (SENS_MAX - SENS_MIN)
}
function sliderFromSens(s: number): number {
  return Math.round(((s - SENS_MIN) / (SENS_MAX - SENS_MIN)) * 100)
}

// Init slider to current sensitivity
sensSlider.value = String(sliderFromSens(mouseSensitivity))
sensVal.textContent = sensSlider.value + '%'

volumeSlider.addEventListener('input', () => {
  settings.masterVolume = parseInt(volumeSlider.value) / 100
  volumeVal.textContent = volumeSlider.value + '%'
})

sensSlider.addEventListener('input', () => {
  mouseSensitivity = sensFromSlider(parseInt(sensSlider.value))
  sensVal.textContent = sensSlider.value + '%'
})

function closePauseMenu() {
  if (!gamePaused) return
  gamePaused = false
  pauseMenu.classList.remove('visible')
  renderer.domElement.requestPointerLock()
}

function quitToLobby() {
  gamePaused = false
  pauseMenu.classList.remove('visible')
  gameStarted = false
  gameOver = false

  // Disconnect multiplayer
  if (conn) { conn.close(); conn = null }
  if (peer) { peer.destroy(); peer = null }
  isMultiplayer = false
  remoteState = null

  // Hide game, show lobby
  lobbyEl.classList.remove('hidden')
  uiDiv.style.display = 'none'
  legend.style.display = 'none'
  renderer.domElement.style.display = 'none'
  winMsg.style.display = 'none'

  // Reset lobby UI
  document.getElementById('lobby-buttons')!.style.display = 'flex'
  joinForm.style.display = 'none'
  roomDisplay.style.display = 'none'
  btnCreate.textContent = 'Créer partie'
  btnConnect.textContent = 'Connecter'
  lobbyStatus.textContent = ''

  // Cleanup game state
  if (killCamActive && killCamKiller) resetBodyParts(killCamKiller.body)
  if (killCamVictim) killCamVictim.body.visible = true
  killCamActive = false
  killCamKiller = null
  killCamVictim = null
  screamerActive = false
  screamerOverlay.style.display = 'none'
  screamerOverlay.innerHTML = ''
  renderer.domElement.style.filter = ''
  for (const proj of projectiles) {
    scene.remove(proj.mesh); proj.mesh.geometry.dispose()
    ;(proj.mesh.material as THREE.Material).dispose()
  }
  projectiles.length = 0
  for (const fw of fireworks) {
    if (fw.mesh) { scene.remove(fw.mesh); fw.mesh.geometry.dispose(); (fw.mesh.material as THREE.Material).dispose() }
    for (const p of fw.particles) { scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose() }
  }
  fireworks.length = 0
}

btnResume.addEventListener('click', closePauseMenu)
btnQuit.addEventListener('click', quitToLobby)

// =============================================================
//  SCREAMER SYSTEM
// =============================================================
const screamerOverlay = document.createElement('div')
screamerOverlay.style.cssText = 'position:fixed;inset:0;z-index:999;display:none;pointer-events:none;'
document.body.appendChild(screamerOverlay)

// Procedural scary face canvas
function drawScaryFace(type: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 800; c.height = 800
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 800, 800)

  if (type === 0) {
    // Demonic face
    ctx.fillStyle = '#1a0000'
    ctx.beginPath(); ctx.ellipse(400, 380, 280, 340, 0, 0, Math.PI * 2); ctx.fill()
    // Sunken eye sockets
    ctx.fillStyle = '#000'
    ctx.beginPath(); ctx.ellipse(280, 300, 70, 55, -0.1, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(520, 300, 70, 55, 0.1, 0, Math.PI * 2); ctx.fill()
    // Glowing eyes
    ctx.fillStyle = '#ff0000'
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 40
    ctx.beginPath(); ctx.ellipse(280, 305, 25, 35, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(520, 305, 25, 35, 0, 0, Math.PI * 2); ctx.fill()
    // Tiny pupils
    ctx.fillStyle = '#000'; ctx.shadowBlur = 0
    ctx.beginPath(); ctx.arc(280, 305, 8, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(520, 305, 8, 0, Math.PI * 2); ctx.fill()
    // Gaping mouth
    ctx.fillStyle = '#200000'
    ctx.beginPath(); ctx.ellipse(400, 530, 140, 80, 0, 0, Math.PI * 2); ctx.fill()
    // Jagged teeth
    ctx.fillStyle = '#ccbb88'
    for (let i = 0; i < 12; i++) {
      const tx = 280 + i * 22
      const h = 18 + Math.random() * 24
      ctx.fillRect(tx, 470, 8, h)
      ctx.fillRect(tx - 2, 570 - h, 8, h)
    }
    // Blood streaks
    ctx.strokeStyle = '#8b0000'; ctx.lineWidth = 3; ctx.shadowBlur = 0
    for (let i = 0; i < 15; i++) {
      ctx.beginPath()
      const sx = 200 + Math.random() * 400
      ctx.moveTo(sx, 200 + Math.random() * 200)
      ctx.bezierCurveTo(sx + (Math.random() - 0.5) * 60, 500, sx + (Math.random() - 0.5) * 40, 600, sx + (Math.random() - 0.5) * 30, 750)
      ctx.stroke()
    }
  } else if (type === 1) {
    // Skull with hollow eyes
    ctx.fillStyle = '#e8dcc8'
    ctx.beginPath(); ctx.ellipse(400, 350, 220, 270, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#d4c4a8'
    ctx.beginPath(); ctx.ellipse(400, 560, 120, 80, 0, 0, Math.PI); ctx.fill()
    // Black eye holes
    ctx.fillStyle = '#000'
    ctx.beginPath(); ctx.ellipse(300, 310, 55, 65, -0.15, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(500, 310, 55, 65, 0.15, 0, Math.PI * 2); ctx.fill()
    // Red pinpoints deep in sockets
    ctx.fillStyle = '#ff0000'; ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 25
    ctx.beginPath(); ctx.arc(300, 320, 10, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(500, 320, 10, 0, Math.PI * 2); ctx.fill()
    ctx.shadowBlur = 0
    // Nose hole
    ctx.fillStyle = '#2a1a0a'
    ctx.beginPath(); ctx.moveTo(380, 420); ctx.lineTo(400, 390); ctx.lineTo(420, 420); ctx.fill()
    // Teeth grid
    ctx.fillStyle = '#d4c4a8'; ctx.strokeStyle = '#1a1a0a'; ctx.lineWidth = 2
    for (let i = 0; i < 10; i++) {
      const tx = 310 + i * 18
      ctx.fillRect(tx, 490, 14, 35); ctx.strokeRect(tx, 490, 14, 35)
    }
    // Cracks
    ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 2
    for (let i = 0; i < 8; i++) {
      ctx.beginPath()
      const sx = 250 + Math.random() * 300, sy = 150 + Math.random() * 150
      ctx.moveTo(sx, sy)
      for (let j = 0; j < 4; j++) ctx.lineTo(sx + (Math.random() - 0.5) * 80, sy + j * 40 + Math.random() * 30)
      ctx.stroke()
    }
  } else {
    // Distorted shadow figure
    ctx.fillStyle = '#060006'
    ctx.fillRect(0, 0, 800, 800)
    // Tall thin silhouette
    ctx.fillStyle = '#0a0008'
    ctx.beginPath(); ctx.ellipse(400, 300, 120, 160, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillRect(340, 350, 120, 400)
    // White piercing eyes
    ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 30
    ctx.beginPath(); ctx.ellipse(350, 280, 20, 8, -0.2, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(450, 280, 20, 8, 0.2, 0, Math.PI * 2); ctx.fill()
    ctx.shadowBlur = 0
    // Grin
    ctx.strokeStyle = '#330000'; ctx.lineWidth = 4
    ctx.beginPath(); ctx.arc(400, 340, 60, 0.1, Math.PI - 0.1); ctx.stroke()
    // Static noise
    const imgData = ctx.getImageData(0, 0, 800, 800)
    for (let i = 0; i < imgData.data.length; i += 4) {
      if (Math.random() < 0.06) {
        const v = Math.floor(Math.random() * 40)
        imgData.data[i] = v; imgData.data[i + 1] = 0; imgData.data[i + 2] = v
      }
    }
    ctx.putImageData(imgData, 0, 0)
  }
  return c
}

// Pre-generate screamer faces
const screamerFaces = [drawScaryFace(0), drawScaryFace(1), drawScaryFace(2)]

let screamerActive = false
let screamerTimer = 0
let screamerCooldown = 15 + Math.random() * 25
let screamerShakeX = 0
let screamerShakeY = 0

function triggerScreamer() {
  if (screamerActive || gameOver || killCamActive || settings.masterVolume <= 0) return
  screamerActive = true
  screamerTimer = 0

  const faceIdx = Math.floor(Math.random() * screamerFaces.length)
  const face = screamerFaces[faceIdx]

  screamerOverlay.innerHTML = ''
  screamerOverlay.style.display = 'block'

  // Face image
  const img = document.createElement('img')
  img.src = face.toDataURL()
  img.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:80vmin;height:80vmin;object-fit:contain;filter:contrast(1.8) brightness(1.2);'
  screamerOverlay.appendChild(img)

  // Blood vignette
  const vig = document.createElement('div')
  vig.style.cssText = 'position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(80,0,0,0.3) 0%,rgba(30,0,0,0.85) 60%,rgba(0,0,0,0.95) 100%);'
  screamerOverlay.appendChild(vig)

  // Glitch bars
  for (let i = 0; i < 8; i++) {
    const bar = document.createElement('div')
    const y = Math.random() * 100
    const h = 1 + Math.random() * 3
    bar.style.cssText = `position:absolute;left:0;right:0;top:${y}%;height:${h}%;background:rgba(${Math.random() > 0.5 ? '255,0,0' : '0,0,0'},${0.3 + Math.random() * 0.4});`
    screamerOverlay.appendChild(bar)
  }

  // CSS filter on the renderer for extra distortion
  renderer.domElement.style.filter = 'invert(1) hue-rotate(180deg) contrast(2)'
  setTimeout(() => { renderer.domElement.style.filter = '' }, 80)
  setTimeout(() => {
    renderer.domElement.style.filter = 'brightness(3) contrast(0.5) saturate(5) hue-rotate(90deg)'
    setTimeout(() => { renderer.domElement.style.filter = '' }, 50)
  }, 150)
}

function updateScreamer(dt: number) {
  // Random trigger
  if (!screamerActive) {
    screamerCooldown -= dt
    if (screamerCooldown <= 0) {
      triggerScreamer()
      screamerCooldown = 20 + Math.random() * 40
    }
  }

  if (!screamerActive) {
    screamerShakeX = 0; screamerShakeY = 0
    return
  }

  screamerTimer += dt

  // Intense camera shake
  const intensity = (1 - screamerTimer / 0.4) * 0.15
  screamerShakeX = (Math.random() - 0.5) * intensity
  screamerShakeY = (Math.random() - 0.5) * intensity

  // End after 0.35s
  if (screamerTimer >= 0.35) {
    screamerActive = false
    screamerOverlay.style.display = 'none'
    screamerOverlay.innerHTML = ''
    screamerShakeX = 0; screamerShakeY = 0
    renderer.domElement.style.filter = ''
  }
}

const hp1El = document.getElementById('hp1')!
const wpn1El = document.getElementById('wpn1')!
const ammo1El = document.getElementById('ammo1')!
const lvl1El = document.getElementById('lvl1')!
const cross1El = document.getElementById('cross1')!
const hit1El = document.getElementById('hit1')!

function updateUI() {
  hp1El.style.width = Math.max(0, player1.hp) + '%'
  hp1El.style.background = player1.hp > 50 ? '#2ecc71' : player1.hp > 25 ? '#f39c12' : '#e74c3c'

  const w1 = getWeapon(player1)
  wpn1El.textContent = w1.name

  if (w1.melee) ammo1El.textContent = ''
  else if (player1.isReloading) ammo1El.textContent = 'RECHARGEMENT...'
  else ammo1El.textContent = `${player1.ammo} / ${w1.magSize}`

  lvl1El.textContent = `Niveau ${player1.weaponLevel + 1} / ${WEAPONS.length}`

  cross1El.classList.toggle('aiming', isAimingAt(player1, player2))

  if (killfeedTimer > 0) {
    killfeedEl.textContent = killfeedText
    killfeedEl.style.opacity = '1'
  } else {
    killfeedEl.style.opacity = '0'
  }
}

function showWin(text: string) {
  winMsg.textContent = text
  winMsg.style.display = 'flex'
  const winner = text.includes('Victoire') ? player1 : player2
  spawnVictoryRocket(winner.x, winner.z)
  setTimeout(() => spawnVictoryRocket(winner.x + 4, winner.z - 3), 500)
  setTimeout(() => spawnVictoryRocket(winner.x - 3, winner.z + 4), 1000)
  setTimeout(() => spawnVictoryRocket(winner.x + 2, winner.z + 5), 1500)
}

// =============================================================
//  FIREWORKS
// =============================================================
interface FwParticle {
  mesh: THREE.Mesh
  vx: number; vy: number; vz: number
  age: number
}

interface Firework {
  mesh: THREE.Mesh | null
  x: number; y: number; z: number
  vy: number
  age: number
  phase: 'rise' | 'explode'
  particles: FwParticle[]
}

const fireworks: Firework[] = []

function spawnVictoryRocket(sx: number, sz: number) {
  const rGeo = new THREE.ConeGeometry(0.15, 0.5, 8)
  const rMat = new THREE.MeshBasicMaterial({ color: 0xff4400 })
  const rMesh = new THREE.Mesh(rGeo, rMat)
  rMesh.position.set(sx, 1, sz)
  scene.add(rMesh)
  fireworks.push({
    mesh: rMesh, x: sx, y: 1, z: sz, vy: 18,
    age: 0, phase: 'rise', particles: []
  })
}

function updateFireworks(dt: number) {
  for (let i = fireworks.length - 1; i >= 0; i--) {
    const fw = fireworks[i]
    fw.age += dt

    if (fw.phase === 'rise') {
      fw.y += fw.vy * dt
      if (fw.mesh) fw.mesh.position.set(fw.x, fw.y, fw.z)

      // Flame trail
      if (Math.random() < 0.6) {
        const sg = new THREE.SphereGeometry(0.08, 4, 4)
        const sm = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.7 })
        const s = new THREE.Mesh(sg, sm)
        s.position.set(fw.x + (Math.random() - 0.5) * 0.2, fw.y - 0.3, fw.z + (Math.random() - 0.5) * 0.2)
        scene.add(s)
        setTimeout(() => { scene.remove(s); sg.dispose(); sm.dispose() }, 400)
      }

      if (fw.y > 25 || fw.age > 1.8) {
        fw.phase = 'explode'
        if (fw.mesh) {
          scene.remove(fw.mesh)
          fw.mesh.geometry.dispose()
          ;(fw.mesh.material as THREE.Material).dispose()
          fw.mesh = null
        }
        const colors = [0xff2244, 0x22ff44, 0x4488ff, 0xffee22, 0xff44ff, 0xff8800, 0x44ffff]
        for (let j = 0; j < 50; j++) {
          const pg = new THREE.SphereGeometry(0.1, 4, 4)
          const pm = new THREE.MeshBasicMaterial({
            color: colors[Math.floor(Math.random() * colors.length)],
            transparent: true, opacity: 1
          })
          const p = new THREE.Mesh(pg, pm)
          p.position.set(fw.x, fw.y, fw.z)
          scene.add(p)
          const a = Math.random() * Math.PI * 2
          const pitch = (Math.random() - 0.3) * Math.PI
          const spd = 4 + Math.random() * 10
          fw.particles.push({
            mesh: p,
            vx: Math.cos(a) * Math.cos(pitch) * spd,
            vy: Math.sin(pitch) * spd,
            vz: Math.sin(a) * Math.cos(pitch) * spd,
            age: 0
          })
        }
      }
    }

    if (fw.phase === 'explode') {
      let alive = false
      for (let j = fw.particles.length - 1; j >= 0; j--) {
        const p = fw.particles[j]
        p.age += dt
        p.vy -= 6 * dt
        p.mesh.position.x += p.vx * dt
        p.mesh.position.y += p.vy * dt
        p.mesh.position.z += p.vz * dt
        const mat = p.mesh.material as THREE.MeshBasicMaterial
        mat.opacity = Math.max(0, 1 - p.age / 2.5)

        if (p.age > 2.5) {
          scene.remove(p.mesh)
          p.mesh.geometry.dispose()
          mat.dispose()
          fw.particles.splice(j, 1)
        } else {
          alive = true
        }
      }
      if (!alive) fireworks.splice(i, 1)
    }
  }
}

// =============================================================
//  KILL CAM (Twerk)
// =============================================================
function getNamedParts(body: THREE.Group) {
  const head = body.children.find(c => c.name === 'head')!
  const torso = body.children.find(c => c.name === 'torso')!
  const arms = body.children.filter(c => c.name === 'arm')
  const legs = body.children.filter(c => c.name === 'leg')
  return { head, torso, lArm: arms[0], rArm: arms[1], lLeg: legs[0], rLeg: legs[1] }
}

function resetBodyParts(body: THREE.Group) {
  const { head, torso, lArm, rArm, lLeg, rLeg } = getNamedParts(body)
  head.position.y = 1.52; head.rotation.set(0, 0, 0)
  torso.position.y = 1.05; torso.rotation.set(0, 0, 0)
  lArm.position.set(-0.36, 1.0, 0); lArm.rotation.set(0, 0, 0)
  rArm.position.set(0.36, 1.0, 0); rArm.rotation.set(0, 0, 0)
  lLeg.position.set(-0.14, 0.48, 0); lLeg.rotation.set(0, 0, 0)
  rLeg.position.set(0.14, 0.48, 0); rLeg.rotation.set(0, 0, 0)
}

function updateKillCam(dt: number) {
  if (!killCamActive || !killCamKiller || !killCamVictim) return

  killCamTimer += dt

  const killer = killCamKiller
  const victim = killCamVictim

  // Hide victim body
  victim.body.visible = false

  // Show killer body (enable layer 1 on camera1 if killer is player1)
  if (killer === player1) camera1.layers.enable(1)

  // Orbit camera around killer
  const orbitAngle = killer.angle + Math.PI + killCamTimer * 0.4
  const camDist = 4
  const camX = killer.x + Math.sin(orbitAngle) * camDist
  const camZ = killer.z + Math.cos(orbitAngle) * camDist
  camera1.position.set(camX, 2.8, camZ)
  camera1.lookAt(killer.x, 1.2, killer.z)

  // Twerk animation on killer body
  const tTime = killCamTimer * 14
  const { head, torso, lArm, rArm, lLeg, rLeg } = getNamedParts(killer.body)

  // Lean forward + rapid hip bounce
  torso.rotation.x = 0.5 + Math.sin(tTime) * 0.12
  torso.position.y = 1.05 + Math.sin(tTime * 2) * 0.07
  torso.rotation.z = Math.sin(tTime * 0.7) * 0.08

  // Head bobs with body
  head.position.y = 1.52 + Math.sin(tTime * 2) * 0.06
  head.rotation.z = Math.sin(tTime * 0.5) * 0.12

  // Arms flail around
  lArm.rotation.x = 0.4 + Math.sin(tTime * 0.9) * 0.25
  lArm.rotation.z = -0.5 + Math.sin(tTime * 1.1) * 0.2
  rArm.rotation.x = 0.4 + Math.sin(tTime * 0.9 + Math.PI) * 0.25
  rArm.rotation.z = 0.5 + Math.sin(tTime * 1.1 + Math.PI) * 0.2

  // Legs bounce alternately
  lLeg.rotation.x = Math.sin(tTime + Math.PI) * 0.2
  rLeg.rotation.x = Math.sin(tTime) * 0.2

  // Hide viewmodel during killcam
  player1.viewmodel.visible = false

  // End killcam
  if (killCamTimer >= KILL_CAM_DURATION) {
    killCamActive = false

    // Reset killer body parts
    resetBodyParts(killer.body)

    // Restore victim body
    victim.body.visible = true

    // Restore camera layer
    if (killer === player1) camera1.layers.disable(1)

    // Respawn victim
    respawnPlayer(killCamVictim, killCamKiller)
    updateViewmodelForWeapon(killCamVictim.viewmodel, getWeapon(killCamVictim))

    killCamKiller = null
    killCamVictim = null
  }
}

// =============================================================
//  BOT AI
// =============================================================
let botStrafeDir = 1
let botStrafeTimer = 0
let botFireHeld = false
const BOT_AIM_INACCURACY = 0.04

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * Math.min(t, 1)
}

function updateBot(bot: PlayerState, target: PlayerState, dt: number) {
  if (bot.isDead || gameOver) return

  const dx = target.x - bot.x
  const dz = target.z - bot.z
  const dist = Math.hypot(dx, dz)

  // Aim toward player with inaccuracy
  const targetAngle = Math.atan2(dx, dz) + Math.PI
  const aimOffset = (Math.random() - 0.5) * BOT_AIM_INACCURACY
  bot.angle = lerpAngle(bot.angle, targetAngle + aimOffset, 3.5 * dt)

  // Pitch toward player
  const botCamY = STAND_HEIGHT + bot.y
  const targetCamY = STAND_HEIGHT + target.y - target.crouchLerp * (STAND_HEIGHT - CROUCH_HEIGHT)
  const dy = targetCamY - botCamY
  const targetPitch = -Math.atan2(dy, dist)
  bot.pitch += (targetPitch - bot.pitch) * 3 * dt

  // Random strafe
  botStrafeTimer -= dt
  if (botStrafeTimer <= 0) {
    botStrafeDir = Math.random() > 0.5 ? 1 : -1
    botStrafeTimer = 1.5 + Math.random() * 1.5
  }

  // Movement
  const wpn = getWeapon(bot)
  const idealDist = wpn.melee ? 3 : 18
  const sinA = Math.sin(bot.angle)
  const cosA = Math.cos(bot.angle)

  let moveX = 0, moveZ = 0

  if (dist > idealDist + 5) {
    moveX -= sinA; moveZ -= cosA
  } else if (dist < idealDist - 3) {
    moveX += sinA; moveZ += cosA
  }

  moveX += cosA * botStrafeDir * 0.6
  moveZ -= sinA * botStrafeDir * 0.6

  const moveLen = Math.hypot(moveX, moveZ)
  if (moveLen > 0) {
    const botSpeed = MAX_SPEED * 0.7 * dt
    const nx = bot.x + (moveX / moveLen) * botSpeed
    const nz = bot.z + (moveZ / moveLen) * botSpeed
    if (canMoveTo(nx, bot.z)) bot.x = nx
    if (canMoveTo(bot.x, nz)) bot.z = nz
  }

  // Fire when in range and aiming at target
  if (dist < wpn.range && isAimingAt(bot, target)) {
    if (wpn.auto) {
      handleFire(bot, target, true)
    } else {
      botFireHeld = !botFireHeld
      handleFire(bot, target, botFireHeld)
    }
  } else {
    botFireHeld = false
    handleFire(bot, target, false)
  }

  // Auto-reload
  if (!wpn.melee && bot.ammo <= 0 && !bot.isReloading) {
    startReload(bot)
  }
}

// =============================================================
//  GAME LOOP
// =============================================================
const clock = new THREE.Clock()
let gameOver = false

window.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && gameOver) {
    if (isMultiplayer) sendNet({ type: 'restart' })
    restartGame()
    keys['KeyR'] = false
  }
})

updateViewmodelForWeapon(vm1, WEAPONS[0])
updateViewmodelForWeapon(vm2, WEAPONS[0])

// =============================================================
//  NETWORK
// =============================================================
function sendNet(msg: NetMessage) {
  if (conn && conn.open) conn.send(msg)
}

function sendLocalState() {
  const p = player1
  sendNet({
    type: 'state',
    x: p.x, z: p.z, y: p.y,
    angle: p.angle, pitch: p.pitch,
    hp: p.hp, weaponLevel: p.weaponLevel, ammo: p.ammo,
    isReloading: p.isReloading, isCrouching: p.isCrouching, isDead: p.isDead
  })
}

function updateRemotePlayer(p: PlayerState, dt: number) {
  if (!remoteState) return
  p.x += (remoteState.x - p.x) * 15 * dt
  p.z += (remoteState.z - p.z) * 15 * dt
  p.y += (remoteState.y - p.y) * 15 * dt
  p.angle = remoteState.angle
  p.pitch = remoteState.pitch
  p.hp = remoteState.hp
  p.weaponLevel = remoteState.weaponLevel
  p.ammo = remoteState.ammo
  p.isReloading = remoteState.isReloading
  p.isCrouching = remoteState.isCrouching
  p.isDead = remoteState.isDead
}

function handleNetMessage(msg: NetMessage) {
  switch (msg.type) {
    case 'state':
      remoteState = msg
      // Sync weapon viewmodel if level changed
      if (msg.weaponLevel !== player2.weaponLevel) {
        player2.weaponLevel = msg.weaponLevel
        updateViewmodelForWeapon(player2.viewmodel, WEAPONS[msg.weaponLevel])
      }
      break

    case 'shoot': {
      // Visual-only: spawn bullet from remote player
      const dir = new THREE.Vector3(msg.dirX, msg.dirY, msg.dirZ)
      const origin = new THREE.Vector3(msg.originX, msg.originY, msg.originZ)
      const wpn = WEAPONS[msg.weapon]
      const isRocket = wpn.name === 'RPG-7'
      const bulletGeo = isRocket
        ? new THREE.ConeGeometry(0.08, 0.35, 8)
        : new THREE.CylinderGeometry(0.04, 0.04, 0.15, 6)
      const bulletMat = new THREE.MeshBasicMaterial({ color: isRocket ? 0xff6622 : 0xffcc00 })
      const bulletMesh = new THREE.Mesh(bulletGeo, bulletMat)
      bulletMesh.position.copy(origin)
      bulletMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      scene.add(bulletMesh)
      // Visual projectile only — no hit detection (hits come via NetHit)
      const velocity = dir.clone().multiplyScalar(wpn.bulletSpeed)
      const visualProj = {
        mesh: bulletMesh,
        position: origin.clone(),
        velocity,
        owner: player2,
        target: player1,
        weapon: wpn,
        age: 0
      }
      // We push it but won't do hit detection on it (handled below in updateProjectiles guard)
      projectiles.push(visualProj)
      // Muzzle flash
      const mg = new THREE.SphereGeometry(0.08, 6, 6)
      const mm = new THREE.MeshBasicMaterial({ color: 0xffff44 })
      const mf = new THREE.Mesh(mg, mm)
      mf.position.copy(origin)
      scene.add(mf)
      setTimeout(() => { scene.remove(mf); mg.dispose(); mm.dispose() }, 100)
      break
    }

    case 'hit': {
      // Remote says they hit us — apply damage
      player1.hp -= msg.damage
      // Flash red
      player1.body.children.forEach(child => {
        if (!(child instanceof THREE.Mesh)) return
        const mat = child.material
        if (!(mat instanceof THREE.MeshStandardMaterial)) return
        mat.color.setHex(0xff0000); mat.emissive.setHex(0xff0000)
        const origColor = originalColors.get(mat) ?? 0xffffff
        setTimeout(() => { mat.color.setHex(origColor); mat.emissive.setHex(0x000000) }, 200)
      })
      if (player1.hp <= 0) {
        player1.hp = 0
        player1.isDead = true
        killfeedText = `Ennemi a tue avec ${WEAPONS[msg.weaponLevel].name}`
        killfeedTimer = 3
        // Send kill confirmation to remote
        sendNet({ type: 'kill', killerWeaponLevel: msg.weaponLevel })
        // Activate kill cam — remote is the killer
        killCamActive = true
        killCamTimer = 0
        killCamKiller = player2
        killCamVictim = player1
      }
      break
    }

    case 'kill': {
      // We killed the remote player — weapon progression
      player1.weaponLevel++
      if (player1.weaponLevel >= WEAPONS.length) {
        showWin('Victoire !')
        gameOver = true
      } else {
        const newWpn = getWeapon(player1)
        player1.ammo = newWpn.magSize
        player1.isReloading = false
        player1.fireCooldown = 0.5
        updateViewmodelForWeapon(player1.viewmodel, newWpn)
      }
      // Activate kill cam — we are the killer
      killCamActive = true
      killCamTimer = 0
      killCamKiller = player1
      killCamVictim = player2
      break
    }

    case 'restart': {
      // Remote wants restart
      restartGame()
      break
    }
  }
}

function restartGame() {
  player1.weaponLevel = 0; player1.ammo = WEAPONS[0].magSize
  respawnPlayer(player1)
  player2.weaponLevel = 0; player2.ammo = WEAPONS[0].magSize
  respawnPlayer(player2, player1)
  updateViewmodelForWeapon(vm1, WEAPONS[0])
  updateViewmodelForWeapon(vm2, WEAPONS[0])
  winMsg.style.display = 'none'
  for (const proj of projectiles) {
    scene.remove(proj.mesh)
    proj.mesh.geometry.dispose()
    ;(proj.mesh.material as THREE.Material).dispose()
  }
  projectiles.length = 0
  inspecting = false
  isADS = false
  adsFov = 80
  if (killCamActive && killCamKiller) resetBodyParts(killCamKiller.body)
  if (killCamVictim) killCamVictim.body.visible = true
  killCamActive = false
  killCamTimer = 0
  killCamKiller = null
  screamerActive = false
  screamerOverlay.style.display = 'none'
  screamerOverlay.innerHTML = ''
  renderer.domElement.style.filter = ''
  screamerCooldown = 10 + Math.random() * 20
  killCamVictim = null
  camera1.layers.disable(1)
  for (const fw of fireworks) {
    if (fw.mesh) { scene.remove(fw.mesh); fw.mesh.geometry.dispose(); (fw.mesh.material as THREE.Material).dispose() }
    for (const p of fw.particles) { scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose() }
  }
  fireworks.length = 0
  gameOver = false
  remoteState = null
  updateUI()
}

// =============================================================
//  LOBBY
// =============================================================
const lobbyEl = document.getElementById('lobby')!
const btnSolo = document.getElementById('btn-solo')!
const btnCreate = document.getElementById('btn-create')!
const btnJoin = document.getElementById('btn-join')!
const joinForm = document.getElementById('join-form')!
const roomInput = document.getElementById('room-input') as HTMLInputElement
const btnConnect = document.getElementById('btn-connect')!
const roomDisplay = document.getElementById('room-display')!
const roomCodeEl = document.getElementById('room-code')!
const lobbyStatus = document.getElementById('lobby-status')!

// Hide game UI until game starts
uiDiv.style.display = 'none'
legend.style.display = 'none'
renderer.domElement.style.display = 'none'

function startGame(mode: GameMode) {
  isMultiplayer = mode !== 'solo'
  gameStarted = true

  lobbyEl.classList.add('hidden')
  uiDiv.style.display = 'flex'
  legend.style.display = 'flex'
  renderer.domElement.style.display = 'block'

  if (isMultiplayer) {
    legend.innerHTML = `
      <div>ZQSD deplacer · Souris viser · Clic tirer · R recharger</div>
      <div>Espace sauter · Shift accroupir · Clic droit ADS · V inspecter</div>
      <div>Multijoueur · Course a l'armement · Headshot = x2</div>
    `
  }

  // Reset spawn
  const s1 = randomSpawn()
  player1.x = s1.x; player1.z = s1.z; player1.angle = s1.angle
  const s2 = randomSpawn(player1)
  player2.x = s2.x; player2.z = s2.z; player2.angle = s2.angle

  clock.getDelta() // reset clock
  animate()
}

function createRoom() {
  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase()
  lobbyStatus.textContent = ''
  btnCreate.textContent = 'Connexion...'

  peer = new Peer(`mfps-${roomId}`, { debug: 0 })

  peer.on('open', () => {
    document.getElementById('lobby-buttons')!.style.display = 'none'
    roomDisplay.style.display = 'block'
    roomCodeEl.textContent = roomId
  })

  peer.on('connection', (c: DataConnection) => {
    conn = c
    conn.on('open', () => {
      setupConnection()
      startGame('host')
    })
  })

  peer.on('error', (err: Error) => {
    lobbyStatus.textContent = `Erreur: ${err.message}`
    btnCreate.textContent = 'Créer partie'
  })
}

function joinRoom(roomId: string) {
  lobbyStatus.textContent = ''
  btnConnect.textContent = 'Connexion...'

  peer = new Peer({ debug: 0 })

  peer.on('open', () => {
    conn = peer!.connect(`mfps-${roomId.toUpperCase()}`, { reliable: true })

    conn.on('open', () => {
      setupConnection()
      startGame('guest')
    })

    conn.on('error', (err: Error) => {
      lobbyStatus.textContent = `Erreur: ${err.message}`
      btnConnect.textContent = 'Connecter'
    })
  })

  peer.on('error', (err: Error) => {
    lobbyStatus.textContent = `Erreur: ${err.message}`
    btnConnect.textContent = 'Connecter'
  })
}

function setupConnection() {
  if (!conn) return
  conn.on('data', (data: unknown) => {
    handleNetMessage(data as NetMessage)
  })
  conn.on('close', () => {
    if (gameStarted) {
      // Return to lobby
      gameStarted = false
      gameOver = false
      isMultiplayer = false
      conn = null
      lobbyEl.classList.remove('hidden')
      uiDiv.style.display = 'none'
      legend.style.display = 'none'
      renderer.domElement.style.display = 'none'
      winMsg.style.display = 'none'
      // Reset lobby UI
      document.getElementById('lobby-buttons')!.style.display = 'flex'
      joinForm.style.display = 'none'
      roomDisplay.style.display = 'none'
      btnCreate.textContent = 'Créer partie'
      btnConnect.textContent = 'Connecter'
      lobbyStatus.textContent = 'Connexion perdue'
    }
  })
}

btnSolo.addEventListener('click', () => startGame('solo'))
btnCreate.addEventListener('click', createRoom)
btnJoin.addEventListener('click', () => {
  joinForm.style.display = 'flex'
  roomInput.focus()
})
btnConnect.addEventListener('click', () => {
  const code = roomInput.value.trim()
  if (code.length < 4) {
    lobbyStatus.textContent = 'Code trop court'
    return
  }
  joinRoom(code)
})
roomInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') btnConnect.click()
})

function animate() {
  requestAnimationFrame(animate)
  const rawDt = clock.getDelta()
  const dt = Math.min(rawDt, 0.05)
  const t = clock.getElapsedTime()

  if (killfeedTimer > 0) killfeedTimer -= dt

  // Mouse look (skip when paused)
  if (!gamePaused) {
    const sens = mouseSensitivity * (isADS ? 0.6 : 1)
    player1.angle -= mouseDeltaX * sens
    player1.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, player1.pitch - mouseDeltaY * sens))
  }
  mouseDeltaX = 0
  mouseDeltaY = 0

  if (!gameOver && !killCamActive && !gamePaused) {
    // Player movement
    updatePlayerMovement(
      player1,
      !!(keys['KeyZ'] || keys['KeyW']),
      !!keys['KeyS'],
      !!(keys['KeyQ'] || keys['KeyA']),
      !!keys['KeyD'],
      !!keys['Space'],
      !!keys['ShiftLeft'],
      dt
    )

    // Bot AI / Remote player
    if (!isMultiplayer) {
      updateBot(player2, player1, dt)
    } else {
      updateRemotePlayer(player2, dt)
    }

    // Cooldowns
    if (player1.fireCooldown > 0) player1.fireCooldown -= dt
    if (player2.fireCooldown > 0) player2.fireCooldown -= dt

    // Reload
    for (const p of [player1, player2]) {
      if (p.isReloading) {
        p.reloadTimer -= dt
        if (p.reloadTimer <= 0) {
          p.isReloading = false
          p.ammo = getWeapon(p).magSize
        }
      }
    }

    // Player fire (mouse)
    handleFire(player1, player2, mouseDown)

    // Manual reload
    if (keys['KeyR'] && !gameOver) { startReload(player1); keys['KeyR'] = false }
  }

  // Kill cam
  updateKillCam(dt)

  // Update projectiles
  updateProjectiles(dt)

  // Update fireworks
  updateFireworks(dt)

  // Tracer fade
  if (tracerTimer > 0) {
    tracerTimer -= dt
    if (tracerTimer <= 0 && tracerMesh) { scene.remove(tracerMesh); tracerMesh.geometry.dispose(); tracerMesh = null }
  }

  // Horror: flicker streetlights
  for (let i = 0; i < flickerLights.length; i++) {
    const fl = flickerLights[i]
    const bulb = flickerBulbs[i]
    const flicker = Math.random()
    if (flicker < 0.03) {
      fl.intensity = 0
      ;(bulb.material as THREE.MeshBasicMaterial).opacity = 0.1
    } else {
      fl.intensity = 0.15 + Math.sin(t * 3 + i * 2.5) * 0.1 + Math.random() * 0.08
      ;(bulb.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 3 + i * 2.5) * 0.3
    }
  }

  // Update bodies
  for (const p of [player1, player2]) {
    p.body.position.set(p.x, p.y, p.z)
    p.body.rotation.y = p.angle
    const scaleY = 1.0 - p.crouchLerp * 0.4
    p.body.scale.set(1, scaleY, 1)
  }

  // Update cameras (skip during killcam, killcam controls camera1)
  if (!killCamActive) {
    for (const p of [player1, player2]) {
      const cameraY = STAND_HEIGHT + p.y - p.crouchLerp * (STAND_HEIGHT - CROUCH_HEIGHT)
      p.camera.position.set(p.x, cameraY, p.z)
      p.camera.rotation.order = 'YXZ'
      p.camera.rotation.y = p.angle
      p.camera.rotation.x = p.pitch
    }
  }

  // Smoothed speed + viewmodel (skip during killcam)
  if (!killCamActive) {
    const realSpeed = Math.hypot(player1.vx, player1.vz)
    player1.smoothedSpeed += (realSpeed - player1.smoothedSpeed) * 8 * dt
    const spdRatio = player1.smoothedSpeed / MAX_SPEED

    player1.viewmodel.visible = !player1.isDead

    // Inspect input (V key, one-shot toggle)
    if (keys['KeyV'] && !inspectKeyPressed && !player1.isDead && !player1.isReloading && !isADS) {
      inspectKeyPressed = true
      inspecting = !inspecting
      inspectTimer = 0
    }
    if (!keys['KeyV']) inspectKeyPressed = false
    if (player1.isReloading || player1.isDead) inspecting = false
    if (isADS) inspecting = false

    if (inspecting) {
      inspectTimer += dt
      if (inspectTimer >= 2.5) inspecting = false
      else {
        const progress = inspectTimer / 2.5
        player1.viewmodel.position.x += (0 - player1.viewmodel.position.x) * 8 * dt
        player1.viewmodel.position.y += (-0.15 - player1.viewmodel.position.y) * 8 * dt
        player1.viewmodel.position.z += (-0.35 - player1.viewmodel.position.z) * 8 * dt
        player1.viewmodel.rotation.y = progress * Math.PI * 2
        player1.viewmodel.rotation.x = Math.sin(progress * Math.PI * 2) * 0.3
        player1.viewmodel.rotation.z = Math.sin(progress * Math.PI * 4) * 0.15
      }
    }

    if (!inspecting) {
      const targetX = isADS ? 0 : 0.25
      const targetY = isADS ? -0.18 : -0.22
      const targetZ = isADS ? -0.35 : -0.4

      let bobX = 0, bobY = 0, tiltZ = 0
      if (spdRatio > 0.05 && !player1.isDead) {
        const bobFreq = 8 + spdRatio * 3
        bobX = Math.sin(t * bobFreq) * 0.008 * spdRatio
        bobY = Math.sin(t * bobFreq * 1.2) * 0.012 * spdRatio
        tiltZ = Math.sin(t * bobFreq) * 0.004 * spdRatio
      } else if (!player1.isDead) {
        bobX = Math.sin(t * 1.5) * 0.001
        bobY = Math.sin(t * 2) * 0.002
      }

      player1.viewmodel.position.x += (targetX + bobX - player1.viewmodel.position.x) * 12 * dt
      player1.viewmodel.position.y += (targetY + bobY - player1.viewmodel.position.y) * 12 * dt
      player1.viewmodel.position.z += (targetZ - player1.viewmodel.position.z) * 12 * dt
      player1.viewmodel.rotation.z += (tiltZ - player1.viewmodel.rotation.z) * 12 * dt
      player1.viewmodel.rotation.y += (0 - player1.viewmodel.rotation.y) * 12 * dt
      player1.viewmodel.rotation.x += (0 - player1.viewmodel.rotation.x) * 12 * dt
    }

    player1.viewmodel.position.y += player1.crouchLerp * 0.03
    if (player1.landPenalty > 0) {
      player1.viewmodel.position.y -= (player1.landPenalty / 0.15) * 0.06
    }
  }

  // ADS FOV
  const targetFov = isADS ? 55 : 80
  adsFov += (targetFov - adsFov) * 12 * dt
  camera1.fov = adsFov

  // Screamer system (skip when paused)
  if (!gamePaused) updateScreamer(dt)
  if (!killCamActive) {
    camera1.rotation.x += screamerShakeX
    camera1.rotation.y += screamerShakeY
  }

  updateUI()

  // Network: send state every 50ms
  if (isMultiplayer) {
    netSendTimer -= dt
    if (netSendTimer <= 0) {
      sendLocalState()
      netSendTimer = 0.05
    }
  }

  // Render (fullscreen single camera)
  const w = window.innerWidth, h = window.innerHeight
  camera1.aspect = w / h
  camera1.updateProjectionMatrix()
  renderer.render(scene, camera1)
}

// Don't auto-start — lobby handles it

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
})
