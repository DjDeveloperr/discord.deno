import { secretbox } from '../../deps.ts'
import { Guild } from '../structures/guild.ts'
import {
  VoiceChannel,
  VoiceServerData
} from '../structures/guildVoiceChannel.ts'
import { User } from '../structures/user.ts'
import { VoiceCloseCodes, VoiceOpcodes } from '../types/voice.ts'
import { Collection } from '../utils/collection.ts'
import { HarmonyEventEmitter } from '../utils/events.ts'
import { Client } from './client.ts'

const u16max = 2 ** 16
const u32max = 2 ** 32
const frameDuration = 20
const samplingRate = 48000
let frame = new Uint8Array(28 + 3 * 1276)
const frameSize = (samplingRate * frameDuration) / 1000

frame[0] = 0x80
frame[1] = 0x78
frame = frame.slice()

const key = new Uint8Array(secretbox.key_length)
const frameView = new DataView(frame.buffer)
const nonce = new Uint8Array(secretbox.nonce_length)

export interface VoiceOptions {
  channel: VoiceChannel
  data: VoiceServerData
}

export class VoiceConnectionsManager {
  client: Client
  connections: Collection<string, VoiceConnection> = new Collection()

  constructor(client: Client) {
    this.client = client
  }

  async establish(options: VoiceOptions): Promise<VoiceConnection> {
    if (this.connections.has(options.channel.guild.id) === true)
      throw new Error('Voice Connection already established')
    const conn = new VoiceConnection(this, options)
    this.connections.set(options.channel.guild.id, conn)
    await conn.connect()
    return conn
  }
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type VoiceConnectionEvents = {
  ready: []
  resumed: []
  speaking: [user: User, speaking: boolean, ssrc: number]
  speakingUncached: [userID: string, speaking: boolean, ssrc: number]
  disconnect: []
}

/** Represents a Voice Connection made through a Voice Channel */
export class VoiceConnection extends HarmonyEventEmitter<VoiceConnectionEvents> {
  client: Client
  ws?: WebSocket
  udp?: Deno.DatagramConn
  guild: Guild
  channel: VoiceChannel
  data: VoiceServerData
  manager: VoiceConnectionsManager
  ssrc?: number
  ip?: string
  port?: number
  heartbeatInterval?: number
  heartbeatTimer?: number
  lastHeartbeatSent?: number
  lastHeartbeatAck?: number
  ping: number = 0
  #nextReconnect: boolean = false
  sequence: number = 0
  seq: number = 0
  timestamp: number = 0

  constructor(manager: VoiceConnectionsManager, options: VoiceOptions) {
    super()
    this.client = manager.client
    this.manager = manager
    this.channel = options.channel
    this.guild = options.channel.guild
    this.data = options.data
  }

  /** Connect to Voice Server */
  async connect(): Promise<VoiceConnection> {
    this.ws = new WebSocket(`wss://${this.data.endpoint}/?v=4`)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onopen = this.onopen.bind(this)
    this.ws.onclose = this.onclose.bind(this)
    this.ws.onmessage = this.onmessage.bind(this)
    this.ws.onerror = this.onerror.bind(this)
    console.log('[Voice::WSConnect]', this.ws, this.data.endpoint)
    return this
  }

  async reconnect(): Promise<VoiceConnection> {
    this.stopHeartbeat()
    this.#nextReconnect = true
    await this.connect()
    return this
  }

  private sendIdentify(): void {
    console.log('[Voice::SendIdentify]')
    this.send({
      op: VoiceOpcodes.IDENTIFY,
      d: {
        server_id: this.guild.id,
        user_id: this.client.user?.id,
        session_id: this.data.sessionID,
        token: this.data.token
      }
    })
  }

  private sendResume(): void {
    console.log('[Voice::SendResume]')
    this.send({
      op: VoiceOpcodes.RESUME,
      d: {
        server_id: this.guild.id,
        session_id: this.data.sessionID,
        token: this.data.token
      }
    })
  }

  private onopen(): void {
    console.log('[Voice::WSOpen]')
    if (this.#nextReconnect) {
      this.#nextReconnect = false
      this.sendResume()
    } else this.sendIdentify()
  }

  private onclose(evt: CloseEvent): void {
    console.log('[Voice::WSClose]', evt.code, evt.reason)
    this.stopHeartbeat()

    switch (evt.code) {
      case VoiceCloseCodes.DISCONNECTED:
        this.disconnect()
        break

      default:
        this.disconnect()
        break
    }
  }

  private async onmessage(e: MessageEvent): Promise<void> {
    const data = JSON.parse(e.data)
    if (typeof data !== 'object') return

    console.log('[Voice::WSMessage]', data)

    switch (data.op) {
      case VoiceOpcodes.READY:
        this.ssrc = data.d.ssrc
        this.ip = data.d.ip
        this.port = data.d.port
        this.emit('ready')
        this.udp = Deno.listenDatagram({
          port: this.port!,
          hostname: this.ip,
          transport: 'udp'
        })
        break

      case VoiceOpcodes.RESUMED:
        this.emit('resumed')
        break

      case VoiceOpcodes.SPEAKING:
        const user = await this.client.users.get(data.d.user_id)
        if (user === undefined)
          this.emit(
            'speakingUncached',
            data.d.user_id,
            data.d.speaking == 1,
            data.d.ssrc
          )
        else this.emit('speaking', user, data.d.speaking == 1, data.d.ssrc)
        break

      case VoiceOpcodes.HELLO:
        this.heartbeatInterval = data.d.heartbeat_interval
        this.beginHeartbeat()
        break

      case VoiceOpcodes.HEARTBEAT_ACK:
        this.lastHeartbeatAck = Date.now()
        if (
          this.lastHeartbeatAck !== undefined &&
          this.lastHeartbeatSent !== undefined
        ) {
          this.ping = this.lastHeartbeatAck - this.lastHeartbeatSent
          console.log('[Voice::Ping]', this.ping, 'ms')
        }
        break

      default:
        break
    }
  }

  private onerror(evt: ErrorEvent | Event): void {
    console.log('[Voice::WSError]', evt)
    this.reconnect()
  }

  send(data: { op: VoiceOpcodes; d: any }): void {
    console.log('[Voice::WSSend]', data)
    this.ws?.send(JSON.stringify(data))
  }

  private sendHeartbeat(): void {
    this.lastHeartbeatSent = Date.now()
    this.send({
      op: VoiceOpcodes.HEARTBEAT,
      d: Date.now()
    })
  }

  private beginHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) this.stopHeartbeat()

    this.sendHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, this.heartbeatInterval)
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private close(code: number = 1000, reason?: string): void {
    this.ws?.close(code, reason)
  }

  disconnect() {
    this.stopHeartbeat()
    if (
      this.ws?.readyState !== this.ws?.CLOSED &&
      this.ws?.readyState !== this.ws?.CLOSING
    )
      this.close()

    this.emit('disconnect')
    this.manager.connections.delete(this.channel.guild.id)
  }

  async sendVoice(opus: any): Promise<number | undefined> {
    if (u16max <= ++this.sequence) this.sequence -= u16max
    if (u32max <= (this.timestamp += frameSize)) this.timestamp %= u32max

    frameView.setUint16(2, this.seq, false)
    frameView.setUint32(4, this.timestamp, false)

    nonce.set(frame.subarray(0, 12))
    const sealed = secretbox.seal(opus, key, nonce)

    frame.set(sealed, 12)

    return this.udp?.send(frame.subarray(0, 12 + sealed.length), {
      port: this.port!,
      hostname: this.ip!,
      transport: 'udp'
    })
  }
}
