import type { BoardMsg } from '../agents/types';
import type { SoundEvent } from '../audio/passive';
import type { FusionAlert } from '../fusion/fusion';

/** Messages exchanged between phones (nodes), the hub server and consoles. */

export interface NodeInfo {
  nodeId: string;
  name: string;
  device: string;
  bandIndex: number;
  bandCount: number;
  connectedAt: number;
  lastSeen: number;
  sim: boolean;
  /** False for a few seconds after a phone drops off (screen locked, network blip). */
  online?: boolean;
}

export interface Telemetry {
  nodeId: string;
  t: number;
  status: string;
  headline: string;
  subline: string;
  presence: string;
  mode: 'room' | 'body';
  range: number | null;
  velocity: number;
  snrDb: number;
  confirmed: boolean;
  breathing: { rateBpm: number; quality: number; range: number } | null;
  linkSnrDb: number;
  motionDb: number;
  fastMotionDb: number;
  /** Change of the static room echo, dB (large when the phone itself moves). */
  staticChangeDb?: number;
  /** Sonar running (not calibrating, paused or lost). */
  sonarOk?: boolean;
  /** What the sound model heard recently: share of TV or music, share of talking (0..1). */
  scene?: { media: number; speech: number; label: string };
  /** Echogram row: clutter-removed SNR in dB per range cell (0..maxRange). */
  echo: number[];
  maxRange: number;
  band: [number, number];
  sim: boolean;
  checkIn: { state: string; deadline: number; startedAt: number; reason: string } | null;
}

export type ClientMsg =
  | { type: 'hello'; role: 'node' | 'console'; name: string; device: string; nodeId?: string; sim?: boolean }
  | { type: 'telemetry'; telemetry: Telemetry }
  | { type: 'event'; nodeId: string; alert: FusionAlert }
  | { type: 'respond'; nodeId: string; answer: 'ok' | 'help' }
  | { type: 'ping'; t: number }
  | { type: 'sound'; sound: SoundEvent }
  /** A spoken answer to "Are you OK?": 16 kHz mono PCM16, base64. Only sent while a check-in is open. */
  | { type: 'answer_audio'; pcm: string; urgent?: boolean; levelDb?: number }
  | { type: 'council'; action: 'run_scenario'; key: string; seed?: number }
  | { type: 'council'; action: 'compromise'; nodeId: string; on: boolean }
  | { type: 'council'; action: 'inject_fake'; nodeId: string }
  | { type: 'council'; action: 'human'; incidentId: string; answer: 'ok' | 'help' }
  | { type: 'council'; action: 'eval' }
  | { type: 'council'; action: 'sim_calls'; on: boolean }
  | { type: 'council'; action: 'test_call' }
  | { type: 'council'; action: 'llm_mode'; mode: 'off' | 'narrate' | 'reason' | 'agent' }
  | { type: 'council'; action: 'mark_place'; name: string; kind: import('../agents/cartographer').PlaceKind }
  | { type: 'council'; action: 'remove_place'; id: string }
  | { type: 'council'; action: 'test_ask' }
  | { type: 'council'; action: 'test_webex' }
  | { type: 'council'; action: 'label_incident'; incidentId: string; label: 'fall' | 'not_fall'; subtype: string; location: string; heldOut: boolean }
  | { type: 'council'; action: 'label_phone'; nodeId: string; label: string; near?: import('../agents/cartographer').PlaceKind };

export interface EvalRow {
  title: string;
  emergency: boolean;
  heldOut: boolean;
  cells: string[];
}

export type ServerMsg =
  | { type: 'welcome'; nodeId: string; bandIndex: number; bandCount: number; serverTime: number }
  | { type: 'band'; bandIndex: number; bandCount: number }
  | { type: 'nodes'; nodes: NodeInfo[] }
  | { type: 'telemetry'; telemetry: Telemetry }
  | { type: 'event'; nodeId: string; alert: FusionAlert; name: string }
  | { type: 'respond'; answer: 'ok' | 'help' }
  | { type: 'history'; events: { nodeId: string; alert: FusionAlert; name: string }[] }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'board'; msg: BoardMsg; from?: string }
  | { type: 'board_history'; msgs: BoardMsg[] }
  | { type: 'council_status'; status: Record<string, unknown> }
  | { type: 'eval'; rows: EvalRow[]; totals: string[]; trials: number }
  | { type: 'ask'; incidentId: string; reason: string; urgent?: boolean; seconds?: number }
  /** What the hub understood of a spoken answer. */
  | { type: 'heard'; answer: 'ok' | 'help' | 'unclear'; transcript: string; by: string }
  /** What the hub can do for the phones (speech understanding needs the speech model). */
  | { type: 'caps'; stt: boolean }
  | { type: 'notice'; text: string }
  | { type: 'map_result'; ok: boolean; detail: string };
