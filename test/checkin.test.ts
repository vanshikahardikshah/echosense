import { describe, expect, it } from 'vitest';
import type { AiFrame, SoundGroup } from '../src/audio/soundLabels';
import { FusionEngine, type FusionAlert } from '../src/fusion/fusion';

const groups = (g: Partial<Record<SoundGroup, number>>): Record<SoundGroup, number> => ({
  thud: 0, glass: 0, distress: 0, speech: 0, media: 0, tap: 0, object: 0, footsteps: 0, silence: 0, ...g,
});
const frame = (t: number, g: Partial<Record<SoundGroup, number>>, name = 'x'): AiFrame => ({ t, groups: groups(g), top: [{ name, score: 0.8 }] });

function pending(): { f: FusionEngine; alerts: FusionAlert[] } {
  const alerts: FusionAlert[] = [];
  const f = new FusionEngine({}, (a) => alerts.push(a));
  f.onAi(frame(1, { silence: 0.9 }));
  f.requestCheckIn(2, 'test');
  f.prompted(2);
  return { f, alerts };
}

describe('hands free check-in', () => {
  it('counts someone answering out loud as OK', () => {
    const { f, alerts } = pending();
    f.onAi(frame(9, { speech: 0.85 }, 'Speech'));
    expect(alerts.some((a) => a.kind === 'resolved' && a.title.includes('answered out loud'))).toBe(true);
  });
  it('does not take the TV talking as an answer', () => {
    const { f, alerts } = pending();
    for (let t = 3; t < 12; t += 0.5) f.onAi(frame(t, { speech: 0.7, media: 0.6 }, 'Television'));
    expect(alerts.some((a) => a.kind === 'resolved')).toBe(false);
  });
  it('treats a groan or crying as a call for help', () => {
    const { f, alerts } = pending();
    f.onAi(frame(9, { distress: 0.7 }, 'Groan'));
    expect(alerts.some((a) => a.kind === 'escalation' && a.title === 'Help requested')).toBe(true);
  });
  it('ignores what the phone hears of itself while it speaks', () => {
    const { f, alerts } = pending();
    f.muteUntil(8);
    f.onAi(frame(7, { speech: 0.9 }, 'Speech'));
    expect(alerts.some((a) => a.kind === 'resolved')).toBe(false);
  });
  it('labels a finger snap as harmless instead of an impact', () => {
    const alerts: FusionAlert[] = [];
    const f = new FusionEngine({}, (a) => alerts.push(a));
    f.onAi(frame(1, { silence: 0.9 }));
    f.onSound({ t: 5, cls: 'impact', confidence: 0.8, aboveFloorDb: 24, peakDb: -20, duration: 0.1, repetitive: false, evidence: 'snap' });
    f.onAi(frame(5.9, { tap: 0.82 }, 'Finger snapping'));
    expect(alerts.some((a) => a.kind === 'sound' && a.title.includes('tap or snap'))).toBe(true);
    expect(alerts.some((a) => a.kind === 'impact')).toBe(false);
  });
});
