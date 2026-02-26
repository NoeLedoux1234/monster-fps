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

interface NetCustomize {
  type: 'customize'
  config: AvatarConfig
}

type NetMessage = NetState | NetShoot | NetHit | NetKill | NetRestart | NetCustomize

// =============================================================
//  AVATAR CONFIG
// =============================================================
type HornStyle = 'none' | 'short' | 'long' | 'curved' | 'oni'
type FacePattern = 'none' | 'warpaint' | 'scars' | 'tribal' | 'kabuki' | 'skull'
type HatStyle = 'none' | 'kabuto' | 'straw' | 'bandana' | 'oni-mask' | 'crown'

interface AvatarConfig {
  skinColor: number
  bodyColor: number
  eyeColor: number
  hornStyle: HornStyle
  facePattern: FacePattern
  hat: HatStyle
}

let peer: Peer | null = null
let conn: DataConnection | null = null
let isMultiplayer = false
let remoteState: NetState | null = null
let netSendTimer = 0
let gameStarted = false
let animating = false

const DEFAULT_P1_CONFIG: AvatarConfig = {
  skinColor: 0x4a3a2a,
  bodyColor: 0x3498db,
  eyeColor: 0xff1100,
  hornStyle: 'short',
  facePattern: 'none',
  hat: 'none',
}

const DEFAULT_P2_CONFIG: AvatarConfig = {
  skinColor: 0x4a3a2a,
  bodyColor: 0xe74c3c,
  eyeColor: 0xff1100,
  hornStyle: 'short',
  facePattern: 'none',
  hat: 'none',
}

const AVATAR_STORAGE_KEY = 'monster-fps-avatar'

function saveAvatarConfig(config: AvatarConfig) {
  localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(config))
}

function loadAvatarConfig(): AvatarConfig {
  const raw = localStorage.getItem(AVATAR_STORAGE_KEY)
  if (!raw) return { ...DEFAULT_P1_CONFIG }
  return { ...DEFAULT_P1_CONFIG, ...JSON.parse(raw) }
}

let p1Config = loadAvatarConfig()
let p2Config: AvatarConfig = { ...DEFAULT_P2_CONFIG }

// --- Scene ---
type MapTheme = 'dark' | 'light'
let selectedMap: MapTheme = 'dark'

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x020206)
scene.fog = new THREE.Fog(0x020206, 6, 32)

const ambientLight = new THREE.AmbientLight(0x0a0a18, 0.08)
scene.add(ambientLight)

const sunLight = new THREE.DirectionalLight(0xfffbe8, 0)
sunLight.position.set(15, 30, 10)
sunLight.castShadow = true
sunLight.shadow.mapSize.set(2048, 2048)
sunLight.shadow.camera.left = -35; sunLight.shadow.camera.right = 35
sunLight.shadow.camera.top = 25; sunLight.shadow.camera.bottom = -25
sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 80
scene.add(sunLight)

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

// =============================================================
//  SOUND MANAGER (Procedural Web Audio API)
// =============================================================
class SoundManager {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private ambienceOsc: OscillatorNode | null = null
  private ambienceLfo: OscillatorNode | null = null
  private ambienceGain: GainNode | null = null
  footstepTimer = 0

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = settings.masterVolume
      this.masterGain.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  private getMaster(): GainNode {
    this.ensureCtx()
    return this.masterGain!
  }

  setVolume(v: number) {
    if (this.masterGain) this.masterGain.gain.value = v
  }

  private whiteNoise(ctx: AudioContext, duration: number): AudioBufferSourceNode {
    const sz = Math.floor(ctx.sampleRate * duration)
    const buf = ctx.createBuffer(1, sz, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < sz; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    return src
  }

  gunshot(weaponLevel: number) {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()

    // Different params per weapon
    const configs: { freq: number; dur: number; gain: number }[] = [
      { freq: 800, dur: 0.15, gain: 0.6 },   // AK-47
      { freq: 600, dur: 0.2, gain: 0.5 },     // DMR
      { freq: 1200, dur: 0.08, gain: 0.4 },   // Glock-18
      { freq: 400, dur: 0.25, gain: 0.8 },    // Desert Eagle
      { freq: 0, dur: 0, gain: 0 },           // Couteau (not used)
      { freq: 200, dur: 0.4, gain: 0.9 },     // RPG-7 (not used directly)
    ]
    const cfg = configs[Math.min(weaponLevel, configs.length - 1)]

    const noise = this.whiteNoise(ctx, cfg.dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(cfg.freq, now)
    filter.frequency.exponentialRampToValueAtTime(100, now + cfg.dur)

    const env = ctx.createGain()
    env.gain.setValueAtTime(cfg.gain, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + cfg.dur)

    noise.connect(filter).connect(env).connect(master)
    noise.start(now)
    noise.stop(now + cfg.dur)
  }

  gunshotRemote(_weaponLevel: number) {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const dur = 0.12
    const noise = this.whiteNoise(ctx, dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 500
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.15, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + dur)
    noise.connect(filter).connect(env).connect(master)
    noise.start(now)
    noise.stop(now + dur)
  }

  melee() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const dur = 0.08
    const noise = this.whiteNoise(ctx, dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 2000
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.4, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + dur)
    noise.connect(filter).connect(env).connect(master)
    noise.start(now)
    noise.stop(now + dur)
  }

  rocketLaunch() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Low rumble
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(80, now)
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.5)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.5, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.5)
    // Noise layer
    const noise = this.whiteNoise(ctx, 0.4)
    const nEnv = ctx.createGain()
    nEnv.gain.setValueAtTime(0.3, now)
    nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.4)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 600
    noise.connect(filter).connect(nEnv).connect(master)
    noise.start(now)
    noise.stop(now + 0.4)
  }

  hitmarker() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 800
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.25, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.08)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.08)
  }

  headshot() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = 1200
      const env = ctx.createGain()
      const t = now + i * 0.07
      env.gain.setValueAtTime(0.3, t)
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
      osc.connect(env).connect(master)
      osc.start(t)
      osc.stop(t + 0.06)
    }
  }

  takeDamage() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Bass thud
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(100, now)
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.2)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.5, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.2)
    // Noise hit
    const noise = this.whiteNoise(ctx, 0.1)
    const nEnv = ctx.createGain()
    nEnv.gain.setValueAtTime(0.2, now)
    nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    noise.connect(nEnv).connect(master)
    noise.start(now)
    noise.stop(now + 0.1)
  }

  reload() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Sequence of metallic clicks
    const times = [0, 0.15, 0.4, 0.55]
    const freqs = [3000, 2000, 2500, 3500]
    times.forEach((t, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = freqs[i]
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.2, now + t)
      env.gain.exponentialRampToValueAtTime(0.001, now + t + 0.04)
      osc.connect(env).connect(master)
      osc.start(now + t)
      osc.stop(now + t + 0.04)
    })
  }

  dryFire() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 4000
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.15, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.02)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.02)
  }

  footstep() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const dur = 0.05
    const noise = this.whiteNoise(ctx, dur)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 800 + Math.random() * 400
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.12, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + dur)
    noise.connect(filter).connect(env).connect(master)
    noise.start(now)
    noise.stop(now + dur)
  }

  jump() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(200, now)
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.12)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.15, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.12)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.12)
  }

  land() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, now)
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.1)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.3, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.1)
    // Thud noise
    const noise = this.whiteNoise(ctx, 0.06)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 400
    const nEnv = ctx.createGain()
    nEnv.gain.setValueAtTime(0.15, now)
    nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.06)
    noise.connect(filter).connect(nEnv).connect(master)
    noise.start(now)
    noise.stop(now + 0.06)
  }

  screamer() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Loud white noise burst
    const noise = this.whiteNoise(ctx, 0.8)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.7, now)
    env.gain.setValueAtTime(0.7, now + 0.5)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.8)
    noise.connect(env).connect(master)
    noise.start(now)
    noise.stop(now + 0.8)
    // Dissonant oscillators
    const freqs = [440, 466, 880, 932]
    freqs.forEach(f => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = f
      const oEnv = ctx.createGain()
      oEnv.gain.setValueAtTime(0.3, now)
      oEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.7)
      osc.connect(oEnv).connect(master)
      osc.start(now)
      osc.stop(now + 0.7)
    })
  }

  kill() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Short ascending jingle
    const notes = [523, 659, 784]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = f
      const env = ctx.createGain()
      const t = now + i * 0.08
      env.gain.setValueAtTime(0.2, t)
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
      osc.connect(env).connect(master)
      osc.start(t)
      osc.stop(t + 0.1)
    })
  }

  death() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(300, now)
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.6)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.35, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.6)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.6)
  }

  weaponSwitch() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Metallic click
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 3000
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.2, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.03)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.03)
    // Second click
    const osc2 = ctx.createOscillator()
    osc2.type = 'triangle'
    osc2.frequency.value = 2500
    const env2 = ctx.createGain()
    env2.gain.setValueAtTime(0.15, now + 0.05)
    env2.gain.exponentialRampToValueAtTime(0.001, now + 0.08)
    osc2.connect(env2).connect(master)
    osc2.start(now + 0.05)
    osc2.stop(now + 0.08)
  }

  explosion() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Low boom
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(100, now)
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.5)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.6, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.5)
    // Crackle noise
    const noise = this.whiteNoise(ctx, 0.3)
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 3000
    filter.Q.value = 2
    const nEnv = ctx.createGain()
    nEnv.gain.setValueAtTime(0.3, now)
    nEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    noise.connect(filter).connect(nEnv).connect(master)
    noise.start(now)
    noise.stop(now + 0.3)
  }

  startAmbience() {
    const ctx = this.ensureCtx()
    const master = this.getMaster()
    if (this.ambienceOsc) return
    // Low drone
    this.ambienceOsc = ctx.createOscillator()
    this.ambienceOsc.type = 'sine'
    this.ambienceOsc.frequency.value = 42
    this.ambienceGain = ctx.createGain()
    this.ambienceGain.gain.value = 0.08
    // LFO for variation
    this.ambienceLfo = ctx.createOscillator()
    this.ambienceLfo.type = 'sine'
    this.ambienceLfo.frequency.value = 0.3
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 8
    this.ambienceLfo.connect(lfoGain).connect(this.ambienceOsc.frequency)
    this.ambienceOsc.connect(this.ambienceGain).connect(master)
    this.ambienceOsc.start()
    this.ambienceLfo.start()
  }

  stopAmbience() {
    if (this.ambienceOsc) {
      this.ambienceOsc.stop()
      this.ambienceOsc = null
    }
    if (this.ambienceLfo) {
      this.ambienceLfo.stop()
      this.ambienceLfo = null
    }
    this.ambienceGain = null
  }

  uiClick() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 1000
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.1, now)
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.02)
    osc.connect(env).connect(master)
    osc.start(now)
    osc.stop(now + 0.02)
  }

  victory() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Simple fanfare: C E G C5
    const notes = [523, 659, 784, 1047]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = f
      const env = ctx.createGain()
      const t = now + i * 0.15
      env.gain.setValueAtTime(0.2, t)
      env.gain.setValueAtTime(0.2, t + 0.12)
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
      osc.connect(env).connect(master)
      osc.start(t)
      osc.stop(t + 0.2)
    })
  }

  defeat() {
    const ctx = this.ensureCtx()
    const now = ctx.currentTime
    const master = this.getMaster()
    // Sad descending notes
    const notes = [392, 349, 311, 262]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const env = ctx.createGain()
      const t = now + i * 0.2
      env.gain.setValueAtTime(0.2, t)
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
      osc.connect(env).connect(master)
      osc.start(t)
      osc.stop(t + 0.25)
    })
  }
}

const soundManager = new SoundManager()

const HEADSHOT_MULT = 2.0
const BODY_MULT = 1.0
const LEG_MULT = 0.65
const BULLET_DROP = 12
const BULLET_MAX_AGE = 3

// =============================================================
//  MAP — Samurai Temple
// =============================================================
const ARENA_W = 36
const ARENA_D = 28
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

// Dark wood (temples)
const darkWoodTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#3a2518'
  ctx.fillRect(0, 0, 128, 128)
  for (let y = 0; y < 128; y += 2) {
    const v = 40 + Math.random() * 25
    ctx.fillStyle = `rgba(${v + 10},${v},${v - 5},0.3)`
    ctx.fillRect(0, y, 128, 2)
  }
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(${30 + Math.random() * 20},${15 + Math.random() * 15},${10 + Math.random() * 10},0.15)`
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1)
  }
})

// Bamboo
const bambooTex = makeTex(64, 128, ctx => {
  ctx.fillStyle = '#6b8e4e'
  ctx.fillRect(0, 0, 64, 128)
  for (let y = 0; y < 128; y += 16) {
    ctx.fillStyle = 'rgba(80,110,50,0.4)'
    ctx.fillRect(0, y, 64, 2)
  }
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = `rgba(${90 + Math.random() * 30},${120 + Math.random() * 30},${60 + Math.random() * 20},0.12)`
    ctx.fillRect(Math.random() * 64, Math.random() * 128, 1, 1)
  }
})

// Stone (walls, pavement)
const stoneTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#8a8580'
  ctx.fillRect(0, 0, 128, 128)
  for (let row = 0; row < 8; row++) {
    const y = row * 16
    ctx.fillStyle = 'rgba(60,58,55,0.3)'
    ctx.fillRect(0, y, 128, 1)
    const off = (row % 2) * 24
    for (let x = off; x < 128; x += 48) ctx.fillRect(x, y, 1, 16)
  }
  for (let i = 0; i < 400; i++) {
    const g = 100 + Math.random() * 50
    ctx.fillStyle = `rgba(${g},${g - 2},${g - 5},0.1)`
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2)
  }
})

// Tatami floor
const tatamiTex = makeTex(256, 256, ctx => {
  ctx.fillStyle = '#c4b78e'
  ctx.fillRect(0, 0, 256, 256)
  ctx.strokeStyle = 'rgba(160,140,90,0.3)'
  ctx.lineWidth = 1
  for (let y = 0; y < 256; y += 3) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(100,85,50,0.2)'
  ctx.lineWidth = 2
  for (let x = 0; x <= 256; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke() }
  for (let y = 0; y <= 256; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke() }
})
tatamiTex.repeat.set(3, 2)

// Gravel
const gravelTex = makeTex(128, 128, ctx => {
  ctx.fillStyle = '#d4cfc5'
  ctx.fillRect(0, 0, 128, 128)
  for (let i = 0; i < 1200; i++) {
    const g = 170 + Math.random() * 50
    ctx.fillStyle = `rgba(${g},${g - 5},${g - 12},0.2)`
    const s = 1 + Math.random() * 2
    ctx.fillRect(Math.random() * 128, Math.random() * 128, s, s)
  }
})
gravelTex.repeat.set(3, 2)

// Roof tiles
const roofTex = makeTex(128, 64, ctx => {
  ctx.fillStyle = '#2a2a2e'
  ctx.fillRect(0, 0, 128, 64)
  for (let row = 0; row < 4; row++) {
    const y = row * 16
    for (let x = (row % 2) * 8; x < 128; x += 16) {
      ctx.fillStyle = `rgba(${35 + Math.random() * 15},${35 + Math.random() * 15},${40 + Math.random() * 15},0.8)`
      ctx.fillRect(x, y, 15, 15)
      ctx.fillStyle = 'rgba(20,20,25,0.4)'
      ctx.fillRect(x, y + 14, 15, 2)
    }
  }
})

// Materials
const matDarkWood  = new THREE.MeshStandardMaterial({ map: darkWoodTex, roughness: 0.85 })
const matBamboo    = new THREE.MeshStandardMaterial({ map: bambooTex, roughness: 0.8 })
const matStone     = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.9 })
const matTatami    = new THREE.MeshStandardMaterial({ map: tatamiTex, roughness: 0.95 })
const matGravel    = new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1 })
const matRoof      = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.7 })
const matRedWood   = new THREE.MeshStandardMaterial({ color: 0x8b1a1a, roughness: 0.8 })
const matGold      = new THREE.MeshStandardMaterial({ color: 0xc8a820, metalness: 0.4, roughness: 0.5 })
const matLeaf      = new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.9 })
const matPine      = new THREE.MeshStandardMaterial({ color: 0x2d5a27, roughness: 0.9 })
const matTrunk     = new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.9 })
const matWater     = new THREE.MeshStandardMaterial({ color: 0x3a6b7a, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.7 })
const matPaper     = new THREE.MeshStandardMaterial({ color: 0xf5e6c8, roughness: 0.95, transparent: true, opacity: 0.85 })

// --- Floor ---
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_D), matGravel)
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

// Tatami zones inside temples
floorZone(10, 8, -12, -6, matTatami)
floorZone(10, 8, 12, 6, matTatami)

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

// --- Prop functions ---
function torii(x: number, z: number, rotY = 0) {
  const g = new THREE.Group()
  // Pillars
  const pillarGeo = new THREE.CylinderGeometry(0.15, 0.18, 4.5, 8)
  const lp = new THREE.Mesh(pillarGeo, matRedWood); lp.position.set(-1.2, 2.25, 0); g.add(lp)
  const rp = new THREE.Mesh(pillarGeo, matRedWood); rp.position.set(1.2, 2.25, 0); g.add(rp)
  // Top beam (kasagi)
  const topBeam = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.2, 0.3), matRedWood)
  topBeam.position.set(0, 4.5, 0); g.add(topBeam)
  // Second beam (nuki)
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.15, 0.2), matRedWood)
  nuki.position.set(0, 3.6, 0); g.add(nuki)
  // Gold cap
  const cap = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 0.4), matGold)
  cap.position.set(0, 4.65, 0); g.add(cap)
  g.position.set(x, 0, z)
  g.rotation.y = rotY
  scene.add(g)
}

function lantern(x: number, z: number, h = 1.5) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, h, 6), matDarkWood)
  pole.position.set(x, h / 2, z); scene.add(pole)
  // Paper shade
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.4, 8), matPaper)
  shade.position.set(x, h + 0.1, z); scene.add(shade)
  // Warm light
  const pl = new THREE.PointLight(0xffaa44, 0.4, 8)
  pl.position.set(x, h + 0.1, z); scene.add(pl)
  flickerLights.push(pl)
  flickerBulbs.push(shade)
}

function bambooCluster(x: number, z: number, count = 5) {
  for (let i = 0; i < count; i++) {
    const h = 3 + Math.random() * 2.5
    const ox = (Math.random() - 0.5) * 1.2
    const oz = (Math.random() - 0.5) * 1.2
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, h, 6), matBamboo)
    stalk.position.set(x + ox, h / 2, z + oz)
    scene.add(stalk)
    // Leaves
    const leafGeo = new THREE.SphereGeometry(0.4, 6, 4)
    const leaf = new THREE.Mesh(leafGeo, matPine)
    leaf.position.set(x + ox, h + 0.1, z + oz)
    leaf.scale.set(1, 0.5, 1)
    scene.add(leaf)
  }
}

function sakuraTree(x: number, z: number) {
  // Trunk
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 3, 8), matTrunk)
  trunk.position.set(x, 1.5, z); scene.add(trunk)
  // Canopy (pink/red leaves)
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 6), matLeaf)
  canopy.position.set(x, 3.8, z)
  canopy.scale.set(1, 0.6, 1)
  scene.add(canopy)
}

function stoneLanternProp(x: number, z: number) {
  // Base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.3, 6), matStone)
  base.position.set(x, 0.15, z); scene.add(base)
  // Pillar
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 6), matStone)
  pillar.position.set(x, 0.7, z); scene.add(pillar)
  // Firebox
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), matStone)
  box.position.set(x, 1.3, z); scene.add(box)
  // Roof
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 4), matStone)
  roof.position.set(x, 1.7, z); roof.rotation.y = Math.PI / 4; scene.add(roof)
  // Glow
  const gl = new THREE.PointLight(0xffcc66, 0.2, 5)
  gl.position.set(x, 1.3, z); scene.add(gl)
  flickerLights.push(gl)
}

function riceBale(x: number, z: number) {
  const geo = new THREE.CylinderGeometry(0.4, 0.45, 0.8, 8)
  const mesh = new THREE.Mesh(geo, matTatami)
  mesh.position.set(x, 0.4, z)
  mesh.castShadow = true; mesh.receiveShadow = true
  scene.add(mesh)
  wallMeshes.push(mesh)
  obstacles.push({ min: new THREE.Vector2(x - 0.7, z - 0.7), max: new THREE.Vector2(x + 0.7, z + 0.7) })
}

function woodenBarricade(x: number, z: number, rotY = 0) {
  const sb = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.9, 0.5), matDarkWood)
  sb.position.set(x, 0.45, z); sb.rotation.y = rotY; scene.add(sb)
  sb.castShadow = true; sb.receiveShadow = true
  wallMeshes.push(sb)
  const isRot = Math.abs(rotY) > 0.1
  const hw = isRot ? 0.55 : 1.55
  const hd = isRot ? 1.55 : 0.55
  obstacles.push({ min: new THREE.Vector2(x - hw, z - hd), max: new THREE.Vector2(x + hw, z + hd) })
}

// --- Decorative props (no collision) ---
const flickerLights: THREE.PointLight[] = []
const flickerBulbs: THREE.Mesh[] = []

// ===========================
//  MAP LAYOUT
// ===========================

// === PERIMETER (stone walls) ===
wall(ARENA_W, WH, 0.5, 0, WH / 2, -halfD, matStone)
wall(ARENA_W, WH, 0.5, 0, WH / 2, halfD, matStone)
wall(0.5, WH, ARENA_D, -halfW, WH / 2, 0, matStone)
wall(0.5, WH, ARENA_D, halfW, WH / 2, 0, matStone)

// === TEMPLE A (Northwest) ===
wall(10, WH, 0.4, -12, WH / 2, -2, matDarkWood)   // South wall
wall(10, WH, 0.4, -12, WH / 2, -10, matDarkWood)  // North wall
wall(0.4, WH, 3, -7, WH / 2, -3.5, matDarkWood)   // East entry partial
wall(0.4, WH, 3, -7, WH / 2, -8.5, matDarkWood)   // East entry partial
// Roof
const roofA = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 9), matRoof)
roofA.position.set(-12, WH + 0.15, -6); scene.add(roofA)

// === TEMPLE B (Southeast) ===
wall(10, WH, 0.4, 12, WH / 2, 2, matDarkWood)
wall(10, WH, 0.4, 12, WH / 2, 10, matDarkWood)
wall(0.4, WH, 3, 7, WH / 2, 3.5, matDarkWood)
wall(0.4, WH, 3, 7, WH / 2, 8.5, matDarkWood)
const roofB = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 9), matRoof)
roofB.position.set(12, WH + 0.15, 6); scene.add(roofB)

// === CENTER GARDEN ===
// Pond
const pond = new THREE.Mesh(new THREE.CircleGeometry(3, 16), matWater)
pond.rotation.x = -Math.PI / 2; pond.position.set(0, 0.02, 0); scene.add(pond)
// Stone bridge over pond
wall(1.2, 0.3, 7, 0, 0.25, 0, matStone)

// === BAMBOO CORRIDORS ===
wall(0.4, WH, 5, -3, WH / 2, -4.5, matBamboo)
wall(0.4, WH, 5, 3, WH / 2, 4.5, matBamboo)

// === SIDE PASSAGES ===
wall(6, WH, 0.4, -5, WH / 2, -12, matStone)
wall(0.4, WH, 3, -2, WH / 2, -10.5, matStone)
wall(6, WH, 0.4, 5, WH / 2, 12, matStone)
wall(0.4, WH, 3, 2, WH / 2, 10.5, matStone)

// === LOW WALLS (cover) ===
wall(3, 1.2, 0.4, -8, 0.6, 5, matStone)
wall(0.4, 1.2, 3, 8, 0.6, -5, matStone)
wall(3, 1.2, 0.4, 4, 0.6, -10, matStone)
wall(0.4, 1.2, 3, -4, 0.6, 10, matStone)

// === RICE BALES (cover) ===
riceBale(-14, -4); riceBale(-10, -8)
riceBale(14, 4); riceBale(10, 8)
riceBale(-5, 7); riceBale(5, -7)
riceBale(0, -11); riceBale(0, 11)

// === WOODEN BARRICADES ===
woodenBarricade(-9, 0)
woodenBarricade(9, 0)
woodenBarricade(-3, 8, Math.PI / 2)
woodenBarricade(3, -8, Math.PI / 2)

// === TORII GATES ===
torii(-14, 0, Math.PI / 2)
torii(14, 0, Math.PI / 2)
torii(0, -14)
torii(0, 14)

// === LANTERNS ===
lantern(-15, -11); lantern(-9, -11)
lantern(15, 11); lantern(9, 11)
lantern(-6, 0); lantern(6, 0)
lantern(-15, 6); lantern(15, -6)
lantern(-2, -6); lantern(2, 6)

// === STONE LANTERNS ===
stoneLanternProp(-3, -3); stoneLanternProp(3, 3)
stoneLanternProp(-16, 12); stoneLanternProp(16, -12)

// === SAKURA TREES ===
sakuraTree(-15, 10); sakuraTree(15, -10)
sakuraTree(-6, -13); sakuraTree(6, 13)
sakuraTree(12, -12); sakuraTree(-12, 12)

// === BAMBOO CLUSTERS ===
bambooCluster(-17, -3, 4); bambooCluster(17, 3, 4)
bambooCluster(-16, -13, 3); bambooCluster(16, 13, 3)
bambooCluster(-1, 13, 3); bambooCluster(1, -13, 3)

// =============================================================
//  AVATAR HELPERS
// =============================================================
function createFaceTexture(pattern: FacePattern, skinColor: number): THREE.CanvasTexture | null {
  if (pattern === 'none') return null
  const c = document.createElement('canvas')
  c.width = 128; c.height = 128
  const ctx = c.getContext('2d')!
  const r = (skinColor >> 16) & 0xff
  const g = (skinColor >> 8) & 0xff
  const b = skinColor & 0xff
  ctx.fillStyle = `rgb(${r},${g},${b})`
  ctx.fillRect(0, 0, 128, 128)

  switch (pattern) {
    case 'warpaint':
      ctx.fillStyle = 'rgba(180,20,20,0.7)'
      ctx.fillRect(0, 40, 128, 16)
      ctx.fillRect(0, 70, 128, 12)
      ctx.fillStyle = 'rgba(40,40,40,0.4)'
      ctx.fillRect(20, 56, 88, 4)
      break
    case 'scars':
      ctx.strokeStyle = 'rgba(100,40,40,0.6)'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(20, 20); ctx.lineTo(90, 100); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(100, 10); ctx.lineTo(50, 80); ctx.stroke()
      ctx.strokeStyle = 'rgba(60,20,20,0.4)'
      ctx.lineWidth = 5
      ctx.beginPath(); ctx.moveTo(30, 30); ctx.lineTo(110, 110); ctx.stroke()
      break
    case 'tribal':
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(64, 10); ctx.lineTo(40, 40); ctx.lineTo(88, 40); ctx.closePath(); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(64, 118); ctx.lineTo(40, 88); ctx.lineTo(88, 88); ctx.closePath(); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(10, 62, 108, 4)
      for (let i = 0; i < 6; i++) ctx.fillRect(20 + i * 16, 50, 3, 28)
      break
    case 'kabuki':
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.beginPath(); ctx.ellipse(64, 64, 50, 55, 0, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(200,0,0,0.8)'; ctx.lineWidth = 5
      ctx.beginPath(); ctx.moveTo(20, 45); ctx.quadraticCurveTo(50, 30, 55, 50); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(108, 45); ctx.quadraticCurveTo(78, 30, 73, 50); ctx.stroke()
      ctx.fillStyle = 'rgba(180,0,0,0.8)'
      ctx.beginPath(); ctx.ellipse(64, 90, 12, 6, 0, 0, Math.PI * 2); ctx.fill()
      break
    case 'skull':
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.beginPath(); ctx.ellipse(40, 45, 14, 16, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.ellipse(88, 45, 14, 16, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.moveTo(58, 65); ctx.lineTo(64, 55); ctx.lineTo(70, 65); ctx.closePath(); ctx.fill()
      ctx.fillStyle = 'rgba(200,200,180,0.6)'
      for (let i = 0; i < 6; i++) ctx.fillRect(38 + i * 9, 80, 7, 14)
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1
      for (let i = 0; i < 6; i++) ctx.strokeRect(38 + i * 9, 80, 7, 14)
      break
  }
  return new THREE.CanvasTexture(c)
}

function addHorns(group: THREE.Group, style: HornStyle, hornMat: THREE.MeshStandardMaterial) {
  if (style === 'none') return
  const configs: Record<string, { r: number; h: number; posY: number; spread: number; rotZ: number; rotX: number }> = {
    short:  { r: 0.04, h: 0.25, posY: 1.82, spread: 0.20, rotZ: 0.3, rotX: 0 },
    long:   { r: 0.035, h: 0.5, posY: 1.92, spread: 0.20, rotZ: 0.2, rotX: 0 },
    curved: { r: 0.04, h: 0.35, posY: 1.85, spread: 0.22, rotZ: 0.4, rotX: -0.4 },
    oni:    { r: 0.08, h: 0.45, posY: 1.90, spread: 0.25, rotZ: 0.35, rotX: 0 },
  }
  const c = configs[style]
  const lH = new THREE.Mesh(new THREE.ConeGeometry(c.r, c.h, 6), hornMat)
  lH.position.set(-c.spread, c.posY, -0.05); lH.rotation.set(c.rotX, 0, c.rotZ); group.add(lH)
  const rH = new THREE.Mesh(new THREE.ConeGeometry(c.r, c.h, 6), hornMat)
  rH.position.set(c.spread, c.posY, -0.05); rH.rotation.set(c.rotX, 0, -c.rotZ); group.add(rH)
}

function addHat(group: THREE.Group, style: HatStyle) {
  if (style === 'none') return
  const hg = new THREE.Group()
  hg.name = 'hat'

  switch (style) {
    case 'kabuto': {
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.3 })
      )
      dome.position.y = 1.7; hg.add(dome)
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.08, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.6 })
      )
      visor.position.set(0, 1.62, -0.15); visor.rotation.x = 0.15; hg.add(visor)
      const crest = new THREE.Mesh(
        new THREE.ConeGeometry(0.02, 0.3, 4),
        new THREE.MeshStandardMaterial({ color: 0xc8a820, metalness: 0.8 })
      )
      crest.position.set(0, 2.0, -0.05); hg.add(crest)
      const flapMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a })
      const fg = new THREE.BoxGeometry(0.12, 0.25, 0.08)
      const lf = new THREE.Mesh(fg, flapMat); lf.position.set(-0.3, 1.55, 0.05); lf.rotation.z = -0.2; hg.add(lf)
      const rf = new THREE.Mesh(fg, flapMat); rf.position.set(0.3, 1.55, 0.05); rf.rotation.z = 0.2; hg.add(rf)
      break
    }
    case 'straw': {
      const hat = new THREE.Mesh(
        new THREE.ConeGeometry(0.5, 0.3, 16),
        new THREE.MeshStandardMaterial({ color: 0xd4b88c, roughness: 0.95 })
      )
      hat.position.y = 1.85; hg.add(hat)
      const brim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.55, 0.03, 16),
        new THREE.MeshStandardMaterial({ color: 0xc4a87c, roughness: 0.95 })
      )
      brim.position.y = 1.72; hg.add(brim)
      break
    }
    case 'bandana': {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(0.27, 0.04, 6, 16),
        new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.9 })
      )
      band.position.y = 1.6; band.rotation.x = Math.PI / 2; hg.add(band)
      const tail = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.2, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.9 })
      )
      tail.position.set(0, 1.5, 0.3); tail.rotation.x = 0.3; hg.add(tail)
      break
    }
    case 'oni-mask': {
      const mask = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.8 })
      )
      mask.position.set(0, 1.45, -0.15); mask.rotation.x = Math.PI; hg.add(mask)
      const brow = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.06, 0.1),
        new THREE.MeshStandardMaterial({ color: 0xaa2222 })
      )
      brow.position.set(0, 1.52, -0.22); hg.add(brow)
      const mhMat = new THREE.MeshStandardMaterial({ color: 0xddddaa, roughness: 0.6 })
      const lmh = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 5), mhMat)
      lmh.position.set(-0.18, 1.6, -0.18); lmh.rotation.z = 0.3; hg.add(lmh)
      const rmh = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 5), mhMat)
      rmh.position.set(0.18, 1.6, -0.18); rmh.rotation.z = -0.3; hg.add(rmh)
      break
    }
    case 'crown': {
      const bandMat = new THREE.MeshStandardMaterial({ color: 0xc8a820, metalness: 0.8, roughness: 0.2 })
      const crBand = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.12, 12, 1, true), bandMat)
      crBand.position.y = 1.74; hg.add(crBand)
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2
        const pt = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 4), bandMat)
        pt.position.set(Math.sin(a) * 0.27, 1.86, Math.cos(a) * 0.27); hg.add(pt)
      }
      const gemMat = new THREE.MeshStandardMaterial({ color: 0xff0044, emissive: 0x880022 })
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4
        const gem = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), gemMat)
        gem.position.set(Math.sin(a) * 0.28, 1.74, Math.cos(a) * 0.28); hg.add(gem)
      }
      break
    }
  }
  group.add(hg)
}

// =============================================================
//  AVATAR
// =============================================================
const originalColors = new Map<THREE.MeshStandardMaterial, number>()

function createAvatar(config: AvatarConfig, layerNum: number, targetScene?: THREE.Scene) {
  const sc = targetScene ?? scene
  const group = new THREE.Group()
  const { skinColor, bodyColor, eyeColor } = config
  const fleshRot = 0x6b4a3a

  function skin() { const m = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.95 }); originalColors.set(m, skinColor); return m }
  function body() { const m = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 }); originalColors.set(m, bodyColor); return m }
  function legMat() { const m = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 }); originalColors.set(m, 0x1a1a1a); return m }

  // --- Round head ---
  const faceTex = createFaceTexture(config.facePattern, skinColor)
  const headMat = faceTex
    ? new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.95 })
    : skin()
  if (faceTex) originalColors.set(headMat as THREE.MeshStandardMaterial, skinColor)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), headMat)
  head.position.y = 1.52; head.name = 'head'; group.add(head)

  // Glowing eyes
  const eyeMat = new THREE.MeshBasicMaterial({ color: eyeColor })
  const eyeGeo = new THREE.SphereGeometry(0.06, 6, 6)
  const lEye = new THREE.Mesh(eyeGeo, eyeMat); lEye.position.set(-0.12, 1.56, -0.2); group.add(lEye)
  const rEye = new THREE.Mesh(eyeGeo, eyeMat); rEye.position.set(0.12, 1.56, -0.2); group.add(rEye)

  // Eye glow light
  const eyeGlow = new THREE.PointLight(eyeColor, 0.3, 3)
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
  addHorns(group, config.hornStyle, hornMat)

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

  // --- Arms ---
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

  // --- Legs ---
  const legGeo = new THREE.BoxGeometry(0.22, 0.55, 0.28)
  const lLeg = new THREE.Mesh(legGeo, legMat()); lLeg.position.set(-0.14, 0.48, 0); lLeg.name = 'leg'; group.add(lLeg)
  const rLeg = new THREE.Mesh(legGeo, legMat()); rLeg.position.set(0.14, 0.48, 0); rLeg.name = 'leg'; group.add(rLeg)

  // --- Hat ---
  addHat(group, config.hat)

  group.traverse(obj => {
    obj.layers.set(layerNum)
    if (obj instanceof THREE.Mesh) { obj.castShadow = true; obj.receiveShadow = true }
  })
  sc.add(group)
  return group
}

function rebuildAvatar(player: PlayerState, config: AvatarConfig, layerNum: number) {
  const old = player.body
  old.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      const mat = obj.material
      if (mat instanceof THREE.MeshStandardMaterial) originalColors.delete(mat)
    }
  })
  scene.remove(old)
  player.body = createAvatar(config, layerNum)
}

let p1Body = createAvatar(p1Config, 1)
let p2Body = createAvatar(p2Config, 2)

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
  { x: -12, z: -6, angle: 0 },
  { x: 12, z: 6, angle: Math.PI },
  { x: -15, z: 10, angle: -Math.PI / 4 },
  { x: 15, z: -10, angle: Math.PI * 3 / 4 },
  { x: 0, z: -12, angle: Math.PI / 2 },
  { x: 0, z: 12, angle: -Math.PI / 2 },
  { x: -6, z: 3, angle: 0 },
  { x: 6, z: -3, angle: Math.PI },
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
  if (document.activeElement instanceof HTMLInputElement) return
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
    if (p === player1) soundManager.jump()
  }

  if (!p.isGrounded) {
    p.vy += GRAVITY * dt
    p.y += p.vy * dt
    if (p.y <= 0) {
      p.y = 0; p.vy = 0
      p.isGrounded = true
      p.landPenalty = 0.15
      if (p === player1) soundManager.land()
    }
  }

  if (p.landPenalty > 0) p.landPenalty -= dt

  // Footsteps
  if (p === player1 && p.isGrounded && speed > 1) {
    const interval = p.isCrouching ? 0.5 : 0.35
    soundManager.footstepTimer -= dt
    if (soundManager.footstepTimer <= 0) {
      soundManager.footstep()
      soundManager.footstepTimer = interval
    }
  } else if (p === player1 && (speed <= 1 || !p.isGrounded)) {
    soundManager.footstepTimer = 0
  }

  p.isCrouching = crouch && p.isGrounded
  const targetCrouch = p.isCrouching ? 1 : 0
  p.crouchLerp += (targetCrouch - p.crouchLerp) * CROUCH_TRANSITION * dt
  p.crouchLerp = Math.max(0, Math.min(1, p.crouchLerp))
}

// =============================================================
//  SHOOTING
// =============================================================
interface KillfeedEntry {
  killer: string
  killerColor: string
  victim: string
  victimColor: string
  weapon: string
  headshot: boolean
}
let killfeedEntry: KillfeedEntry | null = null
let killfeedTimer = 0

const P1_COLOR = '#3498db'
const P2_COLOR = '#e74c3c'

function setKillfeed(killer: string, killerColor: string, victim: string, victimColor: string, weapon: string, headshot: boolean) {
  killfeedEntry = { killer, killerColor, victim, victimColor, weapon, headshot }
  killfeedTimer = 3
}

function shoot(shooter: PlayerState, target: PlayerState) {
  const wpn = getWeapon(shooter)
  if (shooter.isDead || shooter.isReloading) return
  if (shooter.fireCooldown > 0) return
  if (!wpn.melee && shooter.ammo <= 0) {
    if (shooter === player1) soundManager.dryFire()
    return
  }
  if (shooter === player1 && inspecting) { inspecting = false; return }

  shooter.fireCooldown = wpn.cooldown

  const vmRef = shooter.viewmodel
  if (wpn.melee) {
    if (shooter === player1) soundManager.melee()
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
    if (wpn.name === 'RPG-7') soundManager.rocketLaunch()
    else soundManager.gunshot(shooter.weaponLevel)
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
        soundManager.headshot()
        hit1El.textContent = 'HS'
        setTimeout(() => { hit1El.textContent = 'X' }, 500)
      } else {
        soundManager.hitmarker()
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
      if (shooter === player1) soundManager.kill()
      if (target === player1) soundManager.death()
      const isP1Killer = shooter === player1
      setKillfeed(
        isP1Killer ? 'Joueur' : 'Bot', isP1Killer ? P1_COLOR : P2_COLOR,
        isP1Killer ? 'Bot' : 'Joueur', isP1Killer ? P2_COLOR : P1_COLOR,
        wpn.name, meshName === 'head'
      )

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
      if (shooter === player1) soundManager.weaponSwitch()

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
  if (p === player1) soundManager.reload()
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
              soundManager.headshot()
              hit1El.textContent = 'HS'
              setTimeout(() => { hit1El.textContent = 'X' }, 500)
            } else {
              soundManager.hitmarker()
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
            if (proj.owner === player1) soundManager.kill()
            if (target === player1) soundManager.death()
            const isP1Killer = proj.owner === player1
            setKillfeed(
              isP1Killer ? 'Joueur' : 'Bot', isP1Killer ? P1_COLOR : P2_COLOR,
              isP1Killer ? 'Bot' : 'Joueur', isP1Killer ? P2_COLOR : P1_COLOR,
              proj.weapon.name, meshName === 'head'
            )

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
              if (proj.owner === player1) soundManager.weaponSwitch()
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

const netStatusEl = document.createElement('div')
netStatusEl.id = 'net-status'
netStatusEl.style.cssText = 'position:fixed;top:8px;right:8px;color:#fff;font:12px monospace;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;display:none;z-index:100'
document.body.appendChild(netStatusEl)
let lastNetReceive = 0

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
  soundManager.setVolume(settings.masterVolume)
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
  soundManager.screamer()

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

  if (killfeedTimer > 0 && killfeedEntry) {
    const e = killfeedEntry
    const hs = e.headshot ? ' <span style="color:#ff4444;font-weight:bold;font-size:0.85em;margin-left:6px">HEADSHOT</span>' : ''
    killfeedEl.innerHTML = `
      <span style="color:${e.killerColor};font-weight:bold">\u25CF ${e.killer}</span>
      <span style="color:#888;margin:0 8px">${e.weapon}</span>
      <span style="color:${e.victimColor};font-weight:bold">\u25CF ${e.victim}</span>${hs}
    `
    killfeedEl.style.opacity = '1'
  } else {
    killfeedEl.style.opacity = '0'
  }

  if (isMultiplayer) {
    netStatusEl.style.display = 'block'
    const ago = performance.now() - lastNetReceive
    const connected = conn?.open ?? false
    if (!connected) {
      netStatusEl.textContent = 'Deconnecte'
      netStatusEl.style.color = '#e74c3c'
    } else if (ago > 2000) {
      netStatusEl.textContent = `Pas de signal (${(ago / 1000).toFixed(0)}s)`
      netStatusEl.style.color = '#f39c12'
    } else {
      netStatusEl.textContent = `En ligne · ${Math.round(ago)}ms`
      netStatusEl.style.color = '#2ecc71'
    }
  } else {
    netStatusEl.style.display = 'none'
  }
}

function showWin(text: string) {
  winMsg.textContent = text
  winMsg.style.display = 'flex'
  if (text.includes('Victoire')) soundManager.victory()
  else soundManager.defeat()
  soundManager.stopAmbience()
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
        soundManager.explosion()
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
  const dx = remoteState.x - p.x
  const dz = remoteState.z - p.z
  const dy = remoteState.y - p.y
  const dist = Math.sqrt(dx * dx + dz * dz + dy * dy)

  if (dist > 8) {
    // Snap if too far (respawn, first sync, etc.)
    p.x = remoteState.x
    p.z = remoteState.z
    p.y = remoteState.y
  } else {
    const t = 1 - Math.pow(0.00001, dt)
    p.x += dx * t
    p.z += dz * t
    p.y += dy * t
  }
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
      lastNetReceive = performance.now()
      // Sync weapon viewmodel if level changed
      if (msg.weaponLevel !== player2.weaponLevel) {
        player2.weaponLevel = msg.weaponLevel
        updateViewmodelForWeapon(player2.viewmodel, WEAPONS[msg.weaponLevel])
      }
      break

    case 'shoot': {
      // Visual-only: spawn bullet from remote player
      soundManager.gunshotRemote(msg.weapon)
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
      soundManager.takeDamage()
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
        soundManager.death()
        setKillfeed('Ennemi', P2_COLOR, 'Vous', P1_COLOR, WEAPONS[msg.weaponLevel].name, false)
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
      soundManager.kill()
      setKillfeed('Vous', P1_COLOR, 'Ennemi', P2_COLOR, WEAPONS[player1.weaponLevel].name, false)
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
        soundManager.weaponSwitch()
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

    case 'customize': {
      // Remote sent their avatar config — rebuild player2 with it
      p2Config = { ...DEFAULT_P2_CONFIG, ...msg.config }
      rebuildAvatar(player2, p2Config, 2)
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

// =============================================================
//  CUSTOMIZATION PANEL
// =============================================================
const customizePanel = document.getElementById('customize-panel')!
const btnCustomize = document.getElementById('btn-customize')!
const btnCustomizeClose = document.getElementById('btn-customize-close')!
const previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement

// Preview renderer
const prevRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, alpha: true, antialias: true })
prevRenderer.setSize(280, 420)
prevRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

const prevScene = new THREE.Scene()
prevScene.add(new THREE.AmbientLight(0xffffff, 0.5))
const prevDirLight = new THREE.DirectionalLight(0xffeedd, 1.0)
prevDirLight.position.set(3, 5, 4)
prevScene.add(prevDirLight)

const prevCamera = new THREE.PerspectiveCamera(45, 280 / 420, 0.1, 50)
prevCamera.position.set(0, 1.2, 3.2)
prevCamera.lookAt(0, 1.0, 0)

let previewAvatar: THREE.Group | null = null
let previewOpen = false
let previewRafId = 0

function buildPreviewAvatar() {
  if (previewAvatar) {
    previewAvatar.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material
        if (mat instanceof THREE.MeshStandardMaterial) originalColors.delete(mat)
      }
    })
    prevScene.remove(previewAvatar)
  }
  previewAvatar = createAvatar(p1Config, 0, prevScene)
}

function previewLoop() {
  if (!previewOpen) return
  previewRafId = requestAnimationFrame(previewLoop)
  if (previewAvatar) previewAvatar.rotation.y += 0.01
  prevRenderer.render(prevScene, prevCamera)
}

function openCustomizePanel() {
  customizePanel.classList.remove('hidden')
  previewOpen = true
  buildPreviewAvatar()
  updateCustomizeUI()
  previewLoop()
}

function closeCustomizePanel() {
  customizePanel.classList.add('hidden')
  previewOpen = false
  cancelAnimationFrame(previewRafId)
  saveAvatarConfig(p1Config)
}

btnCustomize.addEventListener('click', openCustomizePanel)
btnCustomizeClose.addEventListener('click', closeCustomizePanel)

// Color presets
const SKIN_COLORS = [
  { color: 0x4a3a2a, label: 'Sombre' },
  { color: 0x8d6e4a, label: 'Brun' },
  { color: 0x6b4a3a, label: 'Rouille' },
  { color: 0x2d1f14, label: 'Ebene' },
  { color: 0x7a8a5a, label: 'Zombie' },
  { color: 0x5a4a6a, label: 'Violet' },
  { color: 0x8a3a3a, label: 'Sang' },
  { color: 0x4a5a6a, label: 'Gris' },
]

const EYE_COLORS = [
  { color: 0xff1100, label: 'Rouge' },
  { color: 0x00ff44, label: 'Vert' },
  { color: 0x4488ff, label: 'Bleu' },
  { color: 0xff00ff, label: 'Violet' },
  { color: 0xffaa00, label: 'Orange' },
  { color: 0xffffff, label: 'Blanc' },
]

const BODY_COLORS = [
  { color: 0x3498db, label: 'Bleu' },
  { color: 0xe74c3c, label: 'Rouge' },
  { color: 0x2ecc71, label: 'Vert' },
  { color: 0xf39c12, label: 'Or' },
  { color: 0x9b59b6, label: 'Violet' },
  { color: 0x1abc9c, label: 'Turquoise' },
  { color: 0xe67e22, label: 'Orange' },
  { color: 0x2c3e50, label: 'Sombre' },
]

const FACE_PATTERNS: { value: FacePattern; label: string }[] = [
  { value: 'none', label: 'Aucun' },
  { value: 'warpaint', label: 'Peinture' },
  { value: 'scars', label: 'Cicatrices' },
  { value: 'tribal', label: 'Tribal' },
  { value: 'kabuki', label: 'Kabuki' },
  { value: 'skull', label: 'Crane' },
]

const HORN_STYLES: { value: HornStyle; label: string }[] = [
  { value: 'none', label: 'Aucune' },
  { value: 'short', label: 'Courtes' },
  { value: 'long', label: 'Longues' },
  { value: 'curved', label: 'Courbees' },
  { value: 'oni', label: 'Oni' },
]

const HAT_STYLES: { value: HatStyle; label: string }[] = [
  { value: 'none', label: 'Aucune' },
  { value: 'kabuto', label: 'Kabuto' },
  { value: 'straw', label: 'Paille' },
  { value: 'bandana', label: 'Bandana' },
  { value: 'oni-mask', label: 'Masque Oni' },
  { value: 'crown', label: 'Couronne' },
]

// Build panel contents
function hexToCSS(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0')
}

function populateColorPanel(panelId: string, colors: { color: number; label: string }[], key: 'skinColor' | 'bodyColor' | 'eyeColor') {
  const panel = document.getElementById(panelId)!
  panel.innerHTML = ''
  for (const c of colors) {
    const swatch = document.createElement('div')
    swatch.className = 'color-swatch'
    swatch.style.background = hexToCSS(c.color)
    swatch.title = c.label
    if (p1Config[key] === c.color) swatch.classList.add('selected')
    swatch.addEventListener('click', () => {
      p1Config[key] = c.color
      panel.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'))
      swatch.classList.add('selected')
      buildPreviewAvatar()
    })
    panel.appendChild(swatch)
  }
}

function populateItemPanel(panelId: string, items: { value: string; label: string }[], key: 'facePattern' | 'hornStyle' | 'hat') {
  const panel = document.getElementById(panelId)!
  panel.innerHTML = ''
  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'item-btn'
    btn.textContent = item.label
    if (p1Config[key] === item.value) btn.classList.add('selected')
    btn.addEventListener('click', () => {
      (p1Config as unknown as Record<string, string>)[key] = item.value
      panel.querySelectorAll('.item-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
      buildPreviewAvatar()
    })
    panel.appendChild(btn)
  }
}

function updateCustomizeUI() {
  populateColorPanel('tp-skin', SKIN_COLORS, 'skinColor')
  populateColorPanel('tp-eyes', EYE_COLORS, 'eyeColor')
  populateColorPanel('tp-body', BODY_COLORS, 'bodyColor')
  populateItemPanel('tp-face', FACE_PATTERNS, 'facePattern')
  populateItemPanel('tp-horns', HORN_STYLES, 'hornStyle')
  populateItemPanel('tp-hat', HAT_STYLES, 'hat')
}

// Tab switching
document.querySelectorAll('.ctab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    tab.classList.add('active')
    const tabId = (tab as HTMLElement).dataset.tab!
    document.getElementById(`tp-${tabId}`)!.classList.add('active')
  })
})

function applyMapTheme(theme: MapTheme) {
  if (theme === 'light') {
    scene.background = new THREE.Color(0x87CEEB)
    scene.fog = new THREE.Fog(0x87CEEB, 40, 120)
    ambientLight.color.setHex(0xffffff)
    ambientLight.intensity = 0.6
    sunLight.intensity = 1.2
    flashlight.intensity = 0
    for (const pl of flickerLights) pl.intensity = 0.05
  } else {
    scene.background = new THREE.Color(0x050510)
    scene.fog = new THREE.Fog(0x050510, 12, 45)
    ambientLight.color.setHex(0x1a1a3a)
    ambientLight.intensity = 0.15
    sunLight.intensity = 0
    flashlight.intensity = 4
    for (const pl of flickerLights) pl.intensity = 0.4
  }
}

const btnMapDark = document.getElementById('btn-map-dark')!
const btnMapLight = document.getElementById('btn-map-light')!

function updateMapButtons() {
  btnMapDark.classList.toggle('selected', selectedMap === 'dark')
  btnMapLight.classList.toggle('selected', selectedMap === 'light')
}

btnMapDark.addEventListener('click', () => { selectedMap = 'dark'; updateMapButtons() })
btnMapLight.addEventListener('click', () => { selectedMap = 'light'; updateMapButtons() })

function startGame(mode: GameMode) {
  isMultiplayer = mode !== 'solo'
  gameStarted = true

  // Reset ALL game state
  gamePaused = false
  gameOver = false
  killCamActive = false
  killCamTimer = 0
  killCamKiller = null
  killCamVictim = null
  mouseDown = false
  isADS = false
  for (const k in keys) keys[k] = false
  pauseMenu.classList.remove('visible')

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

  applyMapTheme(selectedMap)

  // Apply avatar configs
  p1Config = loadAvatarConfig()
  rebuildAvatar(player1, p1Config, 1)
  rebuildAvatar(player2, p2Config, 2)

  // Send config to remote
  if (isMultiplayer) {
    sendNet({ type: 'customize', config: p1Config })
  }

  // Reset spawn
  const s1 = randomSpawn()
  player1.x = s1.x; player1.z = s1.z; player1.angle = s1.angle
  const s2 = randomSpawn(player1)
  player2.x = s2.x; player2.z = s2.z; player2.angle = s2.angle

  // Blur any focused button then auto-request pointer lock
  ;(document.activeElement as HTMLElement)?.blur()
  clock.getDelta() // reset clock
  soundManager.startAmbience()
  if (!animating) { animating = true; animate() }
  setTimeout(() => renderer.domElement.requestPointerLock(), 100)
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

    const timeout = setTimeout(() => {
      lobbyStatus.textContent = 'Room introuvable ou expirée'
      btnConnect.textContent = 'Connecter'
      conn?.close()
      conn = null
      peer?.destroy()
      peer = null
    }, 10000)

    conn.on('open', () => {
      clearTimeout(timeout)
      setupConnection()
      startGame('guest')
    })

    conn.on('error', (err: Error) => {
      clearTimeout(timeout)
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

btnSolo.addEventListener('click', () => { soundManager.uiClick(); startGame('solo') })
btnCreate.addEventListener('click', () => { soundManager.uiClick(); createRoom() })
btnJoin.addEventListener('click', () => {
  soundManager.uiClick()
  joinForm.style.display = 'flex'
  roomInput.focus()
})
btnConnect.addEventListener('click', () => {
  soundManager.uiClick()
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

  // Flicker lanterns
  for (let i = 0; i < flickerLights.length; i++) {
    const fl = flickerLights[i]
    const flicker = Math.random()
    if (flicker < 0.03) {
      fl.intensity = 0
    } else {
      fl.intensity = 0.2 + Math.sin(t * 3 + i * 2.5) * 0.15 + Math.random() * 0.08
    }
    const bulb = flickerBulbs[i]
    if (bulb) {
      const mat = bulb.material as THREE.Material
      if ('opacity' in mat) {
        (mat as THREE.MeshStandardMaterial).opacity = flicker < 0.03 ? 0.3 : 0.6 + Math.sin(t * 3 + i * 2.5) * 0.25
      }
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
