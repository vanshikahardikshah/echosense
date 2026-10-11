import type { LlmConfig } from './llm';

/**
 * What did the person mean when they answered "Are you OK?"
 *
 * Two readers, and help always wins:
 *   - keyword rules that never need the network (they catch "help", "hurt",
 *     "not OK", "can't get up", a bare "no"),
 *   - Claude, which reads the transcript the way a person would ("I think I
 *     broke something", "my hip", "yeah yeah I'm fine, just dropped a pan").
 * If either reader hears a call for help, it is help. "OK" needs at least one
 * reader to be sure and the other not to object. Anything else is unclear and
 * the phone asks again.
 */

export type Answer = 'ok' | 'help' | 'unclear';

export interface Understood {
  answer: Answer;
  /** Anything they said about being hurt, in their words (for the caregiver). */
  injury: string | null;
  by: string;
}

/** Help in so many words: counts however long they talk. */
const STRONG_HELP =
  /\bhelp me\b|\bi('?m| am) (hurt|bleeding|stuck|on the floor|in pain|not ok|not okay|not alright|not all right|not fine|not good|not well)\b|\bi (fell|fall|have fallen|'ve fallen)\b|\bi can'?t (get up|stand|breathe|move|walk)\b|\bi cannot (get up|stand|breathe|move|walk)\b|\bcall (an? )?ambulance\b|\b911\b|\bnine one one\b|\bhelp help\b/;
/** Words that mean help in a short direct answer, but are ordinary in a long conversation ("I'll call the doctor"). */
const WEAK_HELP = [
  /\bhelp\b/,
  /\bhurts?\b|\bhurting\b|\bpain\b|\bpainful\b|\bache\b|\binjur/,
  /\bbleed|\bblood\b/,
  /\bfell\b|\bfallen\b/,
  /\bcan'?t (get up|stand|move|breathe|walk)\b|\bcannot (get up|stand|move|breathe|walk)\b/,
  /\bambulance\b|\bemergency\b|\bdoctor\b|\bhospital\b/,
  /\bcall (someone|somebody|my)\b/,
  /\bbroke(n)?\b|\bdizzy\b|\bchest\b|\bfaint/,
  /\bnot (ok|okay|fine|alright|all right|good|well)\b/,
];
/** "I'm OK" said about themselves. */
const STRONG_OK =
  /\bi('?m| am) (ok|okay|fine|alright|all right|good|great|doing (ok|okay|fine|good|alright))\b|\ball good\b|\beverything('?s| is) (ok|okay|fine|alright|all right)\b|\bfalse alarm\b|\bi('?m| am) (totally |perfectly |completely )?(ok|okay|fine|alright)\b/;
/** A whole answer of a few words: "yes", "okay", "fine, thanks". */
const SHORT_OK = /^(yes|yeah|yep|yup|ok|okay|fine|good|alright|all right)( (yes|yeah|i'?m|i am|fine|ok|okay|good|thanks|thank you))*$/;
const BARE_NO = /^(no+|nope|nah)( (no+|nope))*$/;

/**
 * Strict on purpose. A phone call or the TV is full of "okay", "help" and
 * "doctor"; only a direct answer counts. Long talk without "I'm OK" or a
 * clear cry for help is not an answer, and the phone asks again.
 */
/**
 * The phone's own question can leak into the start of the recording ("...or
 * say help. I am okay."). Everything up to the last piece of one of our
 * prompts is dropped, so only what the person said after it is read.
 */
const PROMPT_ECHO = [
  /\bsay (i'?m|i am) (ok|okay),? or say help\b/g,
  /\b(ok|okay|k),? or say help\b/g,
  /\bor say help\b/g,
  /\bsay help\b/g,
  /\bare you (ok|okay)\b/g,
  /\bit looks like you may have fallen\b/g,
  /\botherwise i will call (for help|your family)\b/g,
  /\bi will call (for help|your family)\b/g,
  /\bi'?m about to call for help\b/g,
  /\bsay (i'?m|i am) (ok|okay) if you are (ok|okay)\b/g,
  /\bif you are (ok|okay),? say (i'?m|i am) (ok|okay)\b/g,
  /\bplease answer\b/g,
  /\bif i don'?t hear from you\b/g,
  /\bsorry,? i didn'?t catch that\b/g,
];
export function stripPromptEcho(raw: string): string {
  let t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let cut = -1;
  for (const re of PROMPT_ECHO) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) cut = Math.max(cut, m.index + m[0].length);
  }
  if (cut >= 0) t = t.slice(cut).trim();
  return t;
}

export function ruleIntent(raw: string): Understood {
  raw = stripPromptEcho(raw);
  const t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t ? t.split(' ').length : 0;
  const m = /\b(my|the) (\w+ )?(hip|head|leg|arm|back|wrist|knee|ankle|shoulder|neck|chest|hand|foot)\b/.exec(t);
  const injury = m ? m[0] : null;
  if (!words) return { answer: 'unclear', injury: null, by: 'rules' };
  if (STRONG_HELP.test(t)) return { answer: 'help', injury, by: 'rules' };
  // A bare "no" could mean "no, I'm not OK" or "no, I don't need help": ask again, never call on it alone.
  if (BARE_NO.test(t)) return { answer: 'unclear', injury, by: 'rules' };
  const direct = words <= 12;
  if (words <= 7 && WEAK_HELP.some((r) => r.test(t))) return { answer: 'help', injury, by: 'rules' };
  if (direct && (STRONG_OK.test(t) || SHORT_OK.test(t))) return { answer: 'ok', injury: null, by: 'rules' };
  // "No, I'm fine" is OK (above); "no" plus anything unclear is still ambiguous.
  return { answer: 'unclear', injury, by: 'rules' };
}

/**
 * Rules first. Claude is asked only when the rules are unsure and the answer
 * is short, and it can only find a call for help (and what hurts), never an
 * "I'm OK": a false OK is the one mistake that leaves someone on the floor.
 */
export async function understand(transcript: string, cfg: LlmConfig | null, urgent: boolean, spend?: (u: { input_tokens: number; output_tokens: number }) => boolean): Promise<Understood> {
  transcript = stripPromptEcho(transcript);
  const rules = ruleIntent(transcript);
  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  if (rules.answer !== 'unclear' || !cfg?.apiKey || cfg.mode === 'off' || words === 0 || words > 25) return rules;
  if (spend && !spend({ input_tokens: 0, output_tokens: 0 })) return rules;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 60,
        system:
          'An older person was asked "Are you OK?" by their home safety system' +
          (urgent ? ' because it thinks they may have fallen' : '') +
          '. This is what speech recognition heard (may contain errors, may be someone else talking, a phone call or the TV). Does it say they are hurt or need help? Reply with JSON only: {"help":true|false,"injury":"what hurts in their words, or null"}',
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { content: { text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    if (body.usage) spend?.(body.usage);
    const mm = body.content.map((c) => c.text ?? '').join('').match(/\{[\s\S]*\}/);
    const out = mm ? (JSON.parse(mm[0]) as { help?: boolean; injury?: string | null }) : {};
    const injury = typeof out.injury === 'string' && out.injury && out.injury !== 'null' ? out.injury : rules.injury;
    if (out.help === true) return { answer: 'help', injury, by: 'Claude' };
    return { answer: 'unclear', injury, by: 'rules and Claude' };
  } catch {
    return rules;
  } finally {
    clearTimeout(timer);
  }
}

/** "I'm hurt", "help me", "I fell", "I can't get up": a cry for help in so many words, after removing any echo of our prompts. */
export function saysHelpOutright(raw: string): boolean {
  return STRONG_HELP.test(stripPromptEcho(raw));
}
