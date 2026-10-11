import { describe, expect, it } from 'vitest';
import { PhoneAgent } from '../src/agents/phoneAgent';
import { isDistress } from '../src/audio/soundLabels';

const groups = (o: Partial<Record<string, number>>) => ({ thud: 0, glass: 0, distress: 0, speech: 0, media: 0, tap: 0, object: 0, footsteps: 0, silence: 0, ...o }) as Parameters<typeof isDistress>[0];

describe('talking is not screaming', () => {
  it('a loud phone call does not raise a scream', () => {
    const triggers: string[] = [];
    const a = new PhoneAgent('n1', 'Phone 1', (k) => triggers.push(k));
    a.onSound({ t: 1000, cls: 'scream', confidence: 0.75, aboveFloorDb: 26, repetitive: false, ai: { group: 'speech', score: 0.8 } });
    expect(triggers).toEqual([]);
  });
  it('a real scream still does', () => {
    const triggers: string[] = [];
    const a = new PhoneAgent('n1', 'Phone 1', (k) => triggers.push(k));
    a.onSound({ t: 1000, cls: 'scream', confidence: 0.75, aboveFloorDb: 26, repetitive: false, ai: { group: 'distress', score: 0.7 } });
    expect(triggers).toEqual(['scream']);
  });
  it('shouting and animated talk are not distress; screaming or crying over the talking is', () => {
    expect(isDistress(groups({ speech: 0.8, distress: 0.4 }))).toBe(false);
    expect(isDistress(groups({ speech: 0.7, distress: 0.6 }))).toBe(false);
    expect(isDistress(groups({ speech: 0.3, distress: 0.7 }))).toBe(true);
  });
});

import { noDeal } from '../src/agents/negotiation';
describe('no agreement is not forced', () => {
  it('a deadlock asks the person, never a silent compromise', () => {
    expect(noDeal([{ action: 'call' }, { action: 'none' }, { action: 'ask', callIfNoMovementS: 30 }])).toEqual({ action: 'urgent', callIfNoMovementS: 30 });
    expect(noDeal([{ action: 'ask' }, { action: 'none' }, { action: 'watch' }])).toEqual({ action: 'ask', callIfNoMovementS: null });
    expect(noDeal([{ action: 'watch' }, { action: 'none' }, { action: 'none' }]).action).toBe('watch');
  });
});

import { agreed, nearAgreement } from '../src/agents/negotiation';
describe('agreement is decided on the structured plan', () => {
  it('same action with different conditions is a deal; the most careful condition wins', () => {
    expect(agreed([{ action: 'ask', callIfNoMovementS: 40 }, { action: 'ask', callIfNoMovementS: 25 }, { action: 'ask' }])).toEqual({ action: 'ask', callIfNoMovementS: 25 });
  });
  it('after the last round, "ask" and "countdown" both mean ask the person: the more careful one is used', () => {
    expect(nearAgreement([{ action: 'ask' }, { action: 'urgent' }, { action: 'ask' }])?.action).toBe('urgent');
    expect(nearAgreement([{ action: 'none' }, { action: 'urgent' }, { action: 'ask' }])).toBeNull();
  });
});
